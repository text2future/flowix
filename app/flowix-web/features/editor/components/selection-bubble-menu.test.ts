import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { hasFormattableTextSelection } from '@features/editor/components/selection-bubble-menu-state';

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
  });

  it('rejects selections in a read-only editor', () => {
    const editor = createEditor('<p>Alpha beta</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.setEditable(false);

    expect(hasFormattableTextSelection(editor)).toBe(false);
  });
});
