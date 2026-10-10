// Markdown form: [title](flowix://open?b=...&f=...).

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView } from '@tiptap/pm/view';
import { DecorationSet } from '@tiptap/pm/view';
import { Node, nodeInputRule, nodePasteRule, type InputRuleMatch, type JSONContent, type MarkdownToken, type PasteRuleMatch } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';

import { readMarkdownLinkDestination } from '@features/editor/extensions/shared/markdown-link-destination';
import { noteLinkForIndexedPath, openNoteByNotebookPath, openNoteByPhysicalPath } from '@features/editor/extensions/note-link/memo-resolver';
import { queryMentionNotes } from '@features/editor/extensions/note-mention/note-mention-data';
import { parseBooleanAttr, pickAttr, splitDisplay, stripMdSuffix, unescapeHtml } from '@features/editor/extensions/note-link/markdown';
import { translate, type I18nKey } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { createTerminalInlineAtomCaretDecorations } from '@features/editor/extensions/shared/terminal-inline-atom-caret';
import { navigateToHeadingAnchor } from '@features/editor/components/heading-anchor-navigation';
import { decodeEditorHref } from '@features/editor/editor-link-resolution';
import GithubSlugger from 'github-slugger';
import { notes as notesClient } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import { buildNoteOpenLink } from '@platform/open-target/path-link';
import { displayTitleFromFilename } from '@/lib/utils';
import { toast } from '@/lib/toast';

// ─── Attrs ────────────────────────────────────────────────────────────────────

export interface NoteReferenceAttrs {
  memoId: string | null;
  notebookId: string | null;
  relativePath?: string | null;
  notebookName: string;
  title: string;
  originalPath: string | null;
  linkStyle: 'flowix' | 'wiki' | 'markdown';
  linkTarget: string | null;
  heading: string | null;
  /** 渲染态: memoId 缺失 或 后端按 memoId/originalPath 都解析不到时为 true;
   *  不写入 markdown */
  stale: boolean;
}

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

const FLOWIX_MEMO_URL_RE = /^flowix:\/\/(?:memo\/|open\?)/i;

// NodeView 不在 React 树内, 不能用 useI18n, 走 user-settings-store 直读当前语言。
function tKey(key: I18nKey, params?: Record<string, string | number>): string {
  return translate(getCurrentAppLanguage(), key, params);
}

type ParsedMarkdownNoteLink = {
  raw: string;
  text: string;
  href: string;
};

type ParsedWikiNoteLink = {
  raw: string;
  target: string;
  heading: string | null;
  title: string;
};

export function splitObsidianTarget(rawTarget: string): { target: string; heading: string | null } {
  const hash = rawTarget.indexOf('#');
  if (hash < 0) return { target: decodeEditorHref(rawTarget.trim()), heading: null };
  const target = decodeEditorHref(rawTarget.slice(0, hash).trim());
  // Also accept the commonly typed `## Heading`, while Obsidian itself uses
  // one `#` regardless of heading level.
  const heading = decodeEditorHref(rawTarget.slice(hash).replace(/^#+\s*/, '').trim());
  return { target, heading: heading || null };
}

export function parseWikiNoteLinkAtStart(src: string): ParsedWikiNoteLink | null {
  if (!src.startsWith('[[')) return null;
  const end = src.indexOf(']]', 2);
  if (end < 0 || src.slice(2, end).includes('\n')) return null;
  const body = src.slice(2, end);
  const aliasAt = body.indexOf('|');
  const rawTarget = aliasAt < 0 ? body : body.slice(0, aliasAt);
  const { target, heading } = splitObsidianTarget(rawTarget);
  if (!target) return null;
  const fallbackTitle = target.split('/').pop()?.replace(/\.md$/i, '') || target;
  return {
    raw: src.slice(0, end + 2),
    target,
    heading,
    title: (aliasAt < 0 ? fallbackTitle : body.slice(aliasAt + 1).trim()) || fallbackTitle,
  };
}

export function isRelativeNoteDestination(href: string): boolean {
  const value = href.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('#') || value.startsWith('?') || value.startsWith('//')) return false;
  return /\.md(?:#|$)/i.test(value) || /%20/i.test(value);
}

function findMarkdownLinkCloseBracket(src: string): number {
  for (let i = 1; i < src.length; i += 1) {
    const char = src[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '\n') return -1;
    if (char === ']') return i;
  }
  return -1;
}

function parseMarkdownNoteLinkAtStart(src: string): ParsedMarkdownNoteLink | null {
  if (!src.startsWith('[')) return null;
  const closeBracket = findMarkdownLinkCloseBracket(src);
  if (closeBracket < 0 || src[closeBracket + 1] !== '(') return null;

  const destination = readMarkdownLinkDestination(src, closeBracket + 1);
  if (!destination || !FLOWIX_MEMO_URL_RE.test(destination.url)) return null;

  return {
    raw: src.slice(0, destination.end + 1),
    text: src.slice(1, closeBracket),
    href: destination.url,
  };
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

function parseFlowixMemoHrefForAttrs(href: string): { memoId: string | null; stale: boolean } {
  if (/^flowix:\/\/open\?/i.test(href)) return { memoId: null, stale: false };
  return { memoId: null, stale: true };
}

function escapeMarkdownLinkText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function unescapeMarkdownLinkText(text: string): string {
  return text.replace(/\\([\\\[\]])/g, '$1');
}

function attrsFromMarkdownNoteLink(titleText: string, href: string): NoteReferenceAttrs {
  if (!FLOWIX_MEMO_URL_RE.test(href)) {
    const { target, heading } = splitObsidianTarget(href);
    return {
      memoId: null,
      notebookId: null,
      notebookName: '',
      title: unescapeMarkdownLinkText(titleText).trim(),
      originalPath: null,
      linkStyle: 'markdown',
      linkTarget: target,
      heading,
      stale: false,
    };
  }
  const parsed = parseFlowixMemoHrefForAttrs(href);
  let pathTarget: URL | null = null;
  if (/^flowix:\/\/open\?/i.test(href)) {
    try { pathTarget = new URL(href); } catch { /* malformed link stays stale */ }
  }
  return {
    memoId: parsed.memoId,
    notebookId: pathTarget?.searchParams.get('notebookId') ?? null,
    relativePath: pathTarget?.searchParams.get('f') ?? pathTarget?.searchParams.get('file') ?? pathTarget?.searchParams.get('relativePath') ?? null,
    notebookName: pathTarget?.searchParams.get('b') ?? pathTarget?.searchParams.get('book') ?? '',
    title: unescapeMarkdownLinkText(titleText).trim(),
    originalPath: null,
    linkStyle: 'flowix',
    linkTarget: href,
    // flowix://open 深链的 `#fragment` 是 GitHub-slug 标题锚点，与相对链接同语义。
    heading: pathTarget?.hash ? decodeEditorHref(pathTarget.hash.replace(/^#/, '').trim()) || null : null,
    stale: parsed.stale,
  };
}

function attrsFromWikiNoteLink(parsed: ParsedWikiNoteLink): NoteReferenceAttrs {
  return {
    memoId: null,
    notebookId: null,
    notebookName: '',
    title: parsed.title,
    originalPath: null,
    linkStyle: 'wiki',
    linkTarget: parsed.target,
    heading: parsed.heading,
    stale: false,
  };
}


// ─── HardBreak 清理 ───────────────────────────────────────────────────────────

/**
 * 删掉 noteReference 节点前后紧邻的 hardBreak 节点。
 *
 * 触发场景:用户在编辑器里按 Shift+Enter 硬换行(产生 hardBreak),然后在下一
 * 行粘贴物理路径 → 落盘 markdown 形如 `foo  \n<note ...>...</note>`。再次打
 * 开时,marked 把 hardBreak 和 noteReference 还原成 ProseMirror 节点,渲染时
 * hardBreak 强制占一行,视觉上卡片"头顶"多出一行空白。
 *
 * 另一类场景是卡片已经在块末尾,后面残留同块 hardBreak,视觉上表现为
 * "卡片末尾多一行"。这类同样需要清掉,否则重新打开/粘贴后仍会复现。
 *
 * 完全对照 fileAttachment 节点(`attachment-link/nodes/view-file.ts` 同名函数)
 * 的处理方式 — 二者都是 inline atom 节点,同样受 hardBreak 残留影响。
 */
function removeHardBreaksAroundNoteReferences(state: EditorState) {
  const deletions: Array<{ from: number; to: number }> = [];
  const seen = new Set<string>();

  const pushDeletion = (from: number, to: number) => {
    const key = `${from}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    deletions.push({ from, to });
  };

  state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (node.type.name !== 'noteReference') return;

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

const noteReferenceCaretPluginKey = new PluginKey<DecorationSet>('noteReferenceTerminalCaret');

// ─── NodeView ─────────────────────────────────────────────────────────────────

class NoteReferenceView implements ProseMirrorNodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;
  private node: ProseMirrorNode;
  private view: EditorView;
  private getPos: (() => number | undefined) | undefined;
  private clickHandler: (e: MouseEvent) => void;
  /** 节点已销毁标记. 异步 refresh 跑完后写回 doc 时如果发现 destroyed,
   * 立即放弃 dispatch, 避免 dispatch 到已死的 view 触发 PM 内部错误,
   * 或把 attrs 写到错的 noteReference 节点 (pos 处已被别的节点占据). */
  private destroyed = false;

  constructor(node: ProseMirrorNode, view: EditorView, getPos: (() => number | undefined) | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = this.createCard();
    this.clickHandler = (e) => this.handleClick(e);
    this.dom.addEventListener('click', this.clickHandler);

    // mount 时异步校验: 用 memoId 反查最新 title / notebookName / 路径,
    // 与 markdown 里缓存的旧值对比, 变化则写回 doc attrs;
    // 解析失败 → 落 stale.
  }

  private createCard(): HTMLElement {
    // notebookName 不再用于渲染 (见下方 nameSpan 注释), 仍在 attrs 里保留;
    // 这里只解构 UI 需要的字段.
    const { notebookId, relativePath, notebookName, memoId, originalPath, linkTarget, stale } = this.node.attrs as NoteReferenceAttrs;

    // 视觉 stale 判定:
    //   - 已 stale (applyAttrs 写入) → 视觉 stale
    //   - memoId 缺失 + originalPath 缺失 (双向都没法定位 memo) → 视觉 stale
    //   - 只有 memoId 缺失但 originalPath 在 (例如物理路径粘贴, paste 没
    //     同步拿到 id) → **不**先 stale, mount 时 refreshMemoAttrs 会
    //     用 originalPath 异步反查 memoId 并写回. 这样避免"刚粘贴的有效
    //     链接一出生就是灰卡"的问题.
    const hasTarget = Boolean((notebookId || notebookName) && relativePath)
      || Boolean(memoId || originalPath || linkTarget);
    const effectiveStale = stale || !hasTarget;

    // 外层 wrapper: 与 .editor-file-attachment 同结构 (display:inline),
    // 内部 __card 是真正的"卡片" — 拿 hover/selected 高亮
    // draggable="true": 与 Node 定义里的 `draggable: true` 配套, 显式标到
    // DOM 上后 ProseMirror 才会把这个 NodeView 当作可拖动源 (PM 内部
    // 通过 wrapper 的 `draggable` 属性识别拖拽起点), 否则在 inline atom
    // 上鼠标按住拖动只会触发选区, 不会启动 DnD 流.
    const wrapper = document.createElement('span');
    wrapper.className = 'editor-note-reference';
    // NoteReference remains the single source of truth for memo identity,
    // path validation, and navigation. Only its composer surface gets a
    // presentation modifier, so Agent chips cannot leak into document links.
    if (this.view.dom.closest('.agent-thread-card__composer')) {
      wrapper.classList.add('editor-note-reference--composer');
    }
    wrapper.contentEditable = 'false';
    wrapper.draggable = true;

    const card = document.createElement('span');
    card.className = 'editor-note-reference__card';
    card.setAttribute('data-stale', effectiveStale ? 'true' : 'false');
    if (originalPath) {
      card.setAttribute('title', effectiveStale ? tKey('editor.noteLink.stale', { path: originalPath }) : originalPath);
    }

    // 笔记图标 (lucide file-text 同形, 内联 SVG 避免依赖 React)
    const icon = document.createElement('span');
    icon.className = 'editor-note-reference__icon';
    icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;

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
    nameSpan.className = 'editor-note-reference__name';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'editor-note-reference__title';
    titleSpan.textContent = noteReferenceDisplayTitle(this.node.attrs as NoteReferenceAttrs) || tKey('editor.noteLink.untitled');
    nameSpan.appendChild(titleSpan);

    card.appendChild(icon);
    card.appendChild(nameSpan);

    // 失效标签: stale 视觉信号除了 opacity + 删除线, 再追加一段
    // "（已失效）" 文字, 让用户在不 hover 的情况下也能直接读到链接状态.
    // 用独立 span 包起来, 避免继承 __name 的 font-weight/换行属性.
    if (effectiveStale) {
      const staleMark = document.createElement('span');
      staleMark.className = 'editor-note-reference__stale-mark';
      staleMark.textContent = tKey('editor.noteLink.staleMark');
      card.appendChild(staleMark);
    }

    // 节点首/尾部 caret 占位:
    //  inline atom node 位于段落行首/行尾时, 浏览器把 caret 贴到
    //  NodeView 第一个/最后一个可定位点; 此前该点是 icon / 末尾文字,
    //  caret 视觉上 "穿入图标" 或 "贴卡片右边缘". 改为在 wrapper 内、
    //  card 前后各塞一个零宽空格文本节点, caret 自然落在文本节点上,
    //  与卡片边缘不再重叠.
    //  - 必须是 TextNode (createTextNode), <span> 不行——
    //    span 的边缘问题与 icon 相同, caret 仍会贴其左/右边缘.
    //  - 零宽空格 U+200B 不可见、不占字宽, 视觉上无副作用.
    //  - wrapper 整体 contentEditable=false, 用户无法编辑节点内部 DOM.
    //  - ignoreMutation 返回 true, PM 不会把这段 DOM 视为内容变更.
    //  - 前后对称两个 spacer: 保证从左侧进卡片 (← / Home) 与从右侧
    //    出卡片 (→ / End) 时 caret 着陆点一致.
    const caretSpacerLeading = document.createTextNode('​');
    const caretSpacerTrailing = document.createTextNode('​');
    wrapper.appendChild(caretSpacerLeading);
    wrapper.appendChild(card);
    wrapper.appendChild(caretSpacerTrailing);

    return wrapper;
  }

  private async handleClick(e: MouseEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();

    // 双击才触发跳转; 单击 / ⌘+click / Ctrl+click 都不打开。
    if (e.detail < 2) {
      // 键盘触发的 click 没有前置 mousedown, 仍保留节点选中语义。
      const pos = this.getPos?.();
      if (pos !== undefined) {
        const sel = NodeSelection.create(this.view.state.doc, pos);
        this.view.dispatch(this.view.state.tr.setSelection(sel));
      }
      return;
    }

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
      // eslint-disable-next-line no-console
      console.warn('[note-reference] open failed:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  private refreshCard(): void {
    // 与 fileAttachment 保持同一策略: attrs 更新时只替换内部 card,
    // 保留外层 wrapper、caret spacer 和 ProseMirror 对 NodeView DOM 的引用。
    const newCard = this.createCard().querySelector('.editor-note-reference__card') as HTMLElement | null;
    if (!newCard) return;

    const oldCard = this.dom.querySelector('.editor-note-reference__card');
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
    this.node = node;
    this.refreshCard();
    // update 触发场景: 文档被外部修改 / 切换 memo / undo-redo,
    // 节点 attrs 可能刚被改过, 仍跑一次异步校验兜底.
    return true;
  }

  /**
   * 用 memoId 反查最新 memo 元数据, 与当前 attrs 比对:
   *   - 解析失败 (memo 被删) → 落 stale.
   *   - title / notebookName / originalPath / notebookId 任一变化 → 写回 doc.
   *
   * 通过 this.refreshPromise 跟踪 in-flight Promise, 短时间内多次触发
   * (mount + 立刻 update) 时复用同一次请求, 避免后端被反复打.
   */
  private refreshPromise: Promise<void> | null = null;

  refreshMemoAttrs(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    const initialAttrs = this.node.attrs as NoteReferenceAttrs;
    // 反查路径优先级:
    //   1. memoId     — 稳定主键, 跨改名/跨笔记本移动不断链
    //   2. originalPath — 物理路径粘贴场景下 memoId 缺失, 用来反查补 memoId
    //   都没有 → 无可解析, 直接 return (createCard 已按 !memoId && !originalPath 落 stale)
    if (!initialAttrs.memoId && !initialAttrs.originalPath && !initialAttrs.linkTarget) {
      return Promise.resolve();
    }

    this.refreshPromise = (async () => {
      try {
        if (initialAttrs.linkTarget && /^flowix:\/\/memo\//i.test(initialAttrs.linkTarget)) {
          if (!(this.node.attrs as NoteReferenceAttrs).stale) this.applyAttrs({ stale: true });
          return;
        }
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
        if (initialAttrs.memoId) {
          if (!(this.node.attrs as NoteReferenceAttrs).stale) this.applyAttrs({ stale: true });
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
        // eslint-disable-next-line no-console
        console.warn('[note-reference] refresh failed:', err);
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  selectNode(): void {
    this.dom.classList.add('is-selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('is-selected');
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
    this.dom.removeEventListener('click', this.clickHandler);
  }
}

// ─── Node definition ──────────────────────────────────────────────────────────

export const NoteReference = Node.create({
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
      memoId:        { default: null },
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
          const memoId        = el.getAttribute('id') || null;
          const notebookId   = el.getAttribute('notebook') || null;
          const originalPath = el.getAttribute('path') || null;
          const relativePath = el.getAttribute('relativePath') || null;
          const stale        = parseBooleanAttr(el.getAttribute('stale'));
          const { notebookName, title } = splitDisplay(el.textContent ?? '');
          return { memoId, notebookId, relativePath, notebookName, title, originalPath, linkStyle: 'flowix', linkTarget: null, heading: null, stale };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const a = node.attrs as NoteReferenceAttrs;
    return [
      'note',
      {
        id: a.memoId ?? '',
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
  // 新格式 `[title](flowix://memo/<id>)` 和旧格式 `<note ...>` 都转回
  // noteReference 节点, 这样落盘格式可以迁移为标准 Markdown 链接,
  // 渲染仍保持当前卡片 NodeView。

  markdownTokenizer: {
    name: 'noteReference',
    level: 'inline' as const,
    start(src: string) {
      const noteIndex = src.indexOf('<note ');
      const linkHrefIndex = [src.indexOf('(flowix://memo/'), src.indexOf('(flowix://open?')]
        .filter(index => index >= 0).sort((a, b) => a - b)[0] ?? -1;
      const wikiIndex = src.indexOf('[[');
      const indexes = [noteIndex, linkHrefIndex < 0 ? -1 : Math.max(0, src.lastIndexOf('[', linkHrefIndex)), wikiIndex]
        .filter(index => index >= 0);
      if (indexes.length === 0) return -1;
      return Math.min(...indexes);
    },
    tokenize(src: string) {
      const wiki = parseWikiNoteLinkAtStart(src);
      if (wiki) {
        return { type: 'noteReference', raw: wiki.raw, wiki };
      }
      const link = parseMarkdownNoteLinkAtStart(src);
      if (link) {
        return {
          type: 'noteReference',
          raw: link.raw,
          href: link.href,
          text: link.text,
        };
      }

      const note = /^<note\s+([^>]*)>([\s\S]*?)<\/note>/.exec(src);
      if (!note) return undefined;
      return { type: 'noteReference', raw: note[0], attrs: note[1], text: note[2] };
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const wiki = token.wiki as ParsedWikiNoteLink | undefined;
    if (wiki) {
      return { type: 'noteReference', attrs: attrsFromWikiNoteLink(wiki) };
    }
    const href = String(token.href ?? '');
    if (FLOWIX_MEMO_URL_RE.test(href)) {
      return {
        type: 'noteReference',
        attrs: attrsFromMarkdownNoteLink(String(token.text ?? ''), href),
      };
    }

    const attrsStr = String(token.attrs ?? '');
    const text     = String(token.text ?? '');
    const { notebookName, title } = splitDisplay(unescapeHtml(text));
    // memoId 缺失 → null (而不是 ''), 与 addAttributes default null 一致;
    // 配合 renderMarkdown 在缺失时不写 id="" 属性, 避免 "memoId='' → 落
    // stale → save → 写 id='' → 重新 parse → 仍然 stale" 的死锁. mount
    // 时 refreshMemoAttrs 会用 originalPath 反查补回 memoId.
    const rawId = pickAttr(attrsStr, 'id');
    return {
      type: 'noteReference',
      attrs: {
        memoId:        rawId && rawId.length > 0 ? rawId : null,
        notebookId:   pickAttr(attrsStr, 'notebook'),
        relativePath: pickAttr(attrsStr, 'relativePath'),
        notebookName,
        title,
        originalPath: pickAttr(attrsStr, 'path'),
        linkStyle:    'flowix',
        linkTarget:   null,
        heading:      null,
        stale:        parseBooleanAttr(pickAttr(attrsStr, 'stale')),
      },
    };
  },

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
    return ({ node, view, getPos }) => new NoteReferenceView(node, view, getPos as () => number | undefined);
  },

  // ─── HardBreak 清理 ───────────────────────────────────────────────────────
  // 与 fileAttachment 同源(`attachment-link/nodes/view-file.ts:onCreate / addProseMirrorPlugins`):
  // 编辑器刚创建时扫一遍,后续每次文档变动也扫一遍,防止用户手动在卡片
  // 前后插入换行(Shift+Enter)导致卡片头部或末尾出现同块空行。

  onCreate() {
    const tr = removeHardBreaksAroundNoteReferences(this.editor.state);
    if (tr?.docChanged) {
      this.editor.view.dispatch(tr);
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: noteReferenceCaretPluginKey,
        state: {
          init: (_, state) => createTerminalInlineAtomCaretDecorations(state.doc, 'noteReference'),
          apply: (transaction, value, _oldState, newState) => (
            transaction.docChanged
              ? createTerminalInlineAtomCaretDecorations(newState.doc, 'noteReference')
              : value
          ),
        },
        props: {
          decorations: (state) => noteReferenceCaretPluginKey.getState(state) ?? DecorationSet.empty,
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some(transaction => transaction.docChanged)) return null;
          return removeHardBreaksAroundNoteReferences(newState);
        },
      }),
    ];
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
        const { selection } = this.editor.state;
        if (selection instanceof NodeSelection && selection.node.type.name === 'noteReference') {
          this.editor.commands.deleteSelection();
          return true;
        }
        const { $from } = selection;
        const before = $from.nodeBefore;
        if (before && before.type.name === 'noteReference') {
          const from = $from.pos - before.nodeSize;
          this.editor.commands.deleteRange({ from, to: $from.pos });
          return true;
        }
        return false;
      },
      Delete: () => {
        const { selection } = this.editor.state;
        if (selection instanceof NodeSelection && selection.node.type.name === 'noteReference') {
          this.editor.commands.deleteSelection();
          return true;
        }
        const { $from } = selection;
        const after = $from.nodeAfter;
        if (after && after.type.name === 'noteReference') {
          this.editor.commands.deleteRange({ from: $from.pos, to: $from.pos + after.nodeSize });
          return true;
        }
        return false;
      },
    };
  },
});
