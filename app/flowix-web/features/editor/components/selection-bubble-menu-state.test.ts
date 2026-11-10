import type { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createSelectionBubbleReference } from './selection-bubble-menu-state';

// jsdom 不跑布局: Range 的包围盒只能打桩。
const originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
const SELECTION_BOX = new DOMRect(140, 240, 200, 24);

function stubRangeRect(): void {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => SELECTION_BOX,
  });
}

afterEach(() => {
  if (originalRangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeRect);
  else delete (Range.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

function createEditor(from: number, to: number) {
  const dom = document.createElement('div');
  dom.innerHTML = '<p>hello world</p>';
  document.body.append(dom);
  const text = dom.querySelector('p')!.firstChild as Text;

  const editor = {
    view: {
      dom,
      domAtPos: (pos: number) => ({ node: text, offset: Math.min(pos, text.length) }),
    },
    state: { selection: { from, to } },
  } as unknown as Editor;

  return { editor, text };
}

function selectText(text: Text, from: number, to: number): void {
  const range = document.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('selection bubble reference', () => {
  it('uses the browser selection box while the selection is live', () => {
    stubRangeRect();
    const { editor, text } = createEditor(1, 6);
    selectText(text, 0, 5);

    expect(createSelectionBubbleReference(editor)?.getBoundingClientRect()).toEqual(SELECTION_BOX);
  });

  it('keeps following the editor selection after focus moves into a popup input', () => {
    stubRangeRect();
    const { editor } = createEditor(1, 6);
    // 焦点交给链接输入弹窗后, window.getSelection() 已经塌陷, 但编辑器选区还在。
    window.getSelection()!.removeAllRanges();

    // 之前这里会返回 null, 于是定位退回只拼起止光标的 posToDOMRect, 气泡跳位。
    expect(createSelectionBubbleReference(editor)?.getBoundingClientRect()).toEqual(SELECTION_BOX);
  });

  it('reports no reference when the editor selection is collapsed too', () => {
    stubRangeRect();
    const { editor } = createEditor(4, 4);
    window.getSelection()!.removeAllRanges();

    expect(createSelectionBubbleReference(editor)).toBeNull();
  });
});
