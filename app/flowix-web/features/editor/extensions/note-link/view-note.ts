// `flowix://memo/<id>` 行内卡片节点。
//
// Markdown 形态: `[title](flowix://memo/vex4v9)`
// 兼容读取旧形态:
// `<note id="vex4v9" notebook="nb_173..." path="/Users/.../foo.md">notebookName/title</note>`
//
// 设计来源:
//   - 用户从外部 (Finder / 终端) 粘贴一份笔记的绝对路径到编辑器
//   - `MarkdownPaste.handlePaste` 顶部命中分支识别到这是当前 notebook 列表中某条
//     memo 的路径, 转成 noteReference 节点 (见 ./memo-resolver.ts)
//
//
// id-as-truth: 卡片显示文本 `notebookName/title` 是给人看的, 真正用来定位笔记的
// 是 attrs.memoId。memoId 是 noteReference 的"第一公民":
//   - 缺失 (parse/paste 时未拿到) → mount 立即落 stale 视觉 (无需等用户双击).
//   - 双击优先用 memoId 反查 (flowix://memo/<id> 深链), 跨改名 / 跨笔记本移动不断链.
//   - memoId 反查失败且 originalPath 也失效 → 落 stale 视觉 + 写回 doc attrs.

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView as ProseMirrorNodeView, EditorView } from '@tiptap/pm/view';
import { Node, nodeInputRule, nodePasteRule, type InputRuleMatch, type PasteRuleMatch } from '@tiptap/core';
import { NodeSelection, Plugin } from '@tiptap/pm/state';

import { readMarkdownLinkDestination } from '@features/editor/extensions/shared/markdown-link-destination';
import { openNoteByMemoId, openNoteByPhysicalPath, resolveMemoById, resolveMemoByPath } from '@features/editor/extensions/note-link/memo-resolver';
import { escapeHtml, parseBooleanAttr, pickAttr, splitDisplay, stripMdSuffix, unescapeHtml } from '@features/editor/extensions/note-link/markdown';
import { translate, type I18nKey } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { createTerminalInlineAtomCaretDecorations } from '@features/editor/extensions/shared/terminal-inline-atom-caret';

// ─── Attrs ────────────────────────────────────────────────────────────────────

export interface NoteReferenceAttrs {
  memoId: string | null;
  notebookId: string | null;
  notebookName: string;
  title: string;
  originalPath: string | null;
  /** 渲染态: memoId 缺失 或 后端按 memoId/originalPath 都解析不到时为 true;
   *  不写入 markdown */
  stale: boolean;
}

const FLOWIX_MEMO_URL_RE = /^flowix:\/\/memo\//i;
const FLOWIX_MEMO_HREF_RE = /^flowix:\/\/memo\/([^?\s)]*)(?:\?[^)\s]*)?$/;
const STRICT_FLOWIX_MEMO_HREF_RE = /^flowix:\/\/memo\/([0-9a-z]{6}|[0-9a-z]{8})(?:\?[^)\s]*)?$/;
const VALID_MEMO_ID_RE = /^([0-9a-z]{6}|[0-9a-z]{8})$/;

// NodeView 不在 React 树内, 不能用 useI18n, 走 user-settings-store 直读当前语言。
function tKey(key: I18nKey, params?: Record<string, string | number>): string {
  return translate(useUserSettingsStore.getState().settings.language, key, params);
}

type ParsedMarkdownNoteLink = {
  raw: string;
  text: string;
  href: string;
};

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

function parseFlowixMemoHrefForAttrs(href: string): { memoId: string | null; stale: boolean } {
  if (!FLOWIX_MEMO_URL_RE.test(href)) return { memoId: null, stale: true };
  const strict = href.match(STRICT_FLOWIX_MEMO_HREF_RE);
  if (strict) return { memoId: strict[1], stale: false };

  const match = href.match(FLOWIX_MEMO_HREF_RE);
  const rawMemoId = match?.[1] ?? null;
  if (!rawMemoId) return { memoId: null, stale: true };
  return {
    memoId: rawMemoId,
    stale: !VALID_MEMO_ID_RE.test(rawMemoId),
  };
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

function serializeLegacyNoteReference(a: NoteReferenceAttrs): string {
  const nb = escapeHtml(a.notebookId ?? '');
  const pa = escapeHtml(a.originalPath ?? '');
  const staleAttr = a.stale ? ' stale="true"' : '';
  const idAttr = a.memoId ? ` id="${escapeHtml(a.memoId)}"` : '';
  const display = a.notebookName
    ? `${a.notebookName}/${stripMdSuffix(a.title || '')}`
    : stripMdSuffix(a.title || '');
  return `<note${idAttr} notebook="${nb}" path="${pa}"${staleAttr}>${escapeHtml(display)}</note>`;
}

function attrsFromMarkdownNoteLink(titleText: string, href: string): NoteReferenceAttrs {
  const parsed = parseFlowixMemoHrefForAttrs(href);
  return {
    memoId: parsed.memoId,
    notebookId: null,
    notebookName: '',
    title: unescapeMarkdownLinkText(titleText).trim(),
    originalPath: null,
    stale: parsed.stale,
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
function removeHardBreaksAroundNoteReferences(state: any) {
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
    void this.refreshMemoAttrs();
  }

  private createCard(): HTMLElement {
    // notebookName 不再用于渲染 (见下方 nameSpan 注释), 仍在 attrs 里保留;
    // 这里只解构 UI 需要的字段.
    const { memoId, title, originalPath, stale } = this.node.attrs as NoteReferenceAttrs;

    // 视觉 stale 判定:
    //   - 已 stale (applyAttrs 写入) → 视觉 stale
    //   - memoId 缺失 + originalPath 缺失 (双向都没法定位 memo) → 视觉 stale
    //   - 只有 memoId 缺失但 originalPath 在 (例如物理路径粘贴, paste 没
    //     同步拿到 id) → **不**先 stale, mount 时 refreshMemoAttrs 会
    //     用 originalPath 异步反查 memoId 并写回. 这样避免"刚粘贴的有效
    //     链接一出生就是灰卡"的问题.
    const effectiveStale = stale || (!memoId && !originalPath);

    // 外层 wrapper: 与 .editor-file-attachment 同结构 (display:inline),
    // 内部 __card 是真正的"卡片" — 拿 hover/selected 高亮
    // draggable="true": 与 Node 定义里的 `draggable: true` 配套, 显式标到
    // DOM 上后 ProseMirror 才会把这个 NodeView 当作可拖动源 (PM 内部
    // 通过 wrapper 的 `draggable` 属性识别拖拽起点), 否则在 inline atom
    // 上鼠标按住拖动只会触发选区, 不会启动 DnD 流.
    const wrapper = document.createElement('span');
    wrapper.className = 'editor-note-reference';
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
    titleSpan.textContent = stripMdSuffix(title) || tKey('editor.noteLink.untitled');
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

    // memoId 是 memo 的稳定 id, 跨改名 / 跨笔记本移动都不变;
    // 是 noteReference 卡片的第一公民 ── 必须保存, 缺失即视为无效链接.
    if (!attrs.memoId) {
      this.applyAttrs({ stale: true });
      return;
    }

    // 优先用 memoId 反查 (flowix://memo/<id> 深链), 后端走 memo index 扫
    // 所有 notebook 找匹配 id 的 .md; 笔记改名 / 被搬都不会断链,
    // 只要 memo 还在磁盘上就能打开.
    //
    // 只有 memoId 反查失败时, 才回退到 originalPath 兜底 (粘贴进来的卡片
    // 历史数据里 memoId 已被解析过, originalPath 通常有效).
    try {
      const opened = await openNoteByMemoId(attrs.memoId);
      if (!opened) {
        // memoId 反查失败 → 尝试用 originalPath 再开一次 (兜底)
        if (attrs.originalPath) {
          await openNoteByPhysicalPath(attrs.originalPath);
        } else {
          this.applyAttrs({ stale: true });
          return;
        }
      }
      if (attrs.stale) {
        this.applyAttrs({ stale: false });
      }
    } catch (err) {
      this.applyAttrs({ stale: true });
      // eslint-disable-next-line no-console
      console.warn('[note-reference] open failed:', err);
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
    void this.refreshMemoAttrs();
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

  private refreshMemoAttrs(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    const initialAttrs = this.node.attrs as NoteReferenceAttrs;
    // 反查路径优先级:
    //   1. memoId     — 稳定主键, 跨改名/跨笔记本移动不断链
    //   2. originalPath — 物理路径粘贴场景下 memoId 缺失, 用来反查补 memoId
    //   都没有 → 无可解析, 直接 return (createCard 已按 !memoId && !originalPath 落 stale)
    if (!initialAttrs.memoId && !initialAttrs.originalPath) {
      return Promise.resolve();
    }

    this.refreshPromise = (async () => {
      try {
        const resolved = initialAttrs.memoId
          ? await resolveMemoById(initialAttrs.memoId)
          : await resolveMemoByPath(initialAttrs.originalPath!);
        // refresh 跑完前, 节点可能已经被销毁 / 替换; 用当前 this.node 取最新 attrs.
        const current = this.node.attrs as NoteReferenceAttrs;
        if (!resolved) {
          if (!current.stale) {
            this.applyAttrs({ stale: true });
          }
          return;
        }
        // 与磁盘最新值比对, 只在变化时写回 doc.
        //
        // title 故意不在这里写回:
        //   - 链接 markdown `[标题](flowix://memo/<id>)` 里的 `[标题]` 就是 attrs.title
        //     的真值来源, 用户在 markdown 里写下时即定; 渲染期间不该被后端 memoTitle
        //     反向覆盖 — 否则刷新路径会跑一次 `applyAttrs({title}) → setNodeMarkup →
        //     update() → createCard() → wrapper.replaceWith()`, NodeView 的 DOM 整棵
        //     被换掉, 期间 caret 落点 / 点击命中点会出现一瞬抖动, 表现为"刷新后光标
        //     无法落到卡片末尾 / 点选不稳定". 新增路径不抖, 是因为 attrs.title 一开始
        //     就跟后端一致, refresh 比对全相同 → 不写回 → 不 replaceWith.
        //   - 后端 memoTitle 改名后, 下次落盘由 `renderMarkdown` 用最新值序列化即可
        //     (它读的是 attrs.title, 而 attrs.title 在用户重新触发笔记节点 attrs 写入
        //      时会被更新; 这里只是不在 mount 异步阶段做主动覆盖).
        //   - notebookName 同理但更弱 (UI 不展示, 仅 round-trip 旧格式用), 只在缺失
        //     时补, 不主动覆盖.
        const patch: Partial<NoteReferenceAttrs> = {};
        if (!current.notebookName && resolved.notebookName) {
          patch.notebookName = resolved.notebookName;
        }
        if (current.notebookId !== resolved.notebookId) {
          patch.notebookId = resolved.notebookId;
        }
        if (current.originalPath !== resolved.absolutePath) {
          patch.originalPath = resolved.absolutePath;
        }
        // 物理路径粘贴场景: originalPath 反查成功 → 补回 memoId
        if (current.memoId !== resolved.memoId) {
          patch.memoId = resolved.memoId;
        }
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
      notebookId:   { default: null },
      notebookName: { default: '' },
      title:        { default: '' },
      originalPath: { default: null },
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
          const stale        = parseBooleanAttr(el.getAttribute('stale'));
          const { notebookName, title } = splitDisplay(el.textContent ?? '');
          return { memoId, notebookId, notebookName, title, originalPath, stale };
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
      const linkHrefIndex = src.indexOf('(flowix://memo/');
      if (noteIndex < 0 && linkHrefIndex < 0) return -1;
      if (noteIndex < 0) return Math.max(0, src.lastIndexOf('[', linkHrefIndex));
      if (linkHrefIndex < 0) return noteIndex;
      return Math.min(noteIndex, Math.max(0, src.lastIndexOf('[', linkHrefIndex)));
    },
    tokenize(src: string): any {
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

  parseMarkdown(token: any) {
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
        notebookName,
        title,
        originalPath: pickAttr(attrsStr, 'path'),
        stale:        parseBooleanAttr(pickAttr(attrsStr, 'stale')),
      },
    };
  },

  renderMarkdown(node: any) {
    const a = (node?.attrs ?? {}) as NoteReferenceAttrs;
    if (!a.memoId) {
      // 物理路径粘贴刚生成、尚未异步反查出 memoId 时保留旧格式兜底,
      // 避免保存时丢掉 originalPath。
      return serializeLegacyNoteReference(a);
    }

    const title = stripMdSuffix(a.title || '');
    return `[${escapeMarkdownLinkText(title)}](flowix://memo/${a.memoId})`;
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
        props: {
          decorations: (state) => createTerminalInlineAtomCaretDecorations(state.doc, 'noteReference'),
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
