import { describe, expect, it } from 'vitest';
import { getTerminalInlineAtomCaretRect } from './stable-caret';

function setRect(element: HTMLElement, rect: Partial<DOMRect>): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: rect.left ?? 0,
      right: rect.right ?? 0,
      top: rect.top ?? 0,
      bottom: rect.bottom ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
    }),
  });
}

describe('getTerminalInlineAtomCaretRect', () => {
  it('anchors the caret to the visible note card instead of the trailing break', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const wrapper = document.createElement('span');
    const card = document.createElement('span');
    const anchor = document.createElement('span');

    card.className = 'editor-note-reference__card';
    anchor.className = 'terminal-inline-atom-caret-anchor';
    anchor.setAttribute('data-terminal-inline-atom-caret-position', '17');
    Object.defineProperty(card, 'getClientRects', {
      configurable: true,
      value: () => [
        { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 },
        { left: 80, right: 220, top: 107, bottom: 133, width: 140, height: 26 },
      ],
    });

    wrapper.append(card);
    editor.append(wrapper, anchor);

    const result = getTerminalInlineAtomCaretRect(
      { dom: editor } as never,
      17,
    );

    expect(result).toEqual({ left: 220, top: 107, bottom: 133 });
  });

  it('does not use another atom anchor position', () => {
    const editor = document.createElement('div');
    const wrapper = document.createElement('span');
    const card = document.createElement('span');
    const anchor = document.createElement('span');

    card.className = 'editor-note-reference__card';
    anchor.className = 'terminal-inline-atom-caret-anchor';
    anchor.setAttribute('data-terminal-inline-atom-caret-position', '17');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    editor.append(wrapper, anchor);

    expect(getTerminalInlineAtomCaretRect({ dom: editor } as never, 18)).toBeNull();
  });

  it('does not use an anchor from a nested ProseMirror editor', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const nestedEditor = document.createElement('div');
    nestedEditor.className = 'ProseMirror';
    const wrapper = document.createElement('span');
    const card = document.createElement('span');
    const anchor = document.createElement('span');

    card.className = 'editor-note-reference__card';
    anchor.className = 'terminal-inline-atom-caret-anchor';
    anchor.setAttribute('data-terminal-inline-atom-caret-position', '17');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    nestedEditor.append(wrapper, anchor);
    editor.append(nestedEditor);

    expect(getTerminalInlineAtomCaretRect({ dom: editor } as never, 17)).toBeNull();
  });
});
