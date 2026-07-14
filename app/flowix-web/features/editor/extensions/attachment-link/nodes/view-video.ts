import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView, Decoration } from '@tiptap/pm/view';
import type { ViewMutationRecord } from '@tiptap/pm/view';
import { Node, InputRule, mergeAttributes } from '@tiptap/core';
import { assetMarkdownUrl, assetUrl, decodeStorageKey, isVideoUrl } from '@features/editor/extensions/attachment-link/utils';

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

    constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number, decorations: readonly Decoration[]) {
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
        if (title) video.title = title;
        // No poster generation, no currentTime seek: a poster would force a
        // synchronous JPEG encode + base64 string on the main thread, and the
        // seek would force the browser to download media data even though we
        // only asked for metadata. With preload=metadata the <video> shows the
        // default black surface + native controls until the user plays it,
        // which keeps setContent() fast and clickable.

        wrapper.appendChild(video);
        this.dom = wrapper;

        this.applySrc(video, node.attrs as Record<string, any>);
    }

    /**
     * Apply a new src to the <video>, but only if it actually changed. The actual
     * `video.src = ...` assignment is scheduled on a future idle frame so we
     * never block the current task (which is typically the editor's setContent).
     */
    private applySrc(video: HTMLVideoElement, attrs: Record<string, any>): void {
        const nextSrc = attrs.storageMode === 'attachment' && attrs.storageKey
            ? assetUrl(attrs.storageKey)
            : (attrs.src ?? '');

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

        const video = this.dom.querySelector('video');
        if (!video) return true;
        if (node.attrs.title) video.title = node.attrs.title;
        this.applySrc(video, node.attrs as Record<string, any>);
        return true;
    }

    updateAttributes(attributes: Record<string, any>): void {
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
    }

    deselectNode(): void {
        this.selected = false;
        this.dom.classList.remove('is-selected');
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
        if (this.pendingLoadHandle !== null) {
            cancelIdle(this.pendingLoadHandle);
            this.pendingLoadHandle = null;
        }

        const video = this.dom.querySelector('video');
        if (video) {
            video.removeAttribute('src');
            video.load();
        }
    }
}

// ─── VideoAttachment Node ────────────────────────────────────────────────────

export const VideoAttachment = Node.create({
    name: 'videoAttachment',
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
                    };
                },
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const { storageMode, storageKey, src, fileName, mimeType } = HTMLAttributes;
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
                storageKey ? { 'data-storage-key': storageKey } : {}
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
            props.decorations
        );
    },

    markdownTokenizer: {
        name: 'videoAttachment',
        level: 'block' as const,
        start(src: string) {
            let pos = 0;
            while (pos < src.length) {
                const openBracket = src.indexOf('[', pos);
                if (openBracket === -1) return -1;

                const closeBracket = src.indexOf(']', openBracket);
                const openParen = src.indexOf('(', openBracket);

                if (closeBracket === -1 || openParen === -1) {
                    pos = openBracket + 1;
                    continue;
                }

                // Must be adjacent: ](
                if (closeBracket !== openParen - 1) {
                    pos = openBracket + 1;
                    continue;
                }

                // Check if it's an asset:// video link
                if (src.startsWith('asset://', openParen + 1)) {
                    return openBracket;
                }

                pos = openBracket + 1;
            }
            return -1;
        },
        tokenize(src: string): any {
            // src should start with '[' — if not, this isn't a video link
            if (!src.startsWith('[')) return undefined;
            const closeBracket = src.indexOf(']');
            if (closeBracket === -1) return undefined;
            const openParen = src.indexOf('(', closeBracket);
            if (openParen !== closeBracket + 1) return undefined;
            // Find matching ')' handling %29 escape
            let closePos = -1;
            for (let i = openParen + 1; i < src.length; i++) {
                const ch = src[i];
                if (ch === '%' && i + 2 < src.length && src[i + 1] === '2' && src[i + 2] === '9') {
                    i += 2;
                    continue;
                }
                if (ch === ')') {
                    if (i > 0 && src[i - 1] === '%') continue;
                    closePos = i;
                    break;
                }
            }
            if (closePos === -1) return undefined;
            const url = src.slice(openParen + 1, closePos);
            if (!isVideoUrl(url)) return undefined;
            // raw is precisely [title](url)
            const raw = src.slice(0, closePos + 1);
            return { type: 'videoAttachment', raw };
        },
    },

    parseMarkdown(token: any) {
        if (token.raw.startsWith('!')) return { type: 'text', text: token.raw };
        const firstBracket = token.raw.indexOf('[');
        if (firstBracket === -1) return { type: 'text', text: token.raw };
        const closeBracket = token.raw.indexOf(']', firstBracket + 1);
        const openParen = token.raw.indexOf('(', firstBracket);
        if (closeBracket === -1 || openParen === -1 || closeBracket !== openParen - 1) {
            return { type: 'text', text: token.raw };
        }
        const title = token.raw.slice(firstBracket + 1, closeBracket);
        let closePos = -1;
        const remaining = token.raw.slice(openParen + 1);
        for (let i = 0; i < remaining.length; i++) {
            if (remaining[i] === '%' && i + 2 < remaining.length && remaining[i + 1] === '2' && remaining[i + 2] === '9') {
                i += 2;
                continue;
            }
            if (remaining[i] === ')') {
                if (i > 0 && remaining[i - 1] === '%') continue;
                closePos = openParen + 1 + i;
                break;
            }
        }
        if (closePos === -1) return { type: 'text', text: token.raw };
        const src = token.raw.slice(openParen + 1, closePos);
        if (!isVideoUrl(src)) return { type: 'text', text: token.raw };
        return {
            type: 'videoAttachment',
            attrs: {
                src,
                title,
                storageMode: 'attachment',
                storageKey: decodeStorageKey(src),
            },
        };
    },

    renderMarkdown(node: any) {
        const { title, storageMode, storageKey, src } = node.attrs || {};
        const videoSrc = storageMode === 'attachment' && storageKey
            ? assetMarkdownUrl(String(storageKey))
            : src || '';
        return `[${title || ''}](${videoSrc})`;
    },
});
