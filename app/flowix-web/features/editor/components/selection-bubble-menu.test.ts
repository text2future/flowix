import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSelectionBubbleReference,
  getSelectionBubbleMenuSnapshot,
  hasFormattableTextSelection,
  sameSelectionBubbleMenuSnapshot,
} from '@features/editor/components/selection-bubble-menu-state';

const editors: Editor[] = [];

function createEditor(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: [StarterKit], content });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.view.dom.parentElement?.remove();
    editor.destroy();
  }
});

describe('hasFormattableTextSelection', () => {
  it('accepts a non-empty text selection', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });

    expect(hasFormattableTextSelection(editor)).toBe(true);
  });

  it('rejects an empty cursor selection', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    editor.commands.setTextSelection(3);

    expect(hasFormattableTextSelection(editor)).toBe(false);
  });

  it('rejects selections containing only whitespace', () => {
    const editor = createEditor('<p>Alpha&nbsp;&nbsp;&nbsp;beta</p>');
    editor.commands.setTextSelection({ from: 6, to: 9 });

    expect(hasFormattableTextSelection(editor)).toBe(false);
  });

  it('rejects code block text selections', () => {
    const editor = createEditor('<pre><code>Alpha</code></pre>');
    editor.commands.setTextSelection({ from: 1, to: 6 });

    expect(hasFormattableTextSelection(editor)).toBe(false);
    expect(getSelectionBubbleMenuSnapshot(editor).codeBlock).toBe(true);
  });

  it('rejects selections in a read-only editor', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.setEditable(false);

    expect(hasFormattableTextSelection(editor)).toBe(false);
  });

  it('keeps equal transaction snapshots referentially reusable and detects button state changes', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const first = getSelectionBubbleMenuSnapshot(editor);
    expect(first.highlightColor).toBeNull();
    const same = getSelectionBubbleMenuSnapshot(editor);
    expect(sameSelectionBubbleMenuSnapshot(first, same)).toBe(true);
    expect(sameSelectionBubbleMenuSnapshot(first, { ...same, boldEnabled: !same.boldEnabled })).toBe(false);
  });

  it('echoes the current heading level and list type for the dropdown triggers', () => {
    const editor = createEditor('<h2>Beta</h2><ul><li><p>One</p></li></ul>');
    editor.commands.setTextSelection({ from: 1, to: 5 });
    expect(getSelectionBubbleMenuSnapshot(editor).heading).toBe(2);

    editor.commands.setTextSelection({ from: 10, to: 13 });
    const listSnapshot = getSelectionBubbleMenuSnapshot(editor);
    expect(listSnapshot.heading).toBeNull();
    expect(listSnapshot.bulletList).toBe(true);
    expect(listSnapshot.orderedList).toBe(false);
    expect(listSnapshot.taskList).toBe(false);

    editor.commands.toggleHeading({ level: 2 });
    expect(editor.isActive('heading', { level: 2 })).toBe(true);
    expect(getSelectionBubbleMenuSnapshot(editor).heading).toBe(2);
  });

  it('detects heading and list echo changes between snapshots', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const before = getSelectionBubbleMenuSnapshot(editor);
    editor.commands.toggleHeading({ level: 1 });
    const after = getSelectionBubbleMenuSnapshot(editor);
    expect(sameSelectionBubbleMenuSnapshot(before, after)).toBe(false);
    expect(after.heading).toBe(1);
  });

  it('detects blockquote echo changes between snapshots', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const before = getSelectionBubbleMenuSnapshot(editor);
    expect(before.blockquote).toBe(false);

    editor.commands.toggleBlockquote();
    const after = getSelectionBubbleMenuSnapshot(editor);
    expect(after.blockquote).toBe(true);
    expect(sameSelectionBubbleMenuSnapshot(before, after)).toBe(false);
  });
});

describe('createSelectionBubbleReference', () => {
  const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;

  /** 在编辑器正文里放一个真实的 DOM 选区（jsdom 不跑布局, 矩形需自行打桩）。 */
  function selectParagraphText(editor: Editor, endOffset = 5): Range {
    const text = editor.view.dom.querySelector('p')?.firstChild;
    if (!(text instanceof Text)) throw new Error('paragraph text node missing');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, endOffset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range;
  }

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it('uses the selection bounding box so the bubble centers on the selection', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    selectParagraphText(editor);
    // 整块选区的外框 = 正文列宽; 而 posToDOMRect 只会给出「起点光标→收笔光标」
    // 那条几十 px 的窄框, 工具条因此贴到左边缘。
    Range.prototype.getBoundingClientRect = () => new DOMRect(120, 300, 520, 26);

    const reference = createSelectionBubbleReference(editor);

    expect(reference).not.toBeNull();
    expect(reference?.getBoundingClientRect()).toMatchObject({ x: 120, y: 300, width: 520, height: 26 });
  });

  it('falls back to tiptap when the DOM selection is collapsed', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    const text = editor.view.dom.querySelector('p')?.firstChild;
    window.getSelection()?.collapse(text as Text, 3);
    Range.prototype.getBoundingClientRect = () => new DOMRect(120, 300, 520, 26);

    expect(createSelectionBubbleReference(editor)).toBeNull();
  });

  it('falls back to tiptap when the selection lives outside the editor', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    const outside = document.createTextNode('outside text');
    document.body.appendChild(outside);
    const range = document.createRange();
    range.setStart(outside, 0);
    range.setEnd(outside, 7);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 200, 20);

    expect(createSelectionBubbleReference(editor)).toBeNull();
    outside.remove();
  });

  it('falls back to tiptap when the browser reports an empty box', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    selectParagraphText(editor);
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

    expect(createSelectionBubbleReference(editor)).toBeNull();
  });
});
