import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView, Decoration } from '@tiptap/pm/view';
import type { ViewMutationRecord } from '@tiptap/pm/view';
import { NodeSelection } from '@tiptap/pm/state';
import { Node, InputRule, mergeAttributes, type JSONContent } from '@tiptap/core';
import { assetUrl, decodeStorageKey, isVideoUrl } from '@features/editor/extensions/attachment-link/utils';
import type { EditorImageContext } from '@features/editor/editor-image-source';
import { resolveDocumentRelativeHref } from '@/lib/document-relative-path';
import { markdownAssetHref } from '@/lib/asset-markdown';
import { escapeMarkdownLinkLabel } from '@features/editor/extensions/shared/markdown-link-destination';
import { renderFlowixMediaStyleComment } from '@features/editor/extensions/attachment-link/markdown/media-style';
import { normalizeVideoAlignment, videoMarkdownSpec } from '@features/editor/extensions/attachment-link/markdown/video-markdown';

type VideoAttributes = Record<string, unknown> & {
    src?: unknown;
    title?: unknown;
    storageMode?: unknown;
    storageKey?: unknown;
    align?: unknown;
};

function stringAttribute(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Yield to a future idle frame; fall back to setTimeout(0) on older runtimes. */
function whenIdle(cb: () => void, timeout = 200): number {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        return window.requestIdleCallback(cb, { timeout }) as unknown as number;
    }
    return setTimeout(cb, 0) as unknown as number;
}

function cancelIdle(handle: number): void {
    if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(handle);
    } else {
        clearTimeout(handle);
    }
}

const MEDIA_SEEK_STEP_SECONDS = 10;
const MEDIA_SESSION_SEEK_ACTIONS: MediaSessionAction[] = [
    'seekbackward',
    'seekforward',
    'previoustrack',
    'nexttrack',
];

type VideoSeekDirection = 'backward' | 'forward';

function mediaKeyDirection(event: KeyboardEvent): VideoSeekDirection | null {
    const keys = [event.key, event.code];
    if (keys.some((key) => key === 'MediaTrackPrevious' || key === 'AudioTrackPrevious' || key === 'MediaRewind')) {
        return 'backward';
    }
    if (keys.some((key) => key === 'MediaTrackNext' || key === 'AudioTrackNext' || key === 'MediaFastForward')) {
        return 'forward';
    }
    return null;
}

// ─── VideoView ───────────────────────────────────────────────────────────────

class VideoView implements ProseMirrorNodeView {
    dom: HTMLElement;
    contentDOM: HTMLElement | null = null;
    node: ProseMirrorNode;
    view: EditorView;
    getPos: (() => number) | undefined;
    decorations: readonly Decoration[];
    selected = false;

    /** Tracks the last applied source so duplicate updates don't restart the load. */
    private appliedSrc: string | null = null;
    /** Handle for a pending src-set scheduled via whenIdle. */
    private pendingLoadHandle: number | null = null;
    private mediaSession: MediaSession | null = null;
    /**
     * Native video controls may restore focus to the <video> after click
     * handlers have run (notably in WebKit). Keep the editor focus restoration
     * until that native click work has finished.
     */
    private pendingFocusHandle: number | null = null;
    /** Select the atom while leaving the native video controls usable. */
    private readonly handleClick = (event: MouseEvent): void => {
        if (event.button !== 0 || this.view.isDestroyed) return;

        const pos = this.getPos?.();
        if (pos === undefined) return;

        const { state, dispatch } = this.view;
        const selection = NodeSelection.create(state.doc, pos);
        const selectionChanged = !state.selection.eq(selection);
        if (selectionChanged) {
            dispatch(state.tr.setSelection(selection).setMeta('pointer', true));
        }

        // Once the video is already selected, the click may be on a native
        // control. Keep that control focused instead of scheduling another
        // editor-focus operation. This also cancels a first-click focus task
        // when a control is activated before the task runs.
        if (!selectionChanged) {
            if (this.pendingFocusHandle !== null) {
                window.clearTimeout(this.pendingFocusHandle);
                this.pendingFocusHandle = null;
            }
            return;
        }

        if (this.pendingFocusHandle !== null) {
            window.clearTimeout(this.pendingFocusHandle);
        }
        this.pendingFocusHandle = window.setTimeout(() => {
            this.pendingFocusHandle = null;
            if (this.view.isDestroyed) return;

            // Do not steal focus back if the user moved to another block
            // before this deferred callback ran.
            const currentSelection = this.view.state.selection;
            if (
                !(currentSelection instanceof NodeSelection) ||
                currentSelection.from !== selection.from
            ) return;

            this.view.focus();
        }, 0);
    };
    private readonly handleKeyDown = (event: KeyboardEvent): void => {
        if (!this.selected) return;

        const direction = mediaKeyDirection(event);
        if (!direction) return;

        event.preventDefault();
        this.seekBy(direction === 'backward' ? -MEDIA_SEEK_STEP_SECONDS : MEDIA_SEEK_STEP_SECONDS);
    };

    constructor(
        node: ProseMirrorNode,
        view: EditorView,
        getPos: () => number,
        decorations: readonly Decoration[],
        private readonly getImageContext?: () => EditorImageContext | undefined,
    ) {
        this.node = node;
        this.view = view;
        this.getPos = getPos;
        this.decorations = decorations;

        const { title } = node.attrs;

        const wrapper = document.createElement('div');
        wrapper.className = 'editor-video-attachment';
        wrapper.contentEditable = 'false';
        wrapper.draggable = true;

        const video = document.createElement('video');
        video.className = 'editor-video-attachment__video';
        video.controls = true;
        video.preload = 'metadata';
        if (typeof title === 'string' && title) video.title = title;
        // No poster generation, no currentTime seek: a poster would force a
        // synchronous JPEG encode + base64 string on the main thread, and the
        // seek would force the browser to download media data even though we
        // only asked for metadata. With preload=metadata the <video> shows the
        // default black surface + native controls until the user plays it,
        // which keeps setContent() fast and clickable.

        wrapper.appendChild(video);
        this.dom = wrapper;
        this.applyAlignment(node.attrs);
        wrapper.addEventListener('click', this.handleClick);
        // Listen on the editor as well as the native media surface. After a
        // video is selected, the editor normally regains focus; macOS media
        // keys may then arrive on the editor rather than the <video> element.
        view.dom.addEventListener('keydown', this.handleKeyDown);

        this.applySrc(video, node.attrs);
    }

    private seekBy(offset: number): void {
        const video = this.dom.querySelector<HTMLVideoElement>('video');
        if (!video || !Number.isFinite(video.currentTime)) return;

        const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
        try {
            video.currentTime = Math.max(0, Math.min(duration, video.currentTime + offset));
        } catch {
            // The media element may not have a seekable source yet.
        }
    }

    private applyAlignment(attrs: VideoAttributes): void {
        this.dom.dataset.videoAlign = normalizeVideoAlignment(attrs.align);
    }

    private registerMediaSession(): void {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return;

        const mediaSession = navigator.mediaSession;
        this.mediaSession = mediaSession;

        const setActionHandler = (
            action: MediaSessionAction,
            handler: MediaSessionActionHandler,
        ): void => {
            try {
                mediaSession.setActionHandler(action, handler);
            } catch {
                // WebKit exposes MediaSession but may not implement every
                // action. The keydown listener remains as a local fallback.
            }
        };

        setActionHandler('seekbackward', (details) => {
            this.seekBy(-(details.seekOffset ?? MEDIA_SEEK_STEP_SECONDS));
        });
        setActionHandler('seekforward', (details) => {
            this.seekBy(details.seekOffset ?? MEDIA_SEEK_STEP_SECONDS);
        });
        setActionHandler('previoustrack', () => {
            this.seekBy(-MEDIA_SEEK_STEP_SECONDS);
        });
        setActionHandler('nexttrack', () => {
            this.seekBy(MEDIA_SEEK_STEP_SECONDS);
        });
    }

    private unregisterMediaSession(): void {
        const mediaSession = this.mediaSession;
        if (!mediaSession) return;

        for (const action of MEDIA_SESSION_SEEK_ACTIONS) {
            try {
                mediaSession.setActionHandler(action, null);
            } catch {
                // Ignore unsupported WebKit actions during cleanup.
            }
        }
        this.mediaSession = null;
    }

    /**
     * Apply a new src to the <video>, but only if it actually changed. The actual
     * `video.src = ...` assignment is scheduled on a future idle frame so we
     * never block the current task (which is typically the editor's setContent).
     */
    private applySrc(video: HTMLVideoElement, attrs: VideoAttributes): void {
        const storageKey = stringAttribute(attrs.storageKey);
        const authoredSrc = stringAttribute(attrs.src);
        const localTarget = resolveDocumentRelativeHref(authoredSrc, this.getImageContext?.()?.documentPath);
        const nextSrc = attrs.storageMode === 'attachment' && storageKey
            ? assetUrl(storageKey)
            : localTarget && (localTarget.path.startsWith('/') || /^[a-z]:\//i.test(localTarget.path) || localTarget.path.startsWith('//'))
                ? assetUrl(localTarget.path)
                : authoredSrc;

        if (nextSrc === this.appliedSrc) return;
        this.appliedSrc = nextSrc;

        if (this.pendingLoadHandle !== null) {
            cancelIdle(this.pendingLoadHandle);
            this.pendingLoadHandle = null;
        }

        if (!nextSrc) {
            video.removeAttribute('src');
            video.classList.remove('is-loaded');
            return;
        }

        video.classList.remove('is-loaded');
        this.pendingLoadHandle = whenIdle(() => {
            this.pendingLoadHandle = null;
            if (!video.isConnected) return;                // view torn down
            if (this.appliedSrc !== nextSrc) return;
            const markLoaded = () => {
                if (this.appliedSrc === nextSrc) {
                    video.classList.add('is-loaded');
                }
            };
            video.addEventListener('loadedmetadata', markLoaded, { once: true });
            video.addEventListener('error', markLoaded, { once: true });
            video.src = nextSrc;
        });
    }

    update(node: ProseMirrorNode): boolean {
        if (node.type.name !== 'videoAttachment') return false;
        this.node = node;
        this.applyAlignment(node.attrs);

        const video = this.dom.querySelector('video');
        if (!video) return true;
        if (node.attrs.title) video.title = node.attrs.title;
        this.applySrc(video, node.attrs);
        return true;
    }

    updateAttributes(attributes: Record<string, unknown>): void {
        const video = this.dom.querySelector('video');
        if (video) {
            Object.entries(attributes).forEach(([key, value]) => {
                video.setAttribute(key, String(value));
            });
        }
    }

    selectNode(): void {
        this.selected = true;
        this.dom.classList.add('is-selected');
        this.registerMediaSession();
    }

    deselectNode(): void {
        this.selected = false;
        this.dom.classList.remove('is-selected');
        this.unregisterMediaSession();
    }

    deleteNode(): void {
        const { state, dispatch } = this.view;
        const pos = this.getPos?.();
        if (pos === undefined) return;
        const tr = state.tr.delete(pos, pos + this.node.nodeSize);
        dispatch(tr);
    }

    stopEvent(event: Event): boolean {
        const target = event.target as HTMLElement;
        return !!target.closest('.editor-video-attachment');
    }

    ignoreMutation(mutation: ViewMutationRecord): boolean {
        const target = mutation.target as HTMLElement;
        const isVideoContainer = target.closest('.editor-video-attachment');
        // Only ignore mutations within the video container; allow editor to handle everything else
        return !!isVideoContainer;
    }

    destroy(): void {
        this.dom.removeEventListener('click', this.handleClick);
        const video = this.dom.querySelector('video');
        this.view.dom.removeEventListener('keydown', this.handleKeyDown);
        this.unregisterMediaSession();
        if (this.pendingFocusHandle !== null) {
            window.clearTimeout(this.pendingFocusHandle);
            this.pendingFocusHandle = null;
        }
        if (this.pendingLoadHandle !== null) {
            cancelIdle(this.pendingLoadHandle);
            this.pendingLoadHandle = null;
        }

        if (video) {
            video.removeAttribute('src');
            video.load();
        }
    }
}

// ─── VideoAttachment Node ────────────────────────────────────────────────────

export const VideoAttachment = Node.create<{ getImageContext?: () => EditorImageContext | undefined }>({
    name: 'videoAttachment',

    addOptions() {
        return { getImageContext: undefined };
    },
    group: 'block',
    inline: false,
    atom: true,
    draggable: true,

    addAttributes() {
        return {
            src: { default: null },
            title: { default: null },
            fileName: { default: null },
            mimeType: { default: null },
            storageMode: { default: null },
            storageKey: { default: null },
            align: {
                default: 'center',
                parseHTML: (element: HTMLElement) => normalizeVideoAlignment(element.getAttribute('data-video-align')),
                renderHTML: (attributes: VideoAttributes) => {
                    const align = normalizeVideoAlignment(attributes.align);
                    return align === 'center' ? {} : { 'data-video-align': align };
                },
            },
        };
    },

    addInputRules() {
        return [
            new InputRule({
                find: /\[([^\]]+)\]\((asset:\/\/(?:[^)]|%[0-9A-Fa-f]{2})*)\)$/,
                handler: ({ state, range, match }) => {
                    const title = match[1] ?? '';
                    const src = match[2] ?? '';
                    if (!isVideoUrl(src)) return;
                    const { tr } = state;
                    const nodeType = state.schema.nodes.videoAttachment;
                    tr.replaceWith(range.from, range.to, nodeType.create({
                        src,
                        title,
                        storageMode: 'attachment',
                        storageKey: decodeStorageKey(src),
                    }));
                },
            }),
        ];
    },

    parseHTML() {
        return [
            {
                tag: 'div[data-video-attachment]',
                getAttrs: (element: unknown) => {
                    if (!(element instanceof HTMLElement)) return false;
                    const video = element.querySelector('video');
                    if (!video) return false;
                    const source = video.querySelector('source');
                    const src = source?.getAttribute('src') ?? video.getAttribute('src');
                    return {
                        src,
                        title: video.getAttribute('title'),
                        fileName: element.getAttribute('data-file-name'),
                        mimeType: element.getAttribute('data-mime-type'),
                        storageMode: element.getAttribute('data-storage-mode'),
                        storageKey: element.getAttribute('data-storage-key'),
                        align: normalizeVideoAlignment(element.getAttribute('data-video-align')),
                    };
                },
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const { storageMode, storageKey, src, fileName, mimeType, align } = HTMLAttributes;
        const videoSrc = storageMode === 'attachment' && storageKey
            ? assetUrl(String(storageKey))
            : src;
        return [
            'div',
            mergeAttributes(
                { class: 'editor-video-attachment' },
                { 'data-video-attachment': 'true' },
                fileName ? { 'data-file-name': fileName } : {},
                mimeType ? { 'data-mime-type': mimeType } : {},
                storageMode ? { 'data-storage-mode': storageMode } : {},
                storageKey ? { 'data-storage-key': storageKey } : {},
                normalizeVideoAlignment(align) !== 'center' ? { 'data-video-align': normalizeVideoAlignment(align) } : {},
            ),
            ['video', mergeAttributes(
                { class: 'editor-video-attachment__video is-loaded', controls: 'true' },
                videoSrc ? { src: videoSrc } : {}
            )],
        ];
    },

    addNodeView() {
        return (props) => new VideoView(
            props.node,
            props.view,
            () => {
                const pos = props.getPos?.();
                if (typeof pos !== 'number') {
                    throw new Error('VideoAttachment getPos unavailable');
                }
                return pos;
            },
            props.decorations,
            this.options.getImageContext,
        );
    },

    ...videoMarkdownSpec,

    renderMarkdown(node: JSONContent) {
        const { title, storageMode, storageKey, src } = node.attrs || {};
        const videoSrc = markdownAssetHref(src, storageMode, storageKey);
        const align = normalizeVideoAlignment(node.attrs?.align);
        const style = align === 'center' ? {} : { align };
        return `${renderFlowixMediaStyleComment(style)}[${escapeMarkdownLinkLabel(String(title || ''))}](${videoSrc})`;
    },
});
