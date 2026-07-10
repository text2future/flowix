import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView, Decoration } from '@tiptap/pm/view';
import type { ViewMutationRecord } from '@tiptap/pm/view';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeSelection, Plugin } from '@tiptap/pm/state';
import { assetUrl } from '@features/editor/extensions/attachment-link/utils';
import { readMarkdownLinkDestination } from '@features/editor/extensions/shared/markdown-link-destination';
import { setInlineAtomTextSelectionFromMouse } from '@features/editor/extensions/shared/inline-atom-selection';
import { createTerminalInlineAtomCaretDecorations } from '@features/editor/extensions/shared/terminal-inline-atom-caret';
import { dialogs } from '@platform/tauri/client';
import {
    isAttachmentMarkdownUrl,
    parseFileAttachmentMarkdown,
    renderFileAttachmentMarkdown,
} from '@features/editor/extensions/attachment-link/markdown/file-markdown';

// ─── Attachment icon (Remixicon RiAttachment2) ───────────────────────────────
// 共用于 createCard (NodeView DOM) + renderHTML (序列化 HTML), 避免两条路径
// 的 SVG path drift. viewBox 24x24, currentColor 拿到 --document-link.
const ATTACHMENT_ICON_PATH = 'M14.8287 7.75737L9.1718 13.4142C8.78127 13.8047 8.78127 14.4379 9.1718 14.8284C9.56232 15.219 10.1955 15.219 10.586 14.8284L16.2429 9.17158C17.4144 8.00001 17.4144 6.10052 16.2429 4.92894C15.0713 3.75737 13.1718 3.75737 12.0002 4.92894L6.34337 10.5858C4.39075 12.5384 4.39075 15.7042 6.34337 17.6569C8.29599 19.6095 11.4618 19.6095 13.4144 17.6569L19.0713 12L20.4855 13.4142L14.8287 19.0711C12.095 21.8047 7.66283 21.8047 4.92916 19.0711C2.19549 16.3374 2.19549 11.9053 4.92916 9.17158L10.586 3.51473C12.5386 1.56211 15.7045 1.56211 17.6571 3.51473C19.6097 5.46735 19.6097 8.63317 17.6571 10.5858L12.0002 16.2427C10.8287 17.4142 8.92916 17.4142 7.75759 16.2427C6.58601 15.0711 6.58601 13.1716 7.75759 12L13.4144 6.34316L14.8287 7.75737Z';
const ATTACHMENT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="${ATTACHMENT_ICON_PATH}"></path></svg>`;

// 鈹€鈹€鈹€ FileView (Pure Render) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function removeHardBreaksAroundFileAttachments(state: any) {
    const deletions: Array<{ from: number; to: number }> = [];
    const seen = new Set<string>();

    const pushDeletion = (from: number, to: number) => {
        const key = `${from}:${to}`;
        if (seen.has(key)) return;
        seen.add(key);
        deletions.push({ from, to });
    };

    state.doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (node.type.name !== 'fileAttachment') return;

        const $pos = state.doc.resolve(pos);
        const nodeBefore = $pos.nodeBefore;
        if (nodeBefore?.type.name === 'hardBreak') {
            pushDeletion(pos - nodeBefore.nodeSize, pos);
        }

        const afterPos = pos + node.nodeSize;
        const $after = state.doc.resolve(afterPos);
        const nodeAfter = $after.nodeAfter;
        if (nodeAfter?.type.name === 'hardBreak') {
            pushDeletion(afterPos, afterPos + nodeAfter.nodeSize);
        }
    });

    if (deletions.length === 0) return null;

    const tr = state.tr;
    deletions.reverse().forEach(({ from, to }) => {
        tr.delete(from, to);
    });
    return tr;
}

class FileView implements ProseMirrorNodeView {
    dom: HTMLElement;
    contentDOM: HTMLElement | null = null;
    node: ProseMirrorNode;
    view: EditorView;
    getPos: (() => number) | undefined;
    decorations: readonly Decoration[];
    selected = false;
    private suppressNextClickSelection = false;

    constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number, decorations: readonly Decoration[]) {
        this.node = node;
        this.view = view;
        this.getPos = getPos;
        this.decorations = decorations;
        this.dom = this.createCard();
        this.contentDOM = null;
    }

    private createCard(): HTMLElement {
        const { name, storageMode, storageKey } = this.node.attrs;

        const wrapper = document.createElement('span');
        wrapper.className = 'editor-file-attachment';
        wrapper.contentEditable = 'false';
        wrapper.style.display = 'inline';
        wrapper.draggable = true;

        const card = document.createElement('span');
        card.className = 'editor-file-attachment__card';
        card.setAttribute('data-storage-mode', storageMode ?? '');
        card.setAttribute('data-storage-key', storageKey ?? '');

        const icon = document.createElement('span');
        icon.className = 'editor-file-attachment__icon';
        icon.style.display = 'inline-flex';
        icon.style.alignItems = 'center';
        icon.style.verticalAlign = 'middle';
        icon.innerHTML = ATTACHMENT_ICON_SVG;

        const filenameSpan = document.createElement('span');
        filenameSpan.className = 'editor-file-attachment__name';
        filenameSpan.textContent = name ?? '';

        card.appendChild(icon);
        card.appendChild(filenameSpan);

        // 节点首/尾部 caret 占位:
        //  inline atom node 位于段落行首/行尾时, 浏览器把 caret 贴到
        //  NodeView 第一个/最后一个可定位点; 此前该点是 icon / 末尾文字,
        //  caret 视觉上 "穿入图标" 或 "贴卡片右边缘". 改为在 wrapper 内、
        //  card 前后各塞一个零宽空格文本节点, caret 自然落在文本节点上,
        //  与卡片边缘不再重叠.
        //  - 必须是 TextNode (createTextNode), <span> 不行——
        //    span 的边缘问题与 icon 相同, caret 仍会贴其左/右边缘.
        //  - 零宽空格 U+200B 不可见、不占字宽, 视觉上无副作用.
        //  - wrapper 整体 contentEditable=false + user-select:none
        //    (见 editor-attachment-link.css), 用户无法选中或编辑.
        //  - ignoreMutation 返回 true, PM 不会把这段 DOM 视为内容变更.
        //  - 前后对称两个 spacer: 保证从左侧进卡片 (← / Home) 与从右侧
        //    出卡片 (→ / End) 时 caret 着陆点一致, 与 note-reference 同源.
        const caretSpacerLeading = document.createTextNode('​');
        const caretSpacerTrailing = document.createTextNode('​');
        wrapper.appendChild(caretSpacerLeading);
        wrapper.appendChild(card);
        wrapper.appendChild(caretSpacerTrailing);

        wrapper.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const pos = this.getPos?.();
            if (pos === undefined) return;

            setInlineAtomTextSelectionFromMouse({
                view: this.view,
                node: this.node,
                pos,
                event: e,
                referenceElement: card,
            });
            this.suppressNextClickSelection = true;
        });

        wrapper.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (e.detail >= 2) {
                this.suppressNextClickSelection = false;
                void this.saveAttachmentAs();
                return;
            }

            if (this.suppressNextClickSelection) {
                this.suppressNextClickSelection = false;
                return;
            }

            const pos = this.getPos?.();
            if (pos !== undefined) {
                const selection = NodeSelection.create(this.view.state.doc, pos);
                this.view.dispatch(this.view.state.tr.setSelection(selection));
            }
        });

        card.addEventListener('selectstart', (e) => {
            e.preventDefault();
        });

        return wrapper;
    }

    private async saveAttachmentAs(): Promise<void> {
        const { name, fileName, storageMode, storageKey } = this.node.attrs;
        if (storageMode !== 'attachment' || !storageKey) return;

        const suggestedName = String(name || fileName || 'attachment');
        try {
            const targetPath = await dialogs.saveFile(suggestedName);
            if (!targetPath) return;
            await dialogs.copyAttachmentFile(String(storageKey), targetPath);
        } catch (error) {
            console.error('[file-attachment] failed to save attachment:', error);
        }
    }

    private refreshCard(): void {
        // createCard() 返回的 wrapper 内含 caret spacer + card,
        // 只取出 card 与旧 card 替换, 避免破坏 wrapper 整体的 DOM 结构.
        const newCard = this.createCard().querySelector('.editor-file-attachment__card') as HTMLElement;
        if (!newCard) return;
        const oldCard = this.dom.querySelector('.editor-file-attachment__card');
        if (oldCard) this.dom.replaceChild(newCard, oldCard);
        else this.dom.appendChild(newCard);
    }

    update(node: ProseMirrorNode): boolean {
        if (node.type.name !== 'fileAttachment') return false;
        const nameChanged = node.attrs.name !== this.node.attrs.name;
        const urlChanged = node.attrs.url !== this.node.attrs.url;
        this.node = node;
        if (nameChanged || urlChanged) this.refreshCard();
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

    deleteNode(): void {
        const { state, dispatch } = this.view;
        const pos = this.getPos?.();
        if (pos === undefined) return;
        const tr = state.tr.delete(pos, pos + this.node.nodeSize);
        dispatch(tr);
    }

    stopEvent(event: Event): boolean {
        const target = event.target as HTMLElement;
        if (!target.closest('.editor-file-attachment')) return false;
        if (event.type.startsWith('composition')) return false;
        return true;
    }

    ignoreMutation(_mutation: ViewMutationRecord): boolean {
        return true;
    }
}

// 鈹€鈹€鈹€ FileAttachment Node 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export const FileAttachment = Node.create({
    name: 'fileAttachment',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: true,
    
    
    addAttributes() {
        return {
            url:         { default: null },
            name:        { default: null },
            fileName:    { default: null },
            mimeType:    { default: null },
            size:        { default: 0 },
            storageMode: { default: null },
            storageKey:  { default: null },
        };
    },

    parseHTML() {
        return [{
            tag: 'span[data-file-attachment]',
            getAttrs: (element: HTMLElement) => {
                if (!(element instanceof HTMLElement)) return false;
                const rawSize = element.getAttribute('data-size');
                return {
                    url:         element.getAttribute('data-url'),
                    name:        element.getAttribute('data-name'),
                    fileName:    element.getAttribute('data-file-name'),
                    mimeType:    element.getAttribute('data-mime'),
                    size:        rawSize != null ? Number(rawSize) : 0,
                    storageMode: element.getAttribute('data-storage-mode'),
                    storageKey:  element.getAttribute('data-storage-key'),
                };
            },
        }];
    },

    renderHTML({ HTMLAttributes }) {
        const { url, name, storageMode, storageKey, fileName, mimeType, size, ...rest } = HTMLAttributes;
        const fileUrl = storageMode === 'attachment' && storageKey
            ? assetUrl(String(storageKey))
            : url ?? '';
        // DOM 形状与 createCard (NodeView) 对齐:
        //   wrapper [.editor-file-attachment]
        //     leading zero-width 文本 (caret spacer, 与 NodeView 一致)
        //     __card [.editor-file-attachment__card]
        //       icon (RiAttachment2 SVG, currentColor)
        //       __name (附件名)
        //     trailing zero-width 文本 (caret spacer, 与 NodeView 一致)
        // 嵌套 __card 才能让 CSS 的 .is-selected .editor-file-attachment__card
        // 选中背景匹配 (避免 round-trip 后选中背景失效).
        // 前后对称两个 spacer, 与 createCard 的 NodeView 保持一致, 保证
        // 文档从 HTML 解析回来时 caret 落点与编辑器实时渲染一致.
        return [
            'span',
            mergeAttributes(
                {
                    class: 'editor-file-attachment',
                    'data-file-attachment': 'true',
                    'data-url': fileUrl ?? '',
                    'data-name': name ?? '',
                    'data-file-name': fileName ?? '',
                    'data-mime': mimeType ?? '',
                    'data-size': size ?? 0,
                    'data-storage-mode': storageMode ?? '',
                    'data-storage-key': storageKey ?? '',
                },
                rest
            ),
            '​',
            [
                'span',
                { class: 'editor-file-attachment__card' },
                [
                    [
                        'svg',
                        {
                            xmlns: 'http://www.w3.org/2000/svg',
                            width: '15',
                            height: '15',
                            viewBox: '0 0 24 24',
                            fill: 'currentColor',
                        },
                    ],
                    ['path', { d: ATTACHMENT_ICON_PATH }],
                ],
                ['span', { class: 'editor-file-attachment__name' }, name ?? ''],
            ],
            '​',
        ];
    },

    addNodeView() {
        return (props) => new FileView(
            props.node,
            props.view,
            () => props.getPos?.() ?? 0,
            props.decorations
        );
    },

    onCreate() {
        const tr = removeHardBreaksAroundFileAttachments(this.editor.state);
        if (tr?.docChanged) {
            this.editor.view.dispatch(tr);
        }
    },

    addProseMirrorPlugins() {
        return [
            new Plugin({
                props: {
                    decorations: (state) => createTerminalInlineAtomCaretDecorations(state.doc, 'fileAttachment'),
                },
                appendTransaction: (transactions, _oldState, newState) => {
                    if (!transactions.some(transaction => transaction.docChanged)) return null;
                    return removeHardBreaksAroundFileAttachments(newState);
                },
            }),
        ];
    },

    addKeyboardShortcuts() {
        return {
            Backspace: () => {
                const { selection } = this.editor.state;
                const { $from } = selection;
                if ($from.nodeBefore?.type.name === 'fileAttachment') {
                    const from = $from.pos - $from.nodeBefore.nodeSize;
                    const to = $from.pos;
                    this.editor.commands.deleteRange({ from, to });
                    return true;
                }
                return false;
            },
            Delete: () => {
                const { selection } = this.editor.state;
                const { $from } = selection;
                if ($from.nodeAfter?.type.name === 'fileAttachment') {
                    const from = $from.pos;
                    const to = $from.pos + $from.nodeAfter.nodeSize;
                    this.editor.commands.deleteRange({ from, to });
                    return true;
                }
                return false;
            },
        };
    },

    markdownTokenizer: {
        name: 'fileAttachment',
        level: 'inline' as const,
        start(src: string) {
            const assetLink = /\[[^\]]*\]\((?:asset:\/\/|https?:\/\/asset\.localhost\/)/.exec(src);
            return assetLink?.index ?? -1;
        },
        tokenize(src: string): any {
            const closeBracket = src.indexOf(']');
            if (!src.startsWith('[') || closeBracket === -1 || src[closeBracket + 1] !== '(') {
                return undefined;
            }

            const destination = readMarkdownLinkDestination(src, closeBracket + 1);
            if (!destination || !isAttachmentMarkdownUrl(destination.url)) return undefined;

            return {
                type: 'fileAttachment',
                raw: src.slice(0, destination.end + 1),
                url: destination.url,
                title: src.slice(1, closeBracket),
            };
        },
    },

    parseMarkdown: parseFileAttachmentMarkdown,

    renderMarkdown: renderFileAttachmentMarkdown,
});
