import type { EditorLinkContext } from '@features/editor/editor-link-resolution';
// Wiki cards persist as notebook-local relative note paths; other targets use Markdown links.

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView } from '@tiptap/pm/view';
import { Node, nodeInputRule, nodePasteRule, type InputRuleMatch, type JSONContent, type PasteRuleMatch } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

import { openNoteByPhysicalPath } from '@features/memo/public/note-navigation-api';
import { listNoteReferenceCandidates } from '@features/editor/extensions/note-mention/note-mention-data';
import { stripMdSuffix } from '@features/editor/extensions/note-link/markdown';
import {
  attrsFromMarkdownNoteLink, attrsFromWikiNoteLink, attrsFromLegacyNoteTag,
  parseMarkdownNoteLinkAtStart, parseWikiNoteLinkAtStart, noteReferenceMarkdownSpec,
  type NoteReferenceAttrs, type ParsedWikiNoteLink,
} from './note-reference-markdown';
export type { NoteReferenceAttrs } from './note-reference-markdown';
export { parseWikiNoteLinkAtStart, splitObsidianTarget } from './note-reference-markdown';
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
import { files, notes as notesClient } from '@platform/tauri/client';
import type { NoteEntry } from '@platform/tauri/client/notes';
import { useNoteStore } from '@features/memo/store/note-store';
import { resolveNoteReference, resolveNoteReferenceTarget, renderNoteReferenceMarkdown, noteReferenceMarkdownNode, wikiReferencePath, type NoteReferenceContext } from './note-reference-path';
import { prepareLocalLinkNavigation } from '@features/editor/local-link-navigation';
import { displayTitleFromFilename } from '@/lib/utils';
import { resolveDocumentRelativeHref } from '@/lib/document-relative-path';
import { formatDocumentPathReference } from '@/lib/document-resource-context';
import { createNoteContentIconElement } from '@features/content/public/content-api';
import { toast } from '@/lib/toast';
import {
  NoteReferencePreviewController,
  type NoteReferencePreviewData,
} from '@features/editor/extensions/note-link/note-reference-preview-controller';


// ─── Attrs ────────────────────────────────────────────────────────────────────

function noteReferenceDisplayTitle(attrs: NoteReferenceAttrs): string {
  if (attrs.relativePath) return displayTitleFromFilename(attrs.relativePath);
  if (attrs.originalPath) return displayTitleFromFilename(attrs.originalPath);
  return stripMdSuffix(attrs.title || '');
}

function tKey(key: I18nKey, params?: Record<string, string | number>): string {
  return translate(getCurrentAppLanguage(), key, params);
}

/**
 * Notebook that owns the document a note reference is written in.
 *
 * Same-notebook references carry no notebook key, so both serialization and
 * reading need this to know what `relativePath` is relative to.
 */
export type OwnerNotebookIdProvider = () => string | null | undefined;

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

/** 双击会连发两次 click, 这个窗口内的重复"打开"只认第一次。 */
const OPEN_BURST_GUARD_MS = 400;

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
  /** 最近一次"打开目标"的时间戳, 用于吞掉双击带来的第二次 click。 */
  private lastOpenAt = 0;
  private previewController: NoteReferencePreviewController | null = null;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: (() => number | undefined) | undefined,
    private readonly presentation: 'document' | 'composer',
    private readonly getOwnerNotebookId: OwnerNotebookIdProvider | undefined,
    private readonly getDocumentPath: (() => string | undefined) | undefined,
    private readonly getReferenceContext: (() => NoteReferenceContext) | undefined,
    private readonly getLinkContext: (() => EditorLinkContext | undefined) | undefined,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = this.createCard();
    if (this.presentation === 'document') queueMicrotask(() => { void this.normalizeLink(); });
    if (this.presentation === 'composer') {
      this.previewController = new NoteReferencePreviewController({
        anchor: this.dom,
        getLocatorKey: () => this.previewLocatorKey(),
        getFallbackTitle: () => noteReferenceDisplayTitle(this.node.attrs as NoteReferenceAttrs)
          || tKey('editor.noteLink.untitled'),
        loadData: () => this.loadNotePreviewData(),
        openNote: async (data) => {
          await openNoteByPhysicalPath(data.filePath, data.heading, { destination: 1 });
        },
        t: (key) => tKey(key),
        onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  /** Convert old/general references to the same link mark used by authored Markdown. */
  private async normalizeLink(): Promise<void> {
    if (this.destroyed || !this.view.state.schema.marks.link) return;
    const attrs = this.node.attrs as NoteReferenceAttrs;
    const key = this.previewLocatorKey();
    let link = noteReferenceMarkdownNode(attrs, this.referenceContext());
    if (attrs.linkStyle === 'wiki' && attrs.linkTarget) {
      const context = this.referenceContext();
      const notePath = wikiReferencePath(attrs, context.documentPath);
      const rawPath = resolveDocumentRelativeHref(attrs.linkTarget, context.documentPath)?.path;
      try {
        // Probe the note first; only then fall back to a literal directory/file.
        const note = notePath ? await files.resolveLocation(notePath) : null;
        const actual = note?.isDirectory != null ? note
          : rawPath && rawPath !== notePath ? await files.resolveLocation(rawPath) : null;
        if (actual?.isDirectory === false && actual.path !== notePath) {
          link = noteReferenceMarkdownNode({ ...attrs, linkStyle: 'flowix', linkTarget: null,
            originalPath: actual.path, notebookId: actual.notebookId ?? null, relativePath: null }, context) ?? link;
        }
        if (actual?.isDirectory === true
          || (actual?.isDirectory === false && !/\.(md|markdown)$/i.test(actual.path))) {
          const href = formatDocumentPathReference({ path: actual.path, anchor: attrs.heading,
            ...(actual.isDirectory ? { isDirectory: true } : {}) }, context.documentPath, context.notebooks);
          link = { type: 'text', text: attrs.title || attrs.linkTarget,
            marks: [{ type: 'link', attrs: { href } }] };
        }
      } catch { /* Unavailable targets retain their authored spelling. */ }
    }
    if (!link || this.destroyed || key !== this.previewLocatorKey()) return;
    const pos = this.getPos?.();
    if (pos === undefined || this.view.state.doc.nodeAt(pos) !== this.node) return;
    this.view.dispatch(this.view.state.tr.replaceWith(pos, pos + this.node.nodeSize,
      this.view.state.schema.nodeFromJSON(link)).setMeta('addToHistory', false));
  }

  /** Notebook that owns this document, when the host can supply one. */
  private ownerNotebookId(): string | null {
    return this.getReferenceContext?.().notebookId ?? this.getOwnerNotebookId?.() ?? null;
  }

  private createCard(): HTMLElement {
    // notebookName 不再用于渲染 (见下方 nameSpan 注释), 仍在 attrs 里保留;
    // 这里只解构 UI 需要的字段.
    const { notebookId, relativePath, notebookName, originalPath, linkTarget, heading, stale } = this.node.attrs as NoteReferenceAttrs;

    // 视觉 stale 判定:
    //   - 已 stale (applyAttrs 写入) → 视觉 stale
    const hasTarget = Boolean(relativePath && (notebookId || notebookName || this.ownerNotebookId()))
      || Boolean(originalPath || linkTarget)
      || Boolean(heading && !notebookId && !relativePath);
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

    // Composer mention 使用文件树里的笔记图标；正文引用仍显示跳转图标。
    const icon = document.createElement('span');
    icon.className = 'note-reference__icon';
    if (this.presentation === 'composer') {
      icon.append(createNoteContentIconElement({ width: 14, height: 14 }));
    } else {
      icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square-arrow-up-right-exit preview-icon" aria-hidden="true"><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/></svg>`;
    }

    // 只展示文件名，保持首次渲染与载入笔记本元数据后的布局一致。
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
        // 正文里单击即打开目标文档 (原来是双击): 引用本身就是"跳转",
        // 单击不再只是把节点选中, 因此也不会再闪一下选中底。
        if (this.presentation !== 'composer') {
          void this.openTarget();
          return;
        }
        this.selectOnClick();
        this.previewController?.toggle();
      },
      // Composer 里的 chip 单击是"预览卡片", 双击才打开笔记, 保持原行为。
      ...(this.presentation === 'composer'
        ? { onDoubleClick: () => { void this.openTarget(); } }
        : {}),
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
      attrs.heading ?? '',
      this.getDocumentPath?.() ?? this.getReferenceContext?.().documentPath ?? '',
    ]);
  }

  private referenceContext(): NoteReferenceContext {
    return this.getReferenceContext?.() ?? {
      documentPath: this.getDocumentPath?.() ?? '',
      notebookId: this.ownerNotebookId() ?? undefined,
      notebooks: useNoteStore.getState().notebooks,
    };
  }

  private async resolveTarget() {
    const attrs = this.node.attrs as NoteReferenceAttrs;
    const target = resolveNoteReference(attrs, this.referenceContext());
    if (target.kind === 'path') return target;
    if (target.kind === 'unresolved' && target.reason === 'notebook-unavailable'
      && (attrs.notebookId || attrs.notebookName || this.ownerNotebookId())) {
      await useNoteStore.getState().loadNotebooks();
    }
    return resolveNoteReferenceTarget(attrs, this.referenceContext(), listNoteReferenceCandidates);
  }

  private async loadNotePreviewData(): Promise<NoteReferencePreviewData | null> {
    const target = await this.resolveTarget();
    if (!target || await notesClient.pathStatus(target.path) === 'missing') return null;
    const location = await notesClient.resolveLocation(target.path).catch(() => null);
    let entry: NoteEntry | null = null;
    if (location?.notebookId && location.relativePath) {
      entry = await notesClient.getIndexed(location.notebookId, location.relativePath).catch(() => null);
    }
    return {
      title: entry?.title || noteReferenceDisplayTitle(this.node.attrs as NoteReferenceAttrs) || tKey('editor.noteLink.untitled'),
      preview: entry?.preview ?? '', thumbnail: entry?.thumbnail ?? null,
      filePath: target.path, heading: target.heading,
    };
  }

  private selectOnClick(): void {
    // 键盘触发的 click 没有前置 mousedown, 仍保留节点选中语义。
    const pos = this.getPos?.();
    if (pos !== undefined) {
      const sel = NodeSelection.create(this.view.state.doc, pos);
      this.view.dispatch(this.view.state.tr.setSelection(sel));
    }
  }

  /**
   * 打开引用指向的文档 (正文单击 / Composer 双击共用)。
   *
   * 400ms 内的重复触发只认第一次: 浏览器双击会连发两次 click, 单击即打开的
   * 语义下第二次不能把同一篇文档再打开一遍。
   */
  private async openTarget(): Promise<void> {
    const now = Date.now();
    if (now - this.lastOpenAt < OPEN_BURST_GUARD_MS) return;
    this.lastOpenAt = now;

    const attrs = this.node.attrs as NoteReferenceAttrs;
    const locatorKey = this.previewLocatorKey();
    const isCurrentTarget = () => !this.destroyed && locatorKey === this.previewLocatorKey();

    try {
      // 跨文档锚点随打开流程发布定位请求（与 Agent 链接同一通道，slug 归一化
      // 在发布出口统一完成）；仅当引用不带任何目标字段（如 `[[#标题]]` 指向
      // 本文档）时才在当前编辑器内滚动。
      const sameDocumentHeading = Boolean(attrs.heading)
        && !attrs.linkTarget && !attrs.notebookId && !attrs.relativePath && !attrs.originalPath;
      const target = await this.resolveTarget();
      if (!isCurrentTarget()) return;
      if (target) {
        let path = target.path;
        if (this.presentation === 'document') {
          const context = this.referenceContext();
          const fallbackPath = attrs.linkStyle === 'wiki' && attrs.linkTarget
            ? resolveDocumentRelativeHref(attrs.linkTarget, context.documentPath)?.path : undefined;
          const localTarget = { path, anchor: target.heading, ...(fallbackPath ? { fallbackPath } : {}) };
          const navigation = this.getLinkContext?.();
          if (navigation?.openLocalPath) {
            await navigation.openLocalPath(localTarget);
            return;
          }
          const prepared = await prepareLocalLinkNavigation(localTarget, context.documentPath, {
            notebooks: context.notebooks, isCurrent: isCurrentTarget,
          });
          if (!prepared || !isCurrentTarget()) return;
          if (prepared.isCurrentDocument && !target.heading) return;
          path = prepared.location.path;
        }
        await openNoteByPhysicalPath(path, target.heading);
      } else if (sameDocumentHeading) {
        toast.info(tKey('editor.link.currentDocument'));
        const slug = new GithubSlugger().slug(attrs.heading!);
        let attempts = 0;
        const navigate = () => {
          if (!isCurrentTarget() || navigateToHeadingAnchor(this.view.dom, `#${slug}`)) return;
          attempts += 1;
          if (attempts < 10) window.setTimeout(navigate, 50);
        };
        window.setTimeout(navigate, 0);
      } else {
        this.applyAttrs({ stale: true });
        return;
      }
      if (isCurrentTarget() && attrs.stale) {
        this.applyAttrs({ stale: false });
      }
    } catch (err) {
      if (!isCurrentTarget()) return;
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
      if (this.presentation === 'document') queueMicrotask(() => { void this.normalizeLink(); });
    }
    return true;
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

export interface NoteReferenceOptions {
  /** Notebook owning the document being serialized. */
  getOwnerNotebookId?: OwnerNotebookIdProvider;
  getDocumentPath?: () => string | undefined;
  getReferenceContext?: () => NoteReferenceContext;
  getLinkContext?: () => EditorLinkContext | undefined;
}

/**
 * `renderMarkdown` is invoked without tiptap's extension context (no
 * `this.options`), so the owning notebook is captured in this closure instead
 * of being read from mutable application state during serialization.
 */
export function createNoteReferenceExtension(
  presentation: 'document' | 'composer',
  { getOwnerNotebookId, getDocumentPath, getReferenceContext, getLinkContext }: NoteReferenceOptions = {},
) {
  const context = (): NoteReferenceContext => getReferenceContext?.() ?? {
    documentPath: getDocumentPath?.() ?? '', notebookId: getOwnerNotebookId?.() ?? undefined,
    notebooks: useNoteStore.getState().notebooks,
  };
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
          getAttrs: (el: HTMLElement) => attrsFromLegacyNoteTag(name => el.getAttribute(name), el.textContent ?? ''),
        },
      ];
    },

    renderHTML({ node }) {
      const a = node.attrs as NoteReferenceAttrs;
      const referenceContext = context();
      const target = resolveNoteReference(a, referenceContext);
      const transferPath = a.linkStyle === 'wiki'
        ? wikiReferencePath(a, referenceContext.documentPath) ?? (target.kind === 'path' ? target.path : '')
        : target.kind === 'path' ? target.path : '';
      return [
        'note',
        {
          'data-note-path': transferPath,
          'data-note-target': a.linkTarget ?? '',
          'data-note-style': a.linkStyle,
          'data-note-heading': a.heading ?? '',
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
      return renderNoteReferenceMarkdown((node?.attrs ?? {}) as NoteReferenceAttrs, context());
    },

    // ─── NodeView ─────────────────────────────────────────────────────────────

    addNodeView() {
      return ({ node, view, getPos }) => new NoteReferenceView(
        node,
        view,
        getPos as () => number | undefined,
        presentation,
        getOwnerNotebookId,
        getDocumentPath,
        getReferenceContext,
        getLinkContext,
      );
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
