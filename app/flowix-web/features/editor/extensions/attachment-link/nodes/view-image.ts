import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView, Decoration } from '@tiptap/pm/view';
import { Node, InputRule, mergeAttributes } from '@tiptap/core';
import { invoke } from '@tauri-apps/api/core';
import { assetMarkdownUrl, assetUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';
import { translate, type I18nKey } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

export { decodeStorageKey };

const MARKDOWN_IMAGE_RE = /^!\[([^\]]*)\]\(([^)\n]+)\)(?:\{width=(\d+(?:\.\d+)?)%\})?/;
const ASSET_IMAGE_RE = /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i;
const DEFAULT_IMAGE_WIDTH_PERCENT = 100;
const MIN_IMAGE_WIDTH_PERCENT = 20;
const MAX_IMAGE_WIDTH_PERCENT = 100;

// NodeView 不在 React 树内, 不能用 useI18n, 走 user-settings-store 直读当前语言。
function tKey(key: I18nKey, params?: Record<string, string | number>): string {
    return translate(useUserSettingsStore.getState().settings.language, key, params);
}

function isAttachmentImageHref(href: string | null | undefined): boolean {
    return !!href && ASSET_IMAGE_RE.test(href);
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

function normalizeWidthPercent(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return null;
    const clamped = Math.min(MAX_IMAGE_WIDTH_PERCENT, Math.max(MIN_IMAGE_WIDTH_PERCENT, numeric));
    return Math.round(clamped * 10) / 10;
}

// 鈹€鈹€鈹€ ImageView 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class ImageView implements ProseMirrorNodeView {
    dom: HTMLElement;
    contentDOM: HTMLElement | null = null;
    node: ProseMirrorNode;
    view: EditorView;
    getPos: (() => number) | undefined;
    decorations: readonly Decoration[];
    selected = false;
    private appliedSrc: string | null = null;
    private pendingLoadHandle: number | null = null;
    private observer: IntersectionObserver | null = null;
    private resizeMoveHandler: ((event: PointerEvent) => void) | null = null;
    private resizeEndHandler: ((event: PointerEvent) => void) | null = null;
    private lastResizeWidthPercent: number | null = null;
    private isResizing = false;

    constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number, decorations: readonly Decoration[]) {
        this.node = node;
        this.view = view;
        this.getPos = getPos;
        this.decorations = decorations;

        const { src, alt, title, storageMode, storageKey } = node.attrs;

        const img = document.createElement('img');
        img.className = 'editor-image-attachment__image';
        img.alt = alt ?? '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.setAttribute('fetchpriority', 'low');
        if (title) img.title = title;

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
        this.applySizing(node.attrs as Record<string, any>);
        this.applySrc(img, { src, storageMode, storageKey });
        this.applyOpenableState(node.attrs as Record<string, any>);
    }

    private createResizeHandle(side: 'left' | 'right'): HTMLButtonElement {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = `editor-image-attachment__resize-handle editor-image-attachment__resize-handle--${side}`;
        handle.setAttribute('aria-label', side === 'left' ? tKey('editor.image.resize.left') : tKey('editor.image.resize.right'));
        handle.addEventListener('pointerdown', (event) => this.startResize(event, side));
        return handle;
    }

    private getSource(attrs: Record<string, any>): string {
        return attrs.storageMode === 'attachment' && attrs.storageKey
            ? assetUrl(attrs.storageKey)
            : (attrs.src ?? '');
    }

    private getOpenablePath(attrs: Record<string, any>): string | null {
        if (attrs.storageMode !== 'attachment' || typeof attrs.storageKey !== 'string') return null;
        const storageKey = attrs.storageKey.trim();
        return storageKey ? storageKey : null;
    }

    private applyOpenableState(attrs: Record<string, any>): void {
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

        const path = this.getOpenablePath(this.node.attrs as Record<string, any>);
        if (!path) return;
        void invoke('open_attachment_file', { sourcePath: path }).catch((error) => {
            console.error('[ImageAttachment] Failed to open image in system viewer:', error);
        });
    }

    private scheduleImageLoad(img: HTMLImageElement, src: string): void {
        if (this.pendingLoadHandle !== null) {
            cancelIdle(this.pendingLoadHandle);
            this.pendingLoadHandle = null;
        }

        this.pendingLoadHandle = whenIdle(() => {
            this.pendingLoadHandle = null;
            if (!img.isConnected) return;
            img.addEventListener('load', () => {
                img.classList.add('is-loaded');
                this.dom.classList.add('is-loaded');
                this.dom.classList.remove('is-error');
                this.setFallbackVisible(false);
            }, { once: true });
            img.addEventListener('error', () => {
                img.classList.remove('is-loaded');
                this.dom.classList.remove('is-loaded');
                this.dom.classList.add('is-error');
                this.setFallbackVisible(true);
            }, { once: true });
            img.src = src;
        });
    }

    private setFallbackVisible(visible: boolean): void {
        const fallback = this.dom.querySelector<HTMLElement>('.editor-image-attachment__fallback');
        if (fallback) fallback.hidden = !visible;
    }

    private applySrc(img: HTMLImageElement, attrs: Record<string, any>): void {
        const nextSrc = this.getSource(attrs);
        if (nextSrc === this.appliedSrc) return;
        this.appliedSrc = nextSrc;

        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.pendingLoadHandle !== null) {
            cancelIdle(this.pendingLoadHandle);
            this.pendingLoadHandle = null;
        }

        if (!nextSrc) {
            img.removeAttribute('src');
            img.classList.remove('is-loaded');
            this.dom.classList.remove('is-loaded');
            this.dom.classList.remove('is-error');
            this.setFallbackVisible(false);
            return;
        }

        img.dataset.src = nextSrc;
        img.classList.remove('is-loaded');
        this.dom.classList.remove('is-loaded');
        this.dom.classList.remove('is-error');
        this.setFallbackVisible(false);
        if (typeof IntersectionObserver === 'undefined') {
            this.scheduleImageLoad(img, nextSrc);
            return;
        }

        this.observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            this.observer?.disconnect();
            this.observer = null;
            this.scheduleImageLoad(img, nextSrc);
        }, { rootMargin: '600px 0px' });
        this.observer.observe(img);
    }

    private applySizing(attrs: Record<string, any>): void {
        const widthPercent = normalizeWidthPercent(attrs.widthPercent) ?? DEFAULT_IMAGE_WIDTH_PERCENT;
        this.dom.style.width = `${widthPercent}%`;
        this.dom.dataset.widthPercent = String(widthPercent);
    }

    private startResize(event: PointerEvent, side: 'left' | 'right'): void {
        event.preventDefault();
        event.stopPropagation();

        const wrapper = this.dom;
        const parent = wrapper.parentElement;
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();
        if (parentRect.width <= 0) return;

        this.isResizing = true;
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
            moveEvent.preventDefault();
            updateWidth(moveEvent.clientX);
        };

        this.resizeEndHandler = (endEvent: PointerEvent) => {
            endEvent.preventDefault();
            this.finishResize();
        };

        window.addEventListener('pointermove', this.resizeMoveHandler);
        window.addEventListener('pointerup', this.resizeEndHandler, { once: true });
        window.addEventListener('pointercancel', this.resizeEndHandler, { once: true });
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

    updateAttributes(attributes: Record<string, any>): void {
        const img = this.dom.querySelector('img');
        if (img) {
            if (attributes.storageMode === 'attachment' && attributes.storageKey) {
                attributes.src = assetUrl(attributes.storageKey);
            }
            Object.entries(attributes).forEach(([key, value]) => {
                if (key === 'src') return;
                img.setAttribute(key, value);
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
        this.applySizing(node.attrs as Record<string, any>);
        this.applySrc(img, node.attrs as Record<string, any>);
        this.applyOpenableState(node.attrs as Record<string, any>);
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

export const ImageAttachment = Node.create({
    name: 'image',
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
                renderHTML: (attributes: Record<string, any>) => {
                    const widthPercent = normalizeWidthPercent(attributes.widthPercent);
                    return widthPercent ? { 'data-width-percent': String(widthPercent), style: `width: ${widthPercent}%` } : {};
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
                    };
                },
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const { storageMode, storageKey, src, alt, title, fileName, mimeType, widthPercent } = HTMLAttributes;
        const imageSrc = storageMode === 'attachment' && storageKey
            ? assetUrl(String(storageKey))
            : src;
        const normalizedWidthPercent = normalizeWidthPercent(widthPercent);
        return [
            'div',
            mergeAttributes(
                { class: 'editor-image-attachment is-loaded' },
                { 'data-image-attachment': 'true' },
                fileName ? { 'data-file-name': fileName } : {},
                mimeType ? { 'data-mime-type': mimeType } : {},
                storageMode ? { 'data-storage-mode': storageMode } : {},
                storageKey ? { 'data-storage-key': storageKey } : {},
                normalizedWidthPercent ? { 'data-width-percent': String(normalizedWidthPercent), style: `width: ${normalizedWidthPercent}%` } : {}
            ),
            ['img', mergeAttributes(
                { class: 'editor-image-attachment__image is-loaded', src: imageSrc, alt: alt || null, title: title || null }
            )]
        ];
    },

    addNodeView() {
        return (props) => new ImageView(
            props.node,
            props.view,
            () => props.getPos?.() ?? 0,
            props.decorations
        );
    },

    markdownTokenizer: {
        name: 'image',
        level: 'block' as const,
        start(src: string) {
            return src.indexOf('![');
        },
        tokenize(src: string): any {
            const match = MARKDOWN_IMAGE_RE.exec(src);
            if (!match) return undefined;
            return { type: 'image', raw: match[0], href: match[2], text: match[1], title: null, widthPercent: normalizeWidthPercent(match[3]) };
        },
    },

    parseMarkdown(token: any, helpers: any) {
        if (!token.href) {
            return { type: 'text', text: token.raw || '' };
        }
        if (!isAttachmentImageHref(token.href)) {
            return helpers.createNode('image', {
                src: token.href,
                alt: token.text || null,
                title: token.title || null,
                storageMode: null,
                storageKey: null,
                widthPercent: token.widthPercent ?? null,
            });
        }
        return helpers.createNode('image', {
            src: token.href,
            alt: token.text || null,
            title: token.title || null,
            storageMode: 'attachment',
            storageKey: decodeStorageKey(token.href),
            widthPercent: token.widthPercent ?? null,
        });
    },

    renderMarkdown(node: any) {
        const { alt, title, fileName, storageMode, storageKey, src, widthPercent } = node.attrs || {};
        const imageSrc = storageMode === 'attachment' && storageKey
            ? assetMarkdownUrl(storageKey)
            : src || '';
        const altText = alt || title || fileName || '';
        const normalizedWidthPercent = normalizeWidthPercent(widthPercent);
        const sizeSuffix = normalizedWidthPercent ? `{width=${normalizedWidthPercent}%}` : '';
        return `![${altText}](${imageSrc})${sizeSuffix}`;
    },
});
