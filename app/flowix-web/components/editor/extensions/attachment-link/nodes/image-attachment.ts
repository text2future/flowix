import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView, Decoration } from '@tiptap/pm/view';
import { Node, InputRule, mergeAttributes } from '@tiptap/core';
import { assetMarkdownUrl, assetUrl, decodeStorageKey } from '../utils';

export { decodeStorageKey };

const MARKDOWN_IMAGE_RE = /^!\[([^\]]*)\]\(([^)\n]+)\)/;
const ASSET_IMAGE_RE = /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i;

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

        const wrapper = document.createElement('div');
        wrapper.className = 'editor-image-attachment';
        wrapper.contentEditable = 'false';
        wrapper.draggable = true;
        wrapper.appendChild(img);

        this.dom = wrapper;
        this.applySrc(img, { src, storageMode, storageKey });
    }

    private getSource(attrs: Record<string, any>): string {
        return attrs.storageMode === 'attachment' && attrs.storageKey
            ? assetUrl(attrs.storageKey)
            : (attrs.src ?? '');
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
            }, { once: true });
            img.addEventListener('error', () => {
                img.classList.add('is-loaded');
            }, { once: true });
            img.src = src;
        });
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
            return;
        }

        img.dataset.src = nextSrc;
        img.classList.remove('is-loaded');
        this.dom.classList.remove('is-loaded');
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
            this.applySrc(img, attributes);
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
        this.applySrc(img, node.attrs as Record<string, any>);
        return true;
    }

    deleteNode(): void {
        const { state, dispatch } = this.view;
        const pos = this.getPos?.();
        if (pos === undefined) return;
        const tr = state.tr.delete(pos, pos + this.node.nodeSize);
        dispatch(tr);
    }

    destroy(): void {
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
                    }));
                },
            }),
        ];
    },

    parseHTML() {
        return [
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
                    };
                },
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const { storageMode, storageKey, src, alt, title, fileName, mimeType } = HTMLAttributes;
        const imageSrc = storageMode === 'attachment' && storageKey
            ? assetUrl(String(storageKey))
            : src;
        return [
            'div',
            mergeAttributes(
                { class: 'editor-image-attachment is-loaded' },
                { 'data-image-attachment': 'true' },
                fileName ? { 'data-file-name': fileName } : {},
                mimeType ? { 'data-mime-type': mimeType } : {},
                storageMode ? { 'data-storage-mode': storageMode } : {},
                storageKey ? { 'data-storage-key': storageKey } : {}
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
            return { type: 'image', raw: match[0], href: match[2], text: match[1], title: null };
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
            });
        }
        return helpers.createNode('image', {
            src: token.href,
            alt: token.text || null,
            title: token.title || null,
            storageMode: 'attachment',
            storageKey: decodeStorageKey(token.href),
        });
    },

    renderMarkdown(node: any) {
        const { alt, title, fileName, storageMode, storageKey, src } = node.attrs || {};
        const imageSrc = storageMode === 'attachment' && storageKey
            ? assetMarkdownUrl(storageKey)
            : src || '';
        const altText = alt || title || fileName || '';
        return `![${altText}](${imageSrc})`;
    },
});

