import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeLinkInlineEditor } from '@features/editor/components/link-inline-editor';
import { MarkdownEditor } from '@features/editor/markdown-editor';
import { ShortcutsProvider } from '@features/shortcuts';
import '@features/shortcuts/actions';

let container: HTMLDivElement;
let root: Root;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const PANEL_BOX = { left: 0, top: 0, width: 800, height: 600 };

let selectionBox = { left: 400, top: 300, width: 200, height: 24 };

// jsdom 不跑布局, Range 上这两个方法本身可能不存在, 只能 defineProperty 打桩。
const originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

function stubLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => (
    new DOMRect(PANEL_BOX.left, PANEL_BOX.top, PANEL_BOX.width, PANEL_BOX.height)
  ));
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(selectionBox.left, selectionBox.top, selectionBox.width, selectionBox.height),
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  });
}

function restoreLayout() {
  if (originalRangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeRect);
  else delete (Range.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
  if (originalRangeRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRangeRects);
  else delete (Range.prototype as unknown as Record<string, unknown>).getClientRects;
}

/** 在正文里放一个真实 DOM 选区, 让 createSelectionBubbleReference 拿得到包围盒。 */
function selectParagraphText(editor: Editor, endOffset = 5, selector = 'p'): void {
  const text = editor.view.dom.querySelector(selector)?.firstChild;
  if (!(text instanceof Text)) throw new Error('paragraph text node missing');
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function renderEditor(content: string) {
  let editor: Editor | null = null;
  const element = (
    <ShortcutsProvider overrides={{}}>
      <MarkdownEditor
        content={content}
        onBeforeCreate={(instance) => { editor = instance; }}
      />
    </ShortcutsProvider>
  );
  return { element, getEditor: () => editor! };
}

describe('Editor bubble menu overlays', () => {
  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    selectionBox = { left: 400, top: 300, width: 200, height: 24 };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.getSelection()?.removeAllRanges();
    restoreLayout();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('mounts the toolbar on the body layer instead of the clipped editor root', async () => {
    stubLayout();
    const { element, getEditor } = renderEditor('Alpha beta gamma');
    await act(async () => root.render(element));

    const editor = getEditor();
    await act(async () => {
      editor.view.focus();
      selectParagraphText(editor);
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    const menu = document.querySelector<HTMLElement>('.selection-bubble-menu');
    expect(menu).not.toBeNull();
    // 架构护栏: 漂浮层挂在 body 上, fixed + --layer-editor-overlay。
    // 挂进 .markdown-editor 会被它的 overflow: hidden 裁掉, 也会被隔壁列的
    // 叠层上下文盖住 (面板窄时工具条要能压到相邻列上)。
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.closest('.markdown-editor')).toBeNull();
    expect(menu?.style.position).toBe('fixed');
  });

  it('follows the inner scroller without remounting', async () => {
    stubLayout();
    const { element, getEditor } = renderEditor('Alpha beta gamma');
    await act(async () => root.render(element));

    const editor = getEditor();
    await act(async () => {
      editor.view.focus();
      selectParagraphText(editor);
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    const menu = document.querySelector<HTMLElement>('.selection-bubble-menu');
    expect(menu).not.toBeNull();
    const before = menu!.style.top;

    // 内层滚动: 选区在视口里上移, 工具条必须跟着走, 且节点身份不变。
    selectionBox = { left: 400, top: 200, width: 200, height: 24 };
    const scroller = container.querySelector('.editor-content');
    expect(scroller).not.toBeNull();
    await act(async () => {
      scroller!.dispatchEvent(new Event('scroll'));
    });

    const after = document.querySelector<HTMLElement>('.selection-bubble-menu');
    expect(after).toBe(menu);
    expect(after!.style.top).not.toBe(before);
    expect(after!.style.top).toBe(`${200 - 8 - 34}px`);
  });

  it('removes the toolbar when the selection collapses and leaves no orphan', async () => {
    stubLayout();
    const { element, getEditor } = renderEditor('Alpha beta gamma');
    await act(async () => root.render(element));

    const editor = getEditor();
    await act(async () => {
      editor.view.focus();
      selectParagraphText(editor);
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    expect(document.querySelector('.selection-bubble-menu')).not.toBeNull();

    await act(async () => {
      editor.commands.setTextSelection(3);
    });

    expect(document.querySelector('.selection-bubble-menu')).toBeNull();
    expect(document.querySelectorAll('.selection-bubble-menu').length).toBe(0);
  });

  it('shows the current block name on the turn-into trigger without active styling', async () => {
    stubLayout();
    const { element, getEditor } = renderEditor('# Alpha beta gamma');
    await act(async () => root.render(element));

    const editor = getEditor();
    await act(async () => {
      editor.view.focus();
      selectParagraphText(editor, 5, 'h1');
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    const trigger = document.querySelector<HTMLElement>('.selection-bubble-dropdown-trigger');
    expect(trigger).not.toBeNull();
    // 非正文块 (H1/Hn/列表/代码块/引文) 的状态只由图标 + 名称回显, 不再叠
    // 品牌色底和品牌色文字 (那套是 B/I/U 开关型按钮的激活态)。
    expect(trigger?.classList.contains('is-active')).toBe(false);
    expect(trigger?.querySelector('.selection-bubble-dropdown-trigger-label')?.textContent)
      .toMatch(/标题 1|Heading 1/);
  });

  it('opens the link input right below the selection, centered on it', async () => {
    stubLayout();
    // jsdom 不跑布局: 给链接输入气泡一个可测尺寸 (236 宽 / 32 高)。
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 236 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 32 });

    try {
      const { element, getEditor } = renderEditor('Alpha beta gamma');
      await act(async () => root.render(element));

      const editor = getEditor();
      await act(async () => {
        editor.view.focus();
        selectParagraphText(editor);
        editor.commands.setTextSelection({ from: 1, to: 6 });
      });

      const trigger = document.querySelector<HTMLElement>('.selection-bubble-link-trigger');
      expect(trigger).not.toBeNull();
      await act(async () => {
        trigger!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      });

      const bubble = document.querySelector<HTMLElement>('.editor-link-inline-editor');
      expect(bubble).not.toBeNull();
      // 选区 (400,300)-(600,324): 正下方 324 + 8 = 332;
      // 水平居中 400 + 200/2 - 236/2 = 382。
      expect(bubble?.style.top).toBe('332px');
      expect(bubble?.style.left).toBe('382px');
    } finally {
      closeLinkInlineEditor('canceled');
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
    }
  });

  it('keeps the link icon at a fixed 15x15 without press-time scaling', async () => {
    stubLayout();
    const { element, getEditor } = renderEditor('Alpha beta gamma');
    await act(async () => root.render(element));

    const editor = getEditor();
    await act(async () => {
      editor.view.focus();
      selectParagraphText(editor);
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    const trigger = document.querySelector<HTMLElement>('.selection-bubble-link-trigger');
    expect(trigger).not.toBeNull();
    // lucide Link 的 svg 自带 15×15, CSS 再固定一次, 按下时按钮不缩放。
    expect(trigger?.querySelector('svg')?.getAttribute('width')).toBe('15');
    expect(trigger?.querySelector('svg')?.getAttribute('height')).toBe('15');
  });

  it('renders the table toolbar through the same overlay mechanism', async () => {
    stubLayout();
    const { element, getEditor } = renderEditor('| a | b |\n| --- | --- |\n| c | d |');
    await act(async () => root.render(element));

    const editor = getEditor();
    let cellPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (cellPos !== null) return false;
      if (node.type.name === 'tableCell') {
        cellPos = pos + 2;
        return false;
      }
      return true;
    });
    expect(cellPos).not.toBeNull();

    await act(async () => {
      editor.view.focus();
      editor.commands.setTextSelection(cellPos!);
    });

    const panel = document.querySelector<HTMLElement>('.table-bubble-menu-panel');
    expect(panel).not.toBeNull();
    // 与选区气泡同一套: body + fixed, 并且垂直被钳在面板内 (表格上沿的气泡
    // 翻到下方会盖住首行, 所以放不下时贴面板顶)。
    expect(panel?.parentElement).toBe(document.body);
    expect(panel?.style.position).toBe('fixed');
    expect(panel?.style.top).toBe(`${PANEL_BOX.top + 8}px`);
  });
});
