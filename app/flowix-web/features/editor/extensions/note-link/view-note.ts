// Markdown form: [title](flowix://open?b=...&f=...).

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView } from '@tiptap/pm/view';
import { Node, nodeInputRule, nodePasteRule, type InputRuleMatch, type JSONContent, type PasteRuleMatch } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

import { noteLinkForIndexedPath } from '@features/editor/extensions/note-link/memo-resolver';
import { openNoteByNotebookPath, openNoteByPhysicalPath } from '@features/memo/public/note-navigation-api';
import { queryMentionNotes } from '@features/editor/extensions/note-mention/note-mention-data';
import { parseBooleanAttr, splitDisplay, stripMdSuffix } from '@features/editor/extensions/note-link/markdown';
import {
  attrsFromMarkdownNoteLink, attrsFromWikiNoteLink, escapeMarkdownLinkText,
  parseMarkdownNoteLinkAtStart, parseWikiNoteLinkAtStart, noteReferenceMarkdownSpec,
  type NoteReferenceAttrs, type ParsedWikiNoteLink,
} from './note-reference-markdown';
export type { NoteReferenceAttrs } from './note-reference-markdown';
export { isRelativeNoteDestination, parseWikiNoteLinkAtStart, splitObsidianTarget } from './note-reference-markdown';
import { translate, type I18nKey } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { createInlineAtomMaintenancePlugin, removeHardBreaksAroundInlineAtoms } from '@features/editor/extensions/shared/inline-atom-maintenance';
import {
  createInlineAtomCloseIcon,
  createInlineAtomNodeView,
  deleteInlineAtomNode,
  deleteAdjacentInlineAtom,
  setInlineAtomNodeViewSelected,
} from '@features/editor/extensions/shared/inline-atom-nodeview';
import { navigateToHeadingAnchor } from '@features/editor/components/heading-anchor-navigation';
import GithubSlugger from 'github-slugger';
import { notes as notesClient } from '@platform/tauri/client';
import type { NoteEntry } from '@platform/tauri/client/notes';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import { buildNoteOpenLink } from '@platform/open-target/path-link';
import { displayTitleFromFilename } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  NoteReferencePreviewController,
  type NoteReferencePreviewData,
} from '@features/editor/extensions/note-link/note-reference-preview-controller';

// ─── Attrs ────────────────────────────────────────────────────────────────────

function noteReferenceDisplayTitle(attrs: NoteReferenceAttrs): string {
  if (attrs.relativePath) return displayTitleFromFilename(attrs.relativePath);
  if (attrs.linkTarget?.startsWith('flowix://open?')) {
    try {
      const url = new URL(attrs.linkTarget);
      const file = url.searchParams.get('f') ?? url.searchParams.get('file') ?? url.searchParams.get('relativePath') ?? url.searchParams.get('path');
      if (file) return displayTitleFromFilename(file);
    } catch { /* Keep the authored label for malformed links. */ }
  }
  if (attrs.originalPath) return displayTitleFromFilename(attrs.originalPath);
  return stripMdSuffix(attrs.title || '');
}

function tKey(key: I18nKey, params?: Record<string, string | number>): string {
  return translate(getCurrentAppLanguage(), key, params);
}

function findLastMarkdownNoteLink(text: string): InputRuleMatch | null {
  let found: InputRuleMatch | null = null;

  for (let index = text.indexOf('['); index >= 0; index = text.indexOf('[', index + 1)) {
    const parsed = parseMarkdownNoteLinkAtStart(text.slice(index));
    if (!parsed) continue;
    if (index + parsed.raw.length !== text.length) continue;

    found = {
      index,
      text: parsed.raw,
      data: { title: parsed.text, href: parsed.href },
    };
  }

  return found;
}

function findMarkdownNotePasteMatches(text: string): PasteRuleMatch[] {
  const matches: PasteRuleMatch[] = [];

  for (let index = text.indexOf('['); index >= 0; index = text.indexOf('[', index + 1)) {
    const parsed = parseMarkdownNoteLinkAtStart(text.slice(index));
    if (!parsed) continue;

    matches.push({
      index,
      text: parsed.raw,
      data: { title: parsed.text, href: parsed.href },
    });
  }

  return matches;
}

function findLastWikiNoteLink(text: string): InputRuleMatch | null {
  const index = text.lastIndexOf('[[');
  if (index < 0) return null;
  const parsed = parseWikiNoteLinkAtStart(text.slice(index));
  if (!parsed || index + parsed.raw.length !== text.length) return null;
  return { index, text: parsed.raw, data: parsed };
}

function findWikiNotePasteMatches(text: string): PasteRuleMatch[] {
  const matches: PasteRuleMatch[] = [];
  for (let index = text.indexOf('[['); index >= 0; index = text.indexOf('[[', index + 2)) {
    const parsed = parseWikiNoteLinkAtStart(text.slice(index));
    if (parsed) matches.push({ index, text: parsed.raw, data: parsed });
  }
  return matches;
}

// ─── NodeView ─────────────────────────────────────────────────────────────────

class NoteReferenceView implements ProseMirrorNodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;
  private node: ProseMirrorNode;
  private view: EditorView;
  private getPos: (() => number | undefined) | undefined;
  /** 节点已销毁标记. 异步 refresh 跑完后写回 doc 时如果发现 destroyed,
   * 立即放弃 dispatch, 避免 dispatch 到已死的 view 触发 PM 内部错误,
   * 或把 attrs 写到错的 noteReference 节点 (pos 处已被别的节点占据). */
  private destroyed = false;
  private previewController: NoteReferencePreviewController | null = null;

  constructor(node: ProseMirrorNode, view: EditorView, getPos: (() => number | undefined) | undefined, private readonly presentation: 'document' | 'composer') {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = this.createCard();
    if (this.presentation === 'composer') {
      this.previewController = new NoteReferencePreviewController({
        anchor: this.dom,
        getLocatorKey: () => this.previewLocatorKey(),
        getFallbackTitle: () => noteReferenceDisplayTitle(this.node.attrs as NoteReferenceAttrs)
          || tKey('editor.noteLink.untitled'),
        loadData: () => this.loadNotePreviewData(),
        openNote: async (data) => {
          await openNoteByNotebookPath(
            data.notebookId,
            data.relativePath,
            null,
            { destination: 1 },
          );
        },
        t: (key) => tKey(key),
        onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
      });
    }

    // mount 时按笔记本和相对路径校验目标是否仍存在.
  }

  private createCard(): HTMLElement {
    // notebookName 不再用于渲染 (见下方 nameSpan 注释), 仍在 attrs 里保留;
    // 这里只解构 UI 需要的字段.
    const { notebookId, relativePath, notebookName, originalPath, linkTarget, stale } = this.node.attrs as NoteReferenceAttrs;

    // 视觉 stale 判定:
    //   - 已 stale (applyAttrs 写入) → 视觉 stale
    const hasTarget = Boolean((notebookId || notebookName) && relativePath)
      || Boolean(originalPath || linkTarget);
    const effectiveStale = stale || !hasTarget;

    // 外层 wrapper: 与 .editor-file-attachment 同结构 (display:inline),
    // 内部 __card 是真正的"卡片" — 拿 hover/selected 高亮
    // draggable="true": 与 Node 定义里的 `draggable: true` 配套, 显式标到
    // DOM 上后 ProseMirror 才会把这个 NodeView 当作可拖动源 (PM 内部
    // 通过 wrapper 的 `draggable` 属性识别拖拽起点), 否则在 inline atom
    // 上鼠标按住拖动只会触发选区, 不会启动 DnD 流.
    const wrapper = document.createElement('span');
    wrapper.className = 'editor-note-reference';
    // NoteReference remains the single source of truth for note path,
    // path validation, and navigation. Only its composer surface gets a
    // presentation modifier, so Agent chips cannot leak into document links.
    if (this.presentation === 'composer') {
      wrapper.classList.add('agent-composer__note-reference', 'agent-composer__inline-atom-wrapper');
    }
    wrapper.contentEditable = 'false';
    wrapper.draggable = true;

    const card = document.createElement('span');
    card.className = 'note-reference__card';
    card.setAttribute('data-stale', effectiveStale ? 'true' : 'false');
    if (this.presentation === 'composer') {
      card.setAttribute('aria-haspopup', 'dialog');
      card.setAttribute('aria-expanded', 'false');
    }
    if (originalPath) {
      card.setAttribute('title', effectiveStale ? tKey('editor.noteLink.stale', { path: originalPath }) : originalPath);
    }

    // 使用侧边栏默认文档图标的 SVG 路径, 内联渲染以避免依赖 React。
    const icon = document.createElement('span');
    icon.className = 'note-reference__icon';
    icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true"><g transform="matrix(0.6923077 0 0 0.6923077 0.6923077 0.6923077)"><line x1="7.6666" y1="11.36" x2="10.3333" y2="11.36" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" vector-effect="non-scaling-stroke"/><line x1="7.6666" y1="15.18" x2="16.3333" y2="15.18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" vector-effect="non-scaling-stroke"/><path d="M 3.6667 19 V 5 c 0 -1.4733 1.1933 -2.6667 2.6667 -2.6667 h 7.448 c 0.3533 0 0.6933 0.14 0.9427 0.3907 l 5.2187 5.2187 c 0.2507 0.2507 0.3907 0.5893 0.3907 0.9427 v 10.1146 c 0 1.4733 -1.1933 2.6667 -2.6667 2.6667 H 6.3333 c -1.4733 0 -2.6667 -1.1933 -2.6667 -2.6667 Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" vector-effect="non-scaling-stroke"/><path d="M 20.2133 8.3333 h -4.5467 c -0.736 0 -1.3333 -0.5973 -1.3333 -1.3333 V 2.4693" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" vector-effect="non-scaling-stroke"/></g></svg>`;

    // 名称 = `title` 单段。
    //
    // 历史: 早期是 `notebookName > title` 三段 (notebook muted / chevron /
    // title primary), notebookName 拿 nbSpan, chevron 拿 inline SVG, title
    // 拿 titleSpan; 但 notebookName 在大量 round-trip 路径下 (markdown 解析、
    // refreshMemoAttrs 异步补齐之前) 都为空, 导致刷新加载后会发生一次
    // "title-only → 三段" 的 DOM 替换 (createCard 在 update() 里被再跑一遍),
    // 视觉抖动 + caret 落点抖动. 简化为单段后, 新增 / 刷新两条路径首次
    // 渲染就一致, 后续 refresh 即便补到 notebookName 也不影响渲染.
    //
    // 仍保留 notebookName 在 attrs 里 (markdown round-trip / 双击跳转跨笔记本
    // 都还要用), 只是 UI 层不再展示.
    const nameSpan = document.createElement('span');
    nameSpan.className = 'note-reference__name';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'note-reference__title';
    titleSpan.textContent = noteReferenceDisplayTitle(this.node.attrs as NoteReferenceAttrs) || tKey('editor.noteLink.untitled');
    nameSpan.appendChild(titleSpan);

    card.appendChild(icon);
    card.appendChild(nameSpan);

    // 失效标签: stale 视觉信号在降低 opacity 的同时追加一段
    // "（已失效）" 文字, 让用户在不 hover 的情况下也能直接读到链接状态.
    // 用独立 span 包起来, 避免继承 __name 的 font-weight/换行属性.
    if (effectiveStale) {
      const staleMark = document.createElement('span');
      staleMark.className = 'note-reference__stale-mark';
      staleMark.textContent = tKey('editor.noteLink.staleMark');
      card.appendChild(staleMark);
    }

    const inlineAtomNodeView = createInlineAtomNodeView({
      caretGeometry: wrapper.classList.contains('agent-composer__note-reference') ? 'single-line' : undefined,
      wrapper,
      wrapperClassName: wrapper.className,
      content: card,
      onClick: () => {
        this.selectOnClick();
        if (this.presentation === 'composer') this.previewController?.toggle();
      },
      onDoubleClick: () => { void this.handleDoubleClick(); },
      ...(this.presentation === 'composer' ? {
        hoverActions: [{
          ariaLabel: `移除笔记引用 ${noteReferenceDisplayTitle(this.node.attrs as NoteReferenceAttrs)}`,
          icon: createInlineAtomCloseIcon(),
          onClick: () => deleteInlineAtomNode(this.view, this.node, this.getPos),
        }],
      } : {}),
    });
    wrapper.draggable = true;
    return inlineAtomNodeView.dom;
  }

  private previewLocatorKey(): string {
    const attrs = this.node.attrs as NoteReferenceAttrs;
    return JSON.stringify([
      attrs.notebookId ?? '',
      attrs.notebookName ?? '',
      attrs.relativePath ?? '',
      attrs.originalPath ?? '',
      attrs.linkTarget ?? '',
    ]);
  }

  private async loadNotePreviewData(): Promise<NoteReferencePreviewData | null> {
    let attrs = this.node.attrs as NoteReferenceAttrs;
    let notebookId = attrs.notebookId;
    let relativePath = attrs.relativePath ?? null;
    let notebookPath: string | null = null;
    let location: Awaited<ReturnType<typeof notesClient.resolveLocation>> | null = null;
    let physicalPath = attrs.originalPath;
    let notebookName = attrs.notebookName;

    if (attrs.linkTarget && /^flowix:\/\/open\?/i.test(attrs.linkTarget)) {
      try {
        const url = new URL(attrs.linkTarget);
        notebookId ||= url.searchParams.get('notebookId');
        relativePath ||= url.searchParams.get('f') ?? url.searchParams.get('file') ?? url.searchParams.get('relativePath');
        notebookName ||= url.searchParams.get('b') ?? url.searchParams.get('book') ?? '';
        physicalPath ||= url.searchParams.get('path');
      } catch { /* Keep the authored attrs as fallback. */ }
    } else if (!physicalPath && attrs.linkTarget && /^\//.test(attrs.linkTarget)) {
      physicalPath = attrs.linkTarget;
    }

    if ((!notebookId || !relativePath) && physicalPath) {
      try {
        location = await notesClient.resolveLocation(physicalPath);
        notebookId ||= location?.notebookId;
        relativePath ||= location?.relativePath;
        notebookPath = location?.notebookPath ?? null;
      } catch { /* A missing note still gets a title-only preview. */ }
    }

    if (!notebookId || !relativePath) {
      // Relative wiki links may be resolved lazily by the same note-reference
      // resolver used when opening the chip. Re-read attrs after it completes.
      if (attrs.linkStyle === 'wiki' && attrs.linkTarget) {
        await this.refreshMemoAttrs();
        attrs = this.node.attrs as NoteReferenceAttrs;
        notebookId = attrs.notebookId;
        relativePath = attrs.relativePath ?? null;
      }
    }

    if (!notebookId && relativePath && notebookName) {
      let notebooks = useNoteStore.getState().notebooks;
      if (!notebooks.length) {
        await useNoteStore.getState().loadNotebooks();
        notebooks = useNoteStore.getState().notebooks;
      }
      const matches = notebooks.filter((item) => item.name === notebookName);
      if (matches.length === 1) notebookId = matches[0].id;
    }

    if (!notebookId || !relativePath) {
      return null;
    }

    let notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
    if (!notebook) {
      await useNoteStore.getState().loadNotebooks();
      notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
    }
    notebookPath ||= notebook?.path ?? null;
    const filePath = notebookPath ? joinNotebookMemoPath(notebookPath, relativePath) : null;
    if (!notebookPath || !filePath) {
      return null;
    }

    let entry: NoteEntry | null = null;
    try {
      entry = await notesClient.getIndexed(notebookId, relativePath);
    } catch { /* Render the saved reference title if the index is unavailable. */ }

    const data: NoteReferencePreviewData = {
      title: entry?.title || noteReferenceDisplayTitle(attrs) || tKey('editor.noteLink.untitled'),
      preview: entry?.preview ?? '',
      thumbnail: entry?.thumbnail ?? null,
      notebookId,
      relativePath,
      notebookPath,
      filePath,
    };
    return data;
  }

  private selectOnClick(): void {
    // 键盘触发的 click 没有前置 mousedown, 仍保留节点选中语义。
    const pos = this.getPos?.();
    if (pos !== undefined) {
      const sel = NodeSelection.create(this.view.state.doc, pos);
      this.view.dispatch(this.view.state.tr.setSelection(sel));
    }
  }

  private async handleDoubleClick(): Promise<void> {
    const attrs = this.node.attrs as NoteReferenceAttrs;
    if (attrs.linkTarget && /^flowix:\/\/memo\//i.test(attrs.linkTarget)) {
      this.applyAttrs({ stale: true });
      return;
    }

    try {
      // 跨文档锚点随打开流程发布定位请求（与 Agent 链接同一通道，slug 归一化
      // 在发布出口统一完成）；仅当引用不带任何目标字段（如 `[[#标题]]` 指向
      // 本文档）时才在当前编辑器内滚动。
      const sameDocumentHeading = Boolean(attrs.heading)
        && !attrs.linkTarget && !attrs.notebookId && !attrs.relativePath && !attrs.originalPath;
      if (attrs.notebookId && attrs.relativePath) {
        await openNoteByNotebookPath(attrs.notebookId, attrs.relativePath, attrs.heading);
      } else if (attrs.originalPath) {
        await openNoteByPhysicalPath(attrs.originalPath, attrs.heading);
      } else if (attrs.linkTarget) {
        await openNoteByPhysicalPath(attrs.linkTarget);
      } else if (sameDocumentHeading) {
        const slug = new GithubSlugger().slug(attrs.heading!);
        let attempts = 0;
        const navigate = () => {
          if (this.destroyed || navigateToHeadingAnchor(this.view.dom, `#${slug}`)) return;
          attempts += 1;
          if (attempts < 10) window.setTimeout(navigate, 50);
        };
        window.setTimeout(navigate, 0);
      } else {
        this.applyAttrs({ stale: true });
        return;
      }
      if (attrs.stale) {
        this.applyAttrs({ stale: false });
      }
    } catch (err) {
      this.applyAttrs({ stale: true });

      console.warn('[note-reference] open failed:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  private refreshCard(): void {
    // 与 fileAttachment 保持同一策略: attrs 更新时只替换内部 card,
    // 保留外层 wrapper、caret spacer 和 ProseMirror 对 NodeView DOM 的引用。
    const newCard = this.createCard().querySelector('.note-reference__card') as HTMLElement | null;
    if (!newCard) return;

    const oldCard = this.dom.querySelector('.note-reference__card');
    if (oldCard) {
      this.dom.replaceChild(newCard, oldCard);
      return;
    }

    this.dom.appendChild(newCard);
  }

  /**
   * 异步把新的 attrs 写回 doc。必须重新解析 pos, 因为 NodeView mount 时拿到的
   * getPos() 在校验返回时可能已经位移。
   */
  private applyAttrs(patch: Partial<NoteReferenceAttrs>): void {
    // 节点已销毁: 异步 refresh 跑完时 view 可能已死, dispatch 进去要么抛
    // 错要么把 attrs 写到错的节点 (pos 已被别的 noteReference 占据).
    if (this.destroyed) return;
    const pos = this.getPos?.();
    if (pos === undefined) return;
    // 防御: 检查该位置当前是不是仍然是本节点
    const nodeAtPos = this.view.state.doc.nodeAt(pos);
    if (!nodeAtPos || nodeAtPos.type.name !== 'noteReference') return;
    const { selection } = this.view.state;
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      ...patch,
    });
    tr.setSelection(selection.map(tr.doc, tr.mapping));
    // setMeta 'addToHistory' false: stale 校验是后台行为, 不进 undo 栈
    tr.setMeta('addToHistory', false);
    this.view.dispatch(tr);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'noteReference') return false;
    const previousKey = this.previewLocatorKey();
    this.node = node;
    this.refreshCard();
    this.previewController?.syncAnchorState();
    if (previousKey !== this.previewLocatorKey()) {
      this.previewController?.invalidate();
    }
    // update 触发场景: 文档被外部修改 / 切换 memo / undo-redo,
    // 节点 attrs 可能刚被改过, 仍跑一次异步校验兜底.
    return true;
  }

  /** Validate a note reference using its path target. */
  private refreshPromise: Promise<void> | null = null;

  refreshMemoAttrs(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    const initialAttrs = this.node.attrs as NoteReferenceAttrs;
    if (!initialAttrs.notebookId && !initialAttrs.notebookName && !initialAttrs.originalPath && !initialAttrs.linkTarget) {
      return Promise.resolve();
    }

    this.refreshPromise = (async () => {
      try {
        if (initialAttrs.notebookName && initialAttrs.relativePath && !initialAttrs.notebookId) {
          let notebooks = useNoteStore.getState().notebooks;
          if (!notebooks.some((item) => item.name === initialAttrs.notebookName)) {
            await useNoteStore.getState().loadNotebooks();
            notebooks = useNoteStore.getState().notebooks;
          }
          const matches = notebooks.filter((item) => item.name === initialAttrs.notebookName);
          const notebook = matches.length === 1 ? matches[0] : null;
          const path = notebook ? joinNotebookMemoPath(notebook.path, initialAttrs.relativePath) : null;
          const content = path ? await notesClient.readDocument(path) : null;
          this.applyAttrs({ notebookId: notebook?.id ?? null, stale: content === null });
          return;
        }
        if (initialAttrs.notebookId && initialAttrs.relativePath) {
          let notebook = useNoteStore.getState().notebooks.find((item) => item.id === initialAttrs.notebookId);
          if (!notebook) {
            await useNoteStore.getState().loadNotebooks();
            notebook = useNoteStore.getState().notebooks.find((item) => item.id === initialAttrs.notebookId);
          }
          const path = notebook ? joinNotebookMemoPath(notebook.path, initialAttrs.relativePath) : null;
          const content = path ? await notesClient.readDocument(path) : null;
          const stale = content === null;
          const current = this.node.attrs as NoteReferenceAttrs;
          if (current.stale !== stale || (notebook && current.notebookName !== notebook.name)) {
            this.applyAttrs({ stale, ...(notebook ? { notebookName: notebook.name } : {}) });
          }
          return;
        }
        if (initialAttrs.originalPath) {
          const content = await notesClient.readDocument(initialAttrs.originalPath);
          const stale = content === null;
          if ((this.node.attrs as NoteReferenceAttrs).stale !== stale) this.applyAttrs({ stale });
          return;
        }
        const target = initialAttrs.linkTarget!;
        let notebookId: string | null = null;
        let relativePath: string | null = null;
        if (/^flowix:\/\/open\?/i.test(target)) {
          const url = new URL(target);
          notebookId = url.searchParams.get('notebookId');
          relativePath = url.searchParams.get('f') ?? url.searchParams.get('file') ?? url.searchParams.get('relativePath');
          if ((!notebookId || !relativePath) && url.searchParams.get('path')) {
            const location = await notesClient.resolveLocation(url.searchParams.get('path')!);
            notebookId = location.notebookId;
            relativePath = location.relativePath;
          }
        } else {
          const basename = target.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') ?? target;
          const matches = await queryMentionNotes(basename);
          const normalized = target.replace(/\\/g, '/').toLocaleLowerCase();
          const match = matches.find((item) => item.relativePath.toLocaleLowerCase() === normalized
            || item.filename.toLocaleLowerCase() === `${normalized}.md`
            || item.title.toLocaleLowerCase() === normalized)
            ?? matches[0];
          notebookId = match?.notebookId ?? null;
          relativePath = match?.relativePath ?? null;
        }
        const current = this.node.attrs as NoteReferenceAttrs;
        if (!notebookId || !relativePath) {
          if (!current.stale) {
            this.applyAttrs({ stale: true });
          }
          return;
        }
        const patch: Partial<NoteReferenceAttrs> = {};
        if (current.notebookId !== notebookId) patch.notebookId = notebookId;
        if (current.relativePath !== relativePath) patch.relativePath = relativePath;
        if (current.stale) {
          patch.stale = false;
        }
        if (Object.keys(patch).length > 0) {
          this.applyAttrs(patch);
        }
      } catch (err) {

        console.warn('[note-reference] refresh failed:', err);
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  selectNode(): void {
    setInlineAtomNodeViewSelected(this.dom, true);
  }

  deselectNode(): void {
    setInlineAtomNodeViewSelected(this.dom, false);
  }

  stopEvent(event: Event): boolean {
    // 卡片内部事件不让 ProseMirror 接管, 但 composition 例外
    if (event.type.startsWith('composition')) return false;
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.previewController?.dispose();
    this.previewController = null;
  }
}

// ─── Node definition ──────────────────────────────────────────────────────────

function createNoteReferenceExtension(presentation: 'document' | 'composer') {
  return Node.create({
    name: 'noteReference',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: true,
    // 抢在 Markdown 扩展之前注册 tokenizer
    priority: 1000,

    addAttributes() {
      return {
        relativePath: { default: null },
        notebookId:   { default: null },
        notebookName: { default: '' },
        title:        { default: '' },
        originalPath: { default: null },
        linkStyle:    { default: 'flowix' },
        linkTarget:   { default: null },
        heading:      { default: null },
        stale:        { default: false },
      };
    },

    parseHTML() {
      return [
        {
          tag: 'note',
          getAttrs: (el: HTMLElement) => {
            const notebookId   = el.getAttribute('notebook') || null;
            const originalPath = el.getAttribute('path') || null;
            const relativePath = el.getAttribute('relativePath') || null;
            const stale        = parseBooleanAttr(el.getAttribute('stale'));
            const { notebookName, title } = splitDisplay(el.textContent ?? '');
            return { notebookId, relativePath, notebookName, title, originalPath, linkStyle: 'flowix', linkTarget: null, heading: null, stale };
          },
        },
      ];
    },

    renderHTML({ node }) {
      const a = node.attrs as NoteReferenceAttrs;
      return [
        'note',
        {
          notebook: a.notebookId ?? '',
          relativePath: a.relativePath ?? '',
          path: a.originalPath ?? '',
          ...(a.stale ? { stale: 'true' } : {}),
        },
        // 序列化时 strip title 后缀, 跟 NodeView 渲染一致; 旧 markdown
        // 历史里写 "foo.md" 也能正常 parse, 因为 splitDisplay 不剥后缀,
        // 但下次落盘会被统一成无后缀形式.
        `${a.notebookName || ''}${a.notebookName ? '/' : ''}${stripMdSuffix(a.title || '')}`,
      ];
    },

    // ─── Markdown round-trip ──────────────────────────────────────────────────
    // Path based Flowix links and authored note tags render as note cards.

    ...noteReferenceMarkdownSpec,

    renderMarkdown(node: JSONContent) {
      const a = (node?.attrs ?? {}) as NoteReferenceAttrs;
      const displayTitle = escapeMarkdownLinkText(noteReferenceDisplayTitle(a));
      if (a.linkStyle === 'wiki' && a.linkTarget) {
        const target = `${a.linkTarget}${a.heading ? `#${a.heading}` : ''}`;
        const naturalTitle = a.linkTarget.split('/').pop()?.replace(/\.md$/i, '') ?? a.linkTarget;
        return `[[${target}${a.title && a.title !== naturalTitle ? `|${a.title}` : ''}]]`;
      }
      if (a.linkStyle === 'markdown' && a.linkTarget) {
        const target = `${a.linkTarget}${a.heading ? `#${a.heading}` : ''}`.replace(/ /g, '%20');
        return `[${escapeMarkdownLinkText(a.title || stripMdSuffix(a.linkTarget))}](${target})`;
      }
      if (a.linkTarget && /^flowix:\/\/memo\//i.test(a.linkTarget)) {
        return `[${displayTitle}](${a.linkTarget})`;
      }
      if (a.relativePath) {
        const notebook = a.notebookId
          ? useNoteStore.getState().notebooks.find((item) => item.id === a.notebookId)
          : null;
        const book = notebook?.name ?? a.notebookName;
        if (book) {
          const target = buildNoteOpenLink(book, a.relativePath);
          return `[${displayTitle}](${target})`;
        }
        if (a.linkTarget) {
          return `[${displayTitle}](${a.linkTarget})`;
        }
        if (a.notebookId) {
          const target = `flowix://open?notebookId=${encodeURIComponent(a.notebookId)}&relativePath=${encodeURIComponent(a.relativePath)}`;
          return `[${displayTitle}](${target})`;
        }
      }
      if (a.linkTarget?.startsWith('flowix://open?') && !a.originalPath) {
        return `[${displayTitle}](${a.linkTarget})`;
      }
      const pathLink = a.originalPath ? noteLinkForIndexedPath(a.originalPath) : null;
      if (pathLink) {
        return `[${displayTitle}](${pathLink})`;
      }
      if (a.originalPath) {
        const fallback = `flowix://open?path=${encodeURIComponent(a.originalPath)}`;
        return `[${displayTitle}](${fallback})`;
      }
      return escapeMarkdownLinkText(stripMdSuffix(a.title || ''));
    },

    // ─── NodeView ─────────────────────────────────────────────────────────────

    addNodeView() {
      return ({ node, view, getPos }) => new NoteReferenceView(node, view, getPos as () => number | undefined, presentation);
    },

    // Normalize imported legacy content once, then maintain changed textblocks.
    onCreate() {
      const tr = removeHardBreaksAroundInlineAtoms(this.editor.state, ['noteReference']);
      if (tr?.docChanged) this.editor.view.dispatch(tr);
    },

    addProseMirrorPlugins() {
      return [createInlineAtomMaintenancePlugin(['noteReference'])];
    },

    addInputRules() {
      return [
        nodeInputRule({
          find: findLastWikiNoteLink,
          type: this.type,
          getAttributes: match => attrsFromWikiNoteLink(match.data as unknown as ParsedWikiNoteLink),
        }),
        nodeInputRule({
          find: findLastMarkdownNoteLink,
          type: this.type,
          getAttributes: match => attrsFromMarkdownNoteLink(
            String(match.data?.title ?? ''),
            String(match.data?.href ?? '')
          ),
        }),
      ];
    },

    addPasteRules() {
      return [
        nodePasteRule({
          find: findWikiNotePasteMatches,
          type: this.type,
          getAttributes: match => attrsFromWikiNoteLink(match.data as unknown as ParsedWikiNoteLink),
        }),
        nodePasteRule({
          find: findMarkdownNotePasteMatches,
          type: this.type,
          getAttributes: match => attrsFromMarkdownNoteLink(
            String(match.data?.title ?? ''),
            String(match.data?.href ?? '')
          ),
        }),
      ];
    },

    // ─── Keyboard ─────────────────────────────────────────────────────────────

    addKeyboardShortcuts() {
      return {
        Backspace: () => {
          return deleteAdjacentInlineAtom(this.editor, 'noteReference', 'before');
        },
        Delete: () => {
          return deleteAdjacentInlineAtom(this.editor, 'noteReference', 'after');
        },
      };
    },
  });
}

/** Document-editor note references. */
export const NoteReference = createNoteReferenceExtension('document');

/** Composer note references use a separate extension and plugin key. */
export const ComposerNoteReference = createNoteReferenceExtension('composer');
