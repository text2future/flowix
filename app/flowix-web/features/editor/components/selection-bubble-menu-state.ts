import { isTextSelection, type Editor } from '@tiptap/core';
import { isFlowixTextColor, type FlowixTextColor } from '@features/editor/extensions/flowix-text-colors';

export type BubbleHeadingLevel = 1 | 2 | 3 | 4;

export interface SelectionBubbleMenuSnapshot {
  hasSelection: boolean;
  bold: boolean;
  boldEnabled: boolean;
  italic: boolean;
  italicEnabled: boolean;
  underline: boolean;
  underlineEnabled: boolean;
  strike: boolean;
  strikeEnabled: boolean;
  code: boolean;
  codeEnabled: boolean;
  highlight: boolean;
  /** 当前高亮底色 (highlight mark 的 flowixBg), 无高亮为 null。 */
  highlightColor: FlowixTextColor | null;
  /** 当前高亮前景色 (highlight mark 的 flowixFg), 未设置时为 null。 */
  highlightFg: FlowixTextColor | null;
  linkHref: string;
  /** 当前块级标题回显 (1-4), 正文为 null。 */
  heading: BubbleHeadingLevel | null;
  /** 三种列表的回显, 互斥。 */
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  /** 引文 / 代码块回显 (与标题、列表互斥; codeBlock 实际不会弹出 bubble,
   * 仅为触发按钮回显完整性保留)。 */
  blockquote: boolean;
  codeBlock: boolean;
}

/** bubble 定位参考（只需包围盒；不使用 floating-ui 的 inline 中间件）。 */
export interface SelectionBubbleReference {
  getBoundingClientRect: () => DOMRect;
}

/**
 * bubble 的水平落点参考框（视口坐标）。
 *
 * tiptap 默认的虚拟元素走 `posToDOMRect(from, to)`：只取「起点光标」和「终点
 * 光标」两个点拼矩形。多行 / 整块选中时 right 只到最后一行的收笔处，矩形可能
 * 只有几十 px 宽，而 `placement: 'top'` 是在参考框上水平居中的 —— 于是居中点
 * 贴着选区左边缘，工具条一半挂到正文外面（整块选中时尤其明显）。
 *
 * 这里换成 DOM Range 的真实包围盒（＝蓝色高亮的外框），居中点才是选区中心。
 *
 * 浏览器选区不一定还在: 打开链接输入弹窗后焦点交给弹窗里的输入框，
 * `window.getSelection()` 会塌陷 / 清空，而编辑器自己的选区并没有变。这时先用
 * 编辑器选区位置重建一个 DOM Range 再取包围盒 —— 退回 `posToDOMRect` 会让气泡
 * 从「选中的文字」跳到「起点光标」，看起来就是气泡自己挪了位置。
 *
 * 拿不到可用矩形（选区不在本编辑器内、未布局）时返回 null，由 tiptap 退回它
 * 自己的虚拟元素。
 */
export function createSelectionBubbleReference(editor: Editor): SelectionBubbleReference | null {
  if (typeof window === 'undefined') return null;

  const domSelection = window.getSelection();
  if (domSelection && domSelection.rangeCount > 0 && !domSelection.isCollapsed) {
    const range = domSelection.getRangeAt(0);
    if (
      editor.view.dom.contains(range.commonAncestorContainer)
      && hasUsableBounds(range)
    ) {
      // 惰性求值：滚动 / 换行后位置会变，每次定位都读当前值。
      return { getBoundingClientRect: () => range.getBoundingClientRect() };
    }
  }

  const { from, to } = editor.state.selection;
  return rangeReference(editor, from, to);
}

/**
 * 指定文本范围在视口坐标下的包围盒。
 *
 * 完全由编辑器状态 (from/to) 推导, 不读 `window.getSelection()`: 链接输入框
 * 抢走焦点后浏览器选区会塌陷, 但这段文字并没有移动, 位置必须仍然算得出来。
 * 与旧版链接输入弹窗「每次重新按 from/to 算一遍」的口径一致。
 */
export function textRangeRect(
  editor: Editor,
  from: number,
  to: number,
): DOMRect | null {
  if (typeof window === 'undefined') return null;
  return rangeReference(editor, from, to)?.getBoundingClientRect() ?? null;
}

/** 由编辑器位置构建的惰性包围盒参考；拿不到可用矩形时返回 null。 */
function rangeReference(
  editor: Editor,
  from: number,
  to: number,
): SelectionBubbleReference | null {
  if (from >= to) return null;
  const range = domRangeForPositions(editor, from, to);
  if (!range || !hasUsableBounds(range)) return null;
  return { getBoundingClientRect: () => range.getBoundingClientRect() };
}

/** 折叠 / 隐藏（display:none、未挂载）时是零矩形, 交给上层兜底。 */
function hasUsableBounds(range: Range): boolean {
  if (typeof range.getBoundingClientRect !== 'function') return false;
  const bounds = range.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0;
}

/**
 * 用编辑器选区位置重建 DOM Range。
 *
 * `window.getSelection()` 归零时（焦点在气泡外的输入框里），编辑器状态里的
 * from/to 仍然指向被选中的文字，据此重建的 Range 包围盒与浏览器选区一致。
 */
function domRangeForPositions(editor: Editor, from: number, to: number): Range | null {
  try {
    const start = editor.view.domAtPos(from);
    const end = editor.view.domAtPos(to);
    if (!editor.view.dom.contains(start.node) || !editor.view.dom.contains(end.node)) {
      return null;
    }
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

export function hasFormattableTextSelection(editor: Editor): boolean {
  const { doc, selection } = editor.state;

  if (!editor.isEditable || !isTextSelection(selection) || selection.empty) {
    return false;
  }

  if (editor.isActive('codeBlock')) {
    return false;
  }

  return (
    doc.textBetween(selection.from, selection.to, ' ', ' ').trim().length > 0
  );
}

export function getActiveHeadingLevel(editor: Editor): BubbleHeadingLevel | null {
  for (const level of [1, 2, 3, 4] as const) {
    if (editor.isActive('heading', { level })) return level;
  }
  return null;
}

/**
 * 没有可格式化的文本选区时使用的静态快照。
 *
 * 气泡条常驻挂载 (不再随滚动卸载) 后, 组件用这个常量短路掉绝大多数
 * transaction: 折叠选区时省掉十几次 isActive 与 5 次 can().chain().focus()。
 * 注意它只用于「菜单不可见因而无需回显」的场景, getSelectionBubbleMenuSnapshot
 * 本身仍返回完整快照 (代码块 / 只读等情形有单测锁定)。
 */
export const EMPTY_SELECTION_BUBBLE_MENU_SNAPSHOT: SelectionBubbleMenuSnapshot = {
  hasSelection: false,
  bold: false,
  boldEnabled: false,
  italic: false,
  italicEnabled: false,
  underline: false,
  underlineEnabled: false,
  strike: false,
  strikeEnabled: false,
  code: false,
  codeEnabled: false,
  highlight: false,
  highlightColor: null,
  highlightFg: null,
  linkHref: '',
  heading: null,
  bulletList: false,
  orderedList: false,
  taskList: false,
  blockquote: false,
  codeBlock: false,
};

export function getSelectionBubbleMenuSnapshot(editor: Editor): SelectionBubbleMenuSnapshot {
  const canToggle = (mark: 'bold' | 'italic' | 'underline' | 'strike' | 'code') => {
    const chain = editor.can().chain().focus();
    if (mark === 'bold') return chain.toggleBold().run();
    if (mark === 'italic') return chain.toggleItalic().run();
    if (mark === 'underline') return chain.toggleUnderline().run();
    if (mark === 'strike') return chain.toggleStrike().run();
    return chain.toggleCode().run();
  };
  const linkHref = editor.isActive('link')
    ? String(editor.getAttributes('link').href ?? '')
    : '';
  const highlightAttrs = editor.getAttributes('highlight');
  const highlightBg = highlightAttrs.flowixBg;
  const highlightFg = highlightAttrs.flowixFg;
  return {
    hasSelection: hasFormattableTextSelection(editor),
    bold: editor.isActive('bold'),
    boldEnabled: canToggle('bold'),
    italic: editor.isActive('italic'),
    italicEnabled: canToggle('italic'),
    underline: editor.isActive('underline'),
    underlineEnabled: canToggle('underline'),
    strike: editor.isActive('strike'),
    strikeEnabled: canToggle('strike'),
    code: editor.isActive('code'),
    codeEnabled: canToggle('code'),
    highlight: editor.isActive('highlight'),
    highlightColor: isFlowixTextColor(highlightBg) ? highlightBg : null,
    highlightFg: isFlowixTextColor(highlightFg) ? highlightFg : null,
    linkHref,
    heading: getActiveHeadingLevel(editor),
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    taskList: editor.isActive('taskList'),
    blockquote: editor.isActive('blockquote'),
    codeBlock: editor.isActive('codeBlock'),
  };
}

export function sameSelectionBubbleMenuSnapshot(
  left: SelectionBubbleMenuSnapshot,
  right: SelectionBubbleMenuSnapshot,
): boolean {
  return left.hasSelection === right.hasSelection
    && left.bold === right.bold
    && left.boldEnabled === right.boldEnabled
    && left.italic === right.italic
    && left.italicEnabled === right.italicEnabled
    && left.underline === right.underline
    && left.underlineEnabled === right.underlineEnabled
    && left.strike === right.strike
    && left.strikeEnabled === right.strikeEnabled
    && left.code === right.code
    && left.codeEnabled === right.codeEnabled
    && left.highlight === right.highlight
    && left.highlightColor === right.highlightColor
    && left.highlightFg === right.highlightFg
    && left.linkHref === right.linkHref
    && left.heading === right.heading
    && left.bulletList === right.bulletList
    && left.orderedList === right.orderedList
    && left.taskList === right.taskList
    && left.blockquote === right.blockquote
    && left.codeBlock === right.codeBlock;
}

/**
 * 选区气泡的可见性广播。
 *
 * 选区气泡和链接 hover 气泡都会浮在正文上, 两者可能同时命中: 拖动选中一段
 * 带链接的文字时, 指针仍停在链接上会顺带把链接气泡顶出来。约定「文字操作优先」
 * —— 选区气泡在场时链接气泡不显示; 链接气泡模块不是 React 树的一部分, 所以
 * 这里用一个小广播让它在选区气泡出现的瞬间立即收起自己。
 */
let selectionBubbleMenuVisible = false;
const selectionBubbleMenuVisibilityListeners = new Set<(visible: boolean) => void>();

export function isSelectionBubbleMenuVisible(): boolean {
  return selectionBubbleMenuVisible;
}

export function setSelectionBubbleMenuVisible(visible: boolean): void {
  if (selectionBubbleMenuVisible === visible) return;
  selectionBubbleMenuVisible = visible;
  for (const listener of selectionBubbleMenuVisibilityListeners) listener(visible);
}

export function subscribeSelectionBubbleMenuVisibility(
  listener: (visible: boolean) => void,
): () => void {
  selectionBubbleMenuVisibilityListeners.add(listener);
  return () => {
    selectionBubbleMenuVisibilityListeners.delete(listener);
  };
}
