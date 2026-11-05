import { resolveEditorImageSource, type EditorImageContext, type EditorImageSource } from '@features/editor/editor-image-source';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView, Decoration } from '@tiptap/pm/view';
import {
    Node,
    InputRule,
    mergeAttributes,
    type JSONContent,
} from '@tiptap/core';
import { invoke } from '@platform/tauri/core';
import { assetMarkdownUrl, assetUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';
import { renderFlowixMediaStyleComment } from '@features/editor/extensions/attachment-link/markdown/media-style';
import {
    DEFAULT_IMAGE_WIDTH_PERCENT, MAX_IMAGE_WIDTH_PERCENT, imageMarkdownSpec, escapeImageAlt,
    normalizeImageAlignment, normalizeWidthPercent,
} from '@features/editor/extensions/attachment-link/markdown/image-markdown';
import { translate, type I18nKey } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';

export { decodeStorageKey };

type ImageAttributes = Record<string, unknown> & {
    src?: unknown;
    alt?: unknown;
    title?: unknown;
    fileName?: unknown;
    storageMode?: unknown;
    storageKey?: unknown;
    widthPercent?: unknown;
    align?: unknown;
};

function stringAttribute(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

// NodeView 不在 React 树内, 不能用 useI18n, 走 user-settings-store 直读当前语言。
function tKey(key: I18nKey, params?: Record<string, string | number>): string {
    return translate(getCurrentAppLanguage(), key, params);
}

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

class ImageView implements ProseMirrorNodeView {
    dom: HTMLElement;
    contentDOM: HTMLElement | null = null;
    node: ProseMirrorNode;
    view: EditorView;
    getPos: (() => number) | undefined;
    decorations: readonly Decoration[];
    selected = false;
    private appliedSrc: string | null = null;
    private loadGeneration = 0;
    private destroyed = false;
    private pendingLoadHandle: number | null = null;
    private observer: IntersectionObserver | null = null;
    private resizeMoveHandler: ((event: PointerEvent) => void) | null = null;
    private resizeEndHandler: ((event: PointerEvent) => void) | null = null;
    private resizeBlurHandler: (() => void) | null = null;
    private resizeVisibilityHandler: (() => void) | null = null;
    private resizePointerId: number | null = null;
    private resizeCaptureTarget: HTMLButtonElement | null = null;
    private lastResizeWidthPercent: number | null = null;
    private isResizing = false;

    constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number, decorations: readonly Decoration[],
        private readonly getImageContext?: () => EditorImageContext | undefined,
        private readonly onDestroy?: () => void) {
        this.node = node;
        this.view = view;
        this.getPos = getPos;
        this.decorations = decorations;

        const { src, alt, title, storageMode, storageKey } = node.attrs;

        const img = document.createElement('img');
        img.className = 'editor-image-attachment__image';
        img.alt = stringAttribute(alt);
        img.loading = 'lazy';
        img.decoding = 'async';
        img.setAttribute('fetchpriority', 'low');
        if (typeof title === 'string' && title) img.title = title;

        const fallback = document.createElement('div');
        fallback.className = 'editor-image-attachment__fallback';
        fallback.textContent = tKey('editor.image.unavailable');
        fallback.hidden = true;

        const wrapper = document.createElement('div');
        wrapper.className = 'editor-image-attachment';
        wrapper.contentEditable = 'false';
        wrapper.draggable = true;
        wrapper.addEventListener('dblclick', (event) => this.openInSystemViewer(event));
        wrapper.appendChild(img);
        wrapper.appendChild(fallback);
        wrapper.appendChild(this.createResizeHandle('left'));
        wrapper.appendChild(this.createResizeHandle('right'));

        this.dom = wrapper;
        this.applySizing(node.attrs);
        this.applySrc(img, { src, storageMode, storageKey });
        this.applyOpenableState(node.attrs);
    }

    private createResizeHandle(side: 'left' | 'right'): HTMLButtonElement {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = `editor-image-attachment__resize-handle editor-image-attachment__resize-handle--${side}`;
        handle.setAttribute('aria-label', side === 'left' ? tKey('editor.image.resize.left') : tKey('editor.image.resize.right'));
        handle.addEventListener('pointerdown', (event) => this.startResize(event, side, handle));
        return handle;
    }

    private getSource(attrs: ImageAttributes): EditorImageSource {
        const storageKey = stringAttribute(attrs.storageKey);
        if (attrs.storageMode === 'attachment' && storageKey) {
            const url = assetUrl(storageKey);
            return { kind: 'url', key: url, url };
        }
        const src = stringAttribute(attrs.src);
        return src ? resolveEditorImageSource(src, this.getImageContext?.()) : { kind: 'url', key: '', url: '' };
    }

    refreshSourceContext(): void {
        const img = this.dom.querySelector('img');
        if (img && !this.destroyed) this.applySrc(img, this.node.attrs);
    }

    private getOpenablePath(attrs: ImageAttributes): string | null {
        if (attrs.storageMode !== 'attachment' || typeof attrs.storageKey !== 'string') return null;
        const storageKey = attrs.storageKey.trim();
        return storageKey ? storageKey : null;
    }

    private applyOpenableState(attrs: ImageAttributes): void {
        this.dom.toggleAttribute('data-openable', this.getOpenablePath(attrs) !== null);
    }

    private openInSystemViewer(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        if (this.isResizing) return;
        if (
            event.target instanceof HTMLElement
            && event.target.closest('.editor-image-attachment__resize-handle') !== null
        ) {
            return;
        }

        const path = this.getOpenablePath(this.node.attrs);
        if (!path) return;
        void invoke('open_attachment_file', { sourcePath: path }).catch((error) => {
            console.error('[ImageAttachment] Failed to open image in system viewer:', error);
        });
    }

    private scheduleImageLoad(img: HTMLImageElement, source: EditorImageSource): void {
        const generation = this.loadGeneration;
        if (this.pendingLoadHandle !== null) cancelIdle(this.pendingLoadHandle);
        this.pendingLoadHandle = whenIdle(() => {
            this.pendingLoadHandle = null;
            if (!img.isConnected || this.destroyed || generation !== this.loadGeneration) return;
            const read = source.kind === 'local'
                ? Promise.resolve().then(() => source.readImage(source.path, source.scopePath))
                : Promise.resolve(source.kind === 'url' ? source.url : null);
            void read.catch(() => null).then((src) => {
                if (this.destroyed || generation !== this.loadGeneration || !img.isConnected) return;
                const failed = () => {
                    if (this.destroyed || generation !== this.loadGeneration) return;
                    img.classList.remove('is-loaded');
                    this.dom.classList.remove('is-loaded');
                    this.dom.classList.add('is-error');
                    this.setFallbackVisible(true);
                };
                if (!src) { failed(); return; }
                img.onload = () => {
                    if (this.destroyed || generation !== this.loadGeneration) return;
                    img.classList.add('is-loaded');
                    this.dom.classList.add('is-loaded');
                    this.dom.classList.remove('is-error');
                    this.setFallbackVisible(false);
                };
                img.onerror = failed;
                img.src = src;
            });
        });
    }

    private setFallbackVisible(visible: boolean): void {
        const fallback = this.dom.querySelector<HTMLElement>('.editor-image-attachment__fallback');
        if (fallback) fallback.hidden = !visible;
    }

    private applySrc(img: HTMLImageElement, attrs: ImageAttributes): void {
        const nextSrc = this.getSource(attrs);
        if (nextSrc.key === this.appliedSrc) return;
        this.appliedSrc = nextSrc.key;
        this.loadGeneration += 1;
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');

        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.pendingLoadHandle !== null) {
            cancelIdle(this.pendingLoadHandle);
            this.pendingLoadHandle = null;
        }

        if (nextSrc.kind === 'url' && !nextSrc.url) {
            img.removeAttribute('src');
            img.classList.remove('is-loaded');
            this.dom.classList.remove('is-loaded');
            this.dom.classList.remove('is-error');
            this.setFallbackVisible(false);
            return;
        }

        img.dataset.src = nextSrc.kind === 'local' ? nextSrc.path : nextSrc.kind === 'url' ? nextSrc.url : '';
        img.classList.remove('is-loaded');
        this.dom.classList.remove('is-loaded');
        this.dom.classList.remove('is-error');
        this.setFallbackVisible(false);
        if (typeof IntersectionObserver === 'undefined') {
            this.scheduleImageLoad(img, nextSrc);
            return;
        }

        const generation = this.loadGeneration;
        const observer = new IntersectionObserver((entries) => {
            if (this.destroyed || generation !== this.loadGeneration || this.observer !== observer) return;
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            this.observer = null;
            this.scheduleImageLoad(img, nextSrc);
        }, { rootMargin: '600px 0px' });
        this.observer = observer;
        observer.observe(img);
    }

    private applySizing(attrs: ImageAttributes): void {
        const widthPercent = normalizeWidthPercent(attrs.widthPercent) ?? DEFAULT_IMAGE_WIDTH_PERCENT;
        this.dom.style.width = `${widthPercent}%`;
        this.dom.dataset.widthPercent = String(widthPercent);
        this.dom.dataset.imageAlign = normalizeImageAlignment(attrs.align);
    }

    private startResize(event: PointerEvent, side: 'left' | 'right', handle: HTMLButtonElement): void {
        if (this.isResizing || event.button !== 0) return;

        event.preventDefault();
        event.stopPropagation();

        const wrapper = this.dom;
        const parent = wrapper.parentElement;
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();
        if (parentRect.width <= 0) return;

        this.isResizing = true;
        this.resizePointerId = event.pointerId;
        this.resizeCaptureTarget = handle;
        handle.setPointerCapture(event.pointerId);
        wrapper.classList.add('is-resizing');
        document.body.classList.add('is-image-resizing');
        const initialWidthPercent = normalizeWidthPercent(this.node.attrs.widthPercent) ?? DEFAULT_IMAGE_WIDTH_PERCENT;
        this.lastResizeWidthPercent = initialWidthPercent;
        const startClientX = event.clientX;

        const updateWidth = (clientX: number): void => {
            const deltaX = clientX - startClientX;
            const signedDelta = side === 'right' ? deltaX : -deltaX;
            const deltaPercent = ((signedDelta * 2) / parentRect.width) * 100;
            const nextPercent = normalizeWidthPercent(initialWidthPercent + deltaPercent);
            if (nextPercent === null) return;
            this.lastResizeWidthPercent = nextPercent;
            wrapper.style.width = `${nextPercent}%`;
            wrapper.dataset.widthPercent = String(nextPercent);
        };

        this.resizeMoveHandler = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== this.resizePointerId) return;
            moveEvent.preventDefault();
            updateWidth(moveEvent.clientX);
        };

        this.resizeEndHandler = (endEvent: PointerEvent) => {
            if (endEvent.pointerId !== this.resizePointerId) return;
            endEvent.preventDefault();
            this.finishResize();
        };

        this.resizeBlurHandler = () => this.finishResize();
        this.resizeVisibilityHandler = () => {
            if (document.visibilityState !== 'visible') this.finishResize();
        };

        window.addEventListener('pointermove', this.resizeMoveHandler);
        window.addEventListener('pointerup', this.resizeEndHandler);
        window.addEventListener('pointercancel', this.resizeEndHandler);
        window.addEventListener('blur', this.resizeBlurHandler);
        document.addEventListener('visibilitychange', this.resizeVisibilityHandler);
    }

    private finishResize(): void {
        const shouldCommit = this.isResizing;
        this.isResizing = false;

        if (this.resizeMoveHandler) {
            window.removeEventListener('pointermove', this.resizeMoveHandler);
            this.resizeMoveHandler = null;
        }
        if (this.resizeEndHandler) {
            window.removeEventListener('pointerup', this.resizeEndHandler);
            window.removeEventListener('pointercancel', this.resizeEndHandler);
            this.resizeEndHandler = null;
        }
        if (this.resizeBlurHandler) {
            window.removeEventListener('blur', this.resizeBlurHandler);
            this.resizeBlurHandler = null;
        }
        if (this.resizeVisibilityHandler) {
            document.removeEventListener('visibilitychange', this.resizeVisibilityHandler);
            this.resizeVisibilityHandler = null;
        }
        const captureTarget = this.resizeCaptureTarget;
        const pointerId = this.resizePointerId;
        if (captureTarget && pointerId !== null && captureTarget.hasPointerCapture(pointerId)) {
            captureTarget.releasePointerCapture(pointerId);
        }
        this.resizeCaptureTarget = null;
        this.resizePointerId = null;

        this.dom.classList.remove('is-resizing');
        document.body.classList.remove('is-image-resizing');
        if (!shouldCommit) return;

        const nextWidthPercent = normalizeWidthPercent(this.lastResizeWidthPercent);
        const pos = this.getPos?.();
        if (pos === undefined || nextWidthPercent === null) return;
        const currentWidthPercent = normalizeWidthPercent(this.node.attrs.widthPercent) ?? DEFAULT_IMAGE_WIDTH_PERCENT;
        if (Math.abs(currentWidthPercent - nextWidthPercent) < 0.1) return;

        const attrs = {
            ...this.node.attrs,
            widthPercent: nextWidthPercent >= MAX_IMAGE_WIDTH_PERCENT ? null : nextWidthPercent,
        };
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, attrs));
    }

    updateAttributes(attributes: ImageAttributes): void {
        const img = this.dom.querySelector('img');
        if (img) {
            if (attributes.storageMode === 'attachment' && attributes.storageKey) {
                attributes.src = assetUrl(String(attributes.storageKey));
            }
            Object.entries(attributes).forEach(([key, value]) => {
                if (key === 'src') return;
                img.setAttribute(key, String(value));
            });
            this.applySizing(attributes);
            this.applySrc(img, attributes);
            this.applyOpenableState(attributes);
        }
    }

    update(node: ProseMirrorNode): boolean {
        if (node.type.name !== 'image') return false;
        this.node = node;

        const img = this.dom.querySelector('img');
        if (!img) return true;
        img.alt = node.attrs.alt ?? '';
        if (node.attrs.title) {
            img.title = node.attrs.title;
        } else {
            img.removeAttribute('title');
        }
        this.applySizing(node.attrs);
        this.applySrc(img, node.attrs);
        this.applyOpenableState(node.attrs);
        return true;
    }

    selectNode(): void {
        this.selected = true;
        this.dom.classList.add('is-selected');
    }

    deselectNode(): void {
        this.selected = false;
        this.dom.classList.remove('is-selected');
    }

    stopEvent(event: Event): boolean {
        if (this.dom.classList.contains('is-resizing')) return true;
        if (event.type === 'dblclick') return true;
        return event.target instanceof HTMLElement
            && event.target.closest('.editor-image-attachment__resize-handle') !== null;
    }

    deleteNode(): void {
        const { state, dispatch } = this.view;
        const pos = this.getPos?.();
        if (pos === undefined) return;
        const tr = state.tr.delete(pos, pos + this.node.nodeSize);
        dispatch(tr);
    }

    destroy(): void {
        this.destroyed = true;
        this.loadGeneration += 1;
        this.onDestroy?.();
        const img = this.dom.querySelector('img');
        if (img) { img.onload = null; img.onerror = null; }
        this.finishResize();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.pendingLoadHandle !== null) {
            cancelIdle(this.pendingLoadHandle);
            this.pendingLoadHandle = null;
        }
    }
}

// 鈹€鈹€鈹€ ImageAttachment Node 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

interface ImageAttachmentOptions {
    getImageContext?: () => EditorImageContext | undefined;
}

interface ImageAttachmentStorage {
    views: Set<ImageView>;
    refreshSources: () => void;
}

declare module '@tiptap/core' {
    interface Storage {
        image: ImageAttachmentStorage;
    }
}

export const ImageAttachment = Node.create<ImageAttachmentOptions, ImageAttachmentStorage>({
    name: 'image',
    addOptions() { return {}; },
    addStorage() {
        const views = new Set<ImageView>();
        return { views, refreshSources: () => views.forEach(view => view.refreshSourceContext()) };
    },
    group: 'block',
    inline: false,
    atom: true,
    draggable: true,

    addAttributes() {
        return {
            src: { default: null },
            alt: { default: null },
            title: { default: null },
            fileName: { default: null },
            mimeType: { default: null },
            storageMode: { default: null },
            storageKey: { default: null },
            widthPercent: {
                default: null,
                parseHTML: (element: HTMLElement) => normalizeWidthPercent(element.getAttribute('data-width-percent')),
                renderHTML: (attributes: ImageAttributes) => {
                    const widthPercent = normalizeWidthPercent(attributes.widthPercent);
                    return widthPercent ? { 'data-width-percent': String(widthPercent), style: `width: ${widthPercent}%` } : {};
                },
            },
            align: {
                default: 'center',
                parseHTML: (element: HTMLElement) => normalizeImageAlignment(element.getAttribute('data-image-align')),
                renderHTML: (attributes: ImageAttributes) => {
                    const align = normalizeImageAlignment(attributes.align);
                    return align === 'center' ? {} : { 'data-image-align': align };
                },
            },
        };
    },

    addInputRules() {
        return [
            new InputRule({
                find: /!\[([^\]]*)\]\((asset:\/\/(?:[^)\%] | %[0-9A-Fa-f]{2})*)\)$/,
                handler: ({ state, range, match }) => {
                    const [, alt, src] = match;
                    if (src.endsWith('.mp4') || src.endsWith('.mov') || src.endsWith('.webm')) return;
                    const { tr } = state;
                    tr.replaceWith(range.from, range.to, this.type.create({
                        src,
                        alt: alt || null,
                        title: null,
                        storageMode: 'attachment',
                        storageKey: decodeStorageKey(src),
                        widthPercent: null,
                        align: 'center',
                    }));
                },
            }),
        ];
    },

    parseHTML() {
        return [
            {
                tag: 'div[data-image-attachment]',
                getAttrs: (element: HTMLElement) => {
                    const img = element.querySelector('img');
                    if (!img) return false;
                    return {
                        src: img.getAttribute('src'),
                        alt: img.getAttribute('alt'),
                        title: img.getAttribute('title'),
                        fileName: element.getAttribute('data-file-name'),
                        mimeType: element.getAttribute('data-mime-type'),
                        storageMode: element.getAttribute('data-storage-mode'),
                        storageKey: element.getAttribute('data-storage-key'),
                        widthPercent: normalizeWidthPercent(element.getAttribute('data-width-percent')),
                        align: normalizeImageAlignment(element.getAttribute('data-image-align')),
                    };
                },
            },
            {
                tag: 'span[data-image-attachment]',
                getAttrs: (element: HTMLElement) => {
                    const img = element.querySelector('img');
                    if (!img) return false;
                    return {
                        src: img.getAttribute('src'),
                        alt: img.getAttribute('alt'),
                        title: img.getAttribute('title'),
                        fileName: element.getAttribute('data-file-name'),
                        mimeType: element.getAttribute('data-mime-type'),
                        storageMode: element.getAttribute('data-storage-mode'),
                        storageKey: element.getAttribute('data-storage-key'),
                        widthPercent: normalizeWidthPercent(element.getAttribute('data-width-percent')),
                        align: normalizeImageAlignment(element.getAttribute('data-image-align')),
                    };
                },
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const { storageMode, storageKey, src, alt, title, fileName, mimeType, widthPercent, align } = HTMLAttributes;
        const imageSrc = storageMode === 'attachment' && storageKey
            ? assetUrl(String(storageKey))
            : src;
        const normalizedWidthPercent = normalizeWidthPercent(widthPercent);
        const normalizedAlign = normalizeImageAlignment(align);
        return [
            'div',
            mergeAttributes(
                { class: 'editor-image-attachment is-loaded' },
                { 'data-image-attachment': 'true' },
                fileName ? { 'data-file-name': fileName } : {},
                mimeType ? { 'data-mime-type': mimeType } : {},
                storageMode ? { 'data-storage-mode': storageMode } : {},
                storageKey ? { 'data-storage-key': storageKey } : {},
                normalizedWidthPercent ? { 'data-width-percent': String(normalizedWidthPercent), style: `width: ${normalizedWidthPercent}%` } : {},
                normalizedAlign !== 'center' ? { 'data-image-align': normalizedAlign } : {},
            ),
            ['img', mergeAttributes(
                { class: 'editor-image-attachment__image is-loaded', src: imageSrc, alt: alt || null, title: title || null }
            )]
        ];
    },

    addNodeView() {
        return (props) => {
            const nodeView = new ImageView(
                props.node, props.view, () => props.getPos?.() ?? 0, props.decorations,
                this.options.getImageContext, () => this.storage.views.delete(nodeView),
            );
            this.storage.views.add(nodeView);
            return nodeView;
        };
    },

    ...imageMarkdownSpec,

    renderMarkdown(node: JSONContent) {
        const { alt, title, fileName, storageMode, storageKey, src, widthPercent, align } = node.attrs || {};
        const imageSrc = storageMode === 'attachment' && storageKey
            ? assetMarkdownUrl(storageKey)
            : src || '';
        const altText = escapeImageAlt(String(alt || title || fileName || ''));
        const normalizedWidthPercent = normalizeWidthPercent(widthPercent);
        const normalizedAlign = normalizeImageAlignment(align);
        const style: Record<string, unknown> = {};
        if (normalizedWidthPercent) style.widthPercent = normalizedWidthPercent;
        if (normalizedAlign !== 'center') style.align = normalizedAlign;
        const suffix = renderFlowixMediaStyleComment(style);
        return `${suffix}![${altText}](${imageSrc})`;
    },
});
