import type { Editor } from '@tiptap/core';
import {
  linkSelectionHighlightPluginKey,
  normalizePlainLinkHref,
} from '@features/editor/extensions/markdown-link';
import { isRelativePathHref } from '@features/editor/editor-link-resolution';
import { positionFloatingBubble } from '@features/editor/components/floating-bubble-position';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';

export interface LinkInlineEditorRange {
  from: number;
  to: number;
}

export interface LinkInlineEditorOptions {
  editor: Editor;
  /** 目标文本范围: 编辑态是链接文案的范围, 创建态是当前选区。 */
  range: LinkInlineEditorRange;
  /** 输入框的初始地址 (已按作者原文还原)。 */
  initialHref: string;
  /** 定位参考的视口矩形: 链接元素或选区。返回 null 时保持当前位置。 */
  getAnchorRect: () => DOMRect | null;
  mode: 'create' | 'edit';
  /**
   * 首选一侧, 默认上方 (hover 气泡贴在链接上方)。
   * 选区入口传 `below`: 和原来的链接输入弹窗一样挂在选中内容下方, 下方放不下
   * 再整体上移。
   */
  placement?: 'above' | 'below';
  onClose?: (result: LinkInlineEditorResult) => void;
}

export type LinkInlineEditorResult = 'saved' | 'canceled';

const VIEWPORT_PADDING = 8;

let bubbleEl: HTMLDivElement | null = null;
let session: LinkInlineEditorOptions | null = null;
let repositionFrame: number | null = null;
let revealFrame: number | null = null;
let handleEditorDestroy: (() => void) | null = null;

function clearSelectionHighlight(editor: Editor): void {
  if (editor.view.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(linkSelectionHighlightPluginKey, { clear: true }));
}

function showSelectionHighlight(editor: Editor, from: number, to: number): void {
  if (from >= to || editor.view.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(linkSelectionHighlightPluginKey, { from, to }));
}

function normalizeDraftHref(raw: string): string {
  // 与文档里保存时的口径一致: 路径形态原样保留, web 地址补全协议。
  return isRelativePathHref(raw) ? raw.trim() : normalizePlainLinkHref(raw);
}

function applyHref(editor: Editor, range: LinkInlineEditorRange, href: string): void {
  const { from, to } = range;
  if (from === to) {
    // 光标处没有可包裹的文案: 用地址本身作为链接文案插入。
    editor
      .chain()
      .focus()
      .insertContent({ type: 'text', marks: [{ type: 'link', attrs: { href } }], text: href })
      .run();
    return;
  }

  editor
    .chain()
    .focus()
    .setTextSelection({ from, to })
    .extendMarkRange('link')
    .setLink({ href })
    .setTextSelection(to)
    .run();
}

function cancelFrames(): void {
  if (repositionFrame !== null) {
    cancelAnimationFrame(repositionFrame);
    repositionFrame = null;
  }
  if (revealFrame !== null) {
    cancelAnimationFrame(revealFrame);
    revealFrame = null;
  }
}

/**
 * 按锚点矩形落位, 返回是否量到了真实尺寸。
 *
 * 未挂载 / 未布局时 offset* 都是 0: 这时候绝不能把 0 当成气泡尺寸去算
 * 「居中」—— 会算成「左边 = 选区中心」, 气泡整体右移半个宽度。宁可先不定位,
 * 由调用方等下一帧再量。
 */
function position(): boolean {
  if (!bubbleEl || !session) return false;
  const rect = session.getAnchorRect();
  if (!rect) return false;

  if (bubbleEl.offsetWidth <= 0 || bubbleEl.offsetHeight <= 0) return false;

  // 落点按旧版链接输入弹窗的口径: 只看**窗口**边界, 不看编辑器面板的
  // 滚动容器 —— 面板底部往往就贴着最后一行文字, 用面板做垂直边界会让气泡在
  // 正文末尾凭空翻到选中内容上方。这里始终「选中内容正下方, 窗口底部放不下
  // 才上移」, 水平居中于选中内容。
  positionFloatingBubble(bubbleEl, rect, VIEWPORT_PADDING, session.placement ?? 'above');
  return true;
}

function scheduleReposition(): void {
  if (repositionFrame !== null) return;
  repositionFrame = requestAnimationFrame(() => {
    repositionFrame = null;
    position();
  });
}

const handleScroll = () => scheduleReposition();
const handleResize = () => scheduleReposition();

function handleOutsidePointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (bubbleEl?.contains(target)) return;
  // 点到气泡外 (正文、别的链接、面板) 一律视为放弃编辑, 这次点击照常生效。
  closeLinkInlineEditor('canceled');
}

/**
 * 气泡里唯一的按钮 (保存)。
 *
 * 没有取消按钮: 放弃编辑走 Esc / 点气泡外, 两种入口 (hover 编辑、选区添加链接)
 * 都保持同一个极简形态。样式与气泡里的「编辑」文字按钮完全一致 (无底色)。
 */
function createSaveButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'editor-link-hover-tooltip-button editor-link-hover-tooltip-text-button';
  button.dataset.linkAction = 'save';
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

export function isLinkInlineEditorOpen(): boolean {
  return bubbleEl !== null;
}

export function closeLinkInlineEditor(result: LinkInlineEditorResult = 'canceled'): void {
  const active = session;
  if (!active) return;

  session = null;
  cancelFrames();
  document.removeEventListener('scroll', handleScroll, true);
  window.removeEventListener('resize', handleResize);
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  if (handleEditorDestroy) {
    active.editor.off('destroy', handleEditorDestroy);
    handleEditorDestroy = null;
  }

  const element = bubbleEl;
  bubbleEl = null;
  element?.remove();

  clearSelectionHighlight(active.editor);
  active.onClose?.(result);
}

/**
 * 打开「就地编辑链接」气泡: 复用链接 hover 气泡的外观, 内容换成
 * 无外框的地址输入框 + 保存 (Esc / 点气泡外放弃)。
 *
 * 同一个气泡只服务一个目标: 重复调用会先关掉上一次的编辑态。
 */
export function openLinkInlineEditor(options: LinkInlineEditorOptions): void {
  const { editor, range, mode } = options;
  if (editor.view.isDestroyed) return;

  closeLinkInlineEditor('canceled');

  const language = getCurrentAppLanguage();
  const bubble = document.createElement('div');
  bubble.className = 'editor-link-hover-tooltip editor-link-inline-editor';
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute(
    'aria-label',
    translate(language, mode === 'edit' ? 'editor.link.edit' : 'editor.link.add'),
  );

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'editor-link-hover-tooltip-input';
  input.value = options.initialHref;
  input.placeholder = translate(language, 'editor.link.urlPlaceholder');
  input.setAttribute('aria-label', translate(language, 'editor.link.urlLabel'));
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));

  const save = () => {
    const href = normalizeDraftHref(input.value);
    if (!href) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    applyHref(editor, range, href);
    closeLinkInlineEditor('saved');
  };

  const cancel = () => closeLinkInlineEditor('canceled');

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  });

  bubble.append(input, createSaveButton(translate(language, 'editor.link.save'), save));

  bubbleEl = bubble;
  session = options;
  showSelectionHighlight(editor, range.from, range.to);

  document.addEventListener('scroll', handleScroll, true);
  window.addEventListener('resize', handleResize);
  document.addEventListener('pointerdown', handleOutsidePointerDown, true);
  // 编辑器被销毁 (关文档 / 切标签) 时同步收掉气泡, 否则它会挂在一个死掉的
  // 编辑器上继续响应滚动与点击。
  handleEditorDestroy = () => closeLinkInlineEditor('canceled');
  editor.on('destroy', handleEditorDestroy);

  // 先挂载但不可见: 量到真实尺寸、落到选中内容的正下方之后才显示,
  // 避免「先出现在错位置、下一帧再跳过去」。
  bubble.style.visibility = 'hidden';
  document.body.appendChild(bubble);
  if (position()) bubble.style.visibility = '';

  // 再补一帧: 字体/主题可能让宽度再变一点, 顺便聚焦输入框并全选,
  // 让用户可以直接覆写地址。极端情况下首帧量不到尺寸, 这一帧一定会量到。
  revealFrame = requestAnimationFrame(() => {
    if (position()) bubble.style.visibility = '';
    revealFrame = requestAnimationFrame(() => {
      revealFrame = null;
      if (position()) bubble.style.visibility = '';
      input.focus();
      input.select();
    });
  });
}
