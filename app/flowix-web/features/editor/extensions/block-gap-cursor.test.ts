import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { BlockGapCursor, paragraphAtGap, isValidBlockGap } from './block-gap-cursor';

const editors: Editor[] = [];

function createEditor() {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ gapcursor: false, trailingNode: false }),
      Node.create({ name: 'frontmatter', priority: 1000, group: 'block', content: '', selectable: false,
        renderHTML: () => ['aside'] }),
      Node.create({ name: 'card', group: 'block', atom: true, selectable: false,
        renderHTML: () => ['section', { contenteditable: 'false' }] }),
      Node.create({ name: 'isolatingText', group: 'block', content: 'inline*', isolating: true,
        renderHTML: () => ['section', 0] }),
      Node.create({ name: 'atomText', group: 'block', content: 'inline*', atom: true,
        renderHTML: () => ['section', 0] }),
      BlockGapCursor,
    ],
    content: { type: 'doc', content: [{ type: 'card' }, { type: 'card' }] },
  });
  editors.push(editor);
  return editor;
}

function selectGap(editor: Editor, position = 1) {
  editor.view.dispatch(editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(position))));
}

// Reference behavior deliberately resolves every boundary. Production's cheap
// rejection filter must preserve these results when node schemas change.
function expectedGapPositions(editor: Editor): number[] {
  const doc = editor.state.doc;
  const positions: number[] = [];
  const add = (pos: number) => {
    const $pos = doc.resolve(pos);
    if (isValidBlockGap($pos) && $pos.nodeAfter?.type.name !== 'frontmatter') positions.push(pos);
  };
  doc.forEach((_node, pos) => add(pos));
  add(doc.content.size);
  return positions;
}

afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); });

describe('block gap cursor', () => {
  it.each(['end', 'card', 'text'])('Backspace removes only the empty paragraph after a non-selectable block before %s', following => {
    const editor = createEditor();
    const tail = following === 'end' ? [] : following === 'card'
      ? [{ type: 'card' }]
      : [{ type: 'paragraph', content: [{ type: 'text', text: 'keep' }] }];
    editor.commands.setContent({ type: 'doc', content: [{ type: 'card' }, { type: 'paragraph' }, ...tail] });
    editor.commands.setTextSelection(2);
    editor.view.dispatch(closeHistory(editor.state.tr));
    const before = editor.getJSON();
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    expect(editor.getJSON().content).toEqual([{ type: 'card' }, ...tail]);
    if (following !== 'text') expect(editor.state.selection).toBeInstanceOf(GapCursor);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });

  it('Backspace at the collapsed gap keeps the preceding block intact', () => {
    const editor = createEditor();
    editor.commands.setContent({ type: 'doc', content: [{ type: 'card' }, { type: 'paragraph' }] });
    editor.commands.setTextSelection(2);
    for (let i = 0; i < 2; i++) {
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    }
    expect(editor.getJSON().content).toEqual([{ type: 'card' }]);
  });

  it('supports adjacent cards and document edges despite frontmatter schema ordering', () => {
    const editor = createEditor();
    for (const pos of [0, 1, 2]) expect(isValidBlockGap(editor.state.doc.resolve(pos))).toBe(true);
    expect(editor.view.dom.querySelectorAll('.editor-block-gap')).toHaveLength(3);
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('opens gaps around a code block so a card below it stays reachable', () => {
    const editor = createEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'codeBlock', content: [{ type: 'text', text: 'const a = 1;' }] },
        { type: 'card' },
      ],
    });
    const between = editor.state.doc.child(0).nodeSize;
    // A code block holds inline content, so without `createGapCursor` on its
    // schema both of its sides are "open" and no gap — hence no insertion line —
    // could exist between it and the card.
    expect(isValidBlockGap(editor.state.doc.resolve(between))).toBe(true);
    expect(isValidBlockGap(editor.state.doc.resolve(0))).toBe(true);
    expect(editor.view.dom.querySelectorAll('.editor-block-gap')).toHaveLength(3);
  });

  it('keeps ordinary text blocks free of gaps', () => {
    const editor = createEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
    const between = editor.state.doc.child(0).nodeSize;
    expect(isValidBlockGap(editor.state.doc.resolve(between))).toBe(false);
    expect(editor.view.dom.querySelectorAll('.editor-block-gap')).toHaveLength(0);
  });

  it('clicks a boundary without changing the document', () => {
    const editor = createEditor();
    const before = editor.state.doc;
    editor.view.dom.querySelectorAll('.editor-block-gap__hit')[1]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it.each(['isolatingText', 'atomText'])('preserves gaps around a %s block containing text', type => {
    const editor = createEditor();
    editor.commands.setContent({ type: 'doc', content: [
      { type, content: [{ type: 'text', text: 'keep' }] },
      { type: 'card' },
    ] });
    expect(editor.view.dom.querySelectorAll('.editor-block-gap')).toHaveLength(3);
  });

  it('matches upstream gap rules across ordinary and special block neighbors', () => {
    const editor = createEditor();
    const blocks = [
      { type: 'paragraph' },
      ...['paragraph', 'heading', 'codeBlock', 'isolatingText', 'atomText'].map(type => ({
        type, content: [{ type: 'text', text: 'text' }],
      })),
      { type: 'card' },
      { type: 'frontmatter' },
    ];
    for (const before of blocks) for (const after of blocks) {
      editor.commands.setContent({ type: 'doc', content: [before, after] });
      expect(editor.view.dom.querySelectorAll('.editor-block-gap').length,
        `${before.type} / ${after.type}`).toBe(expectedGapPositions(editor).length);
    }
  });

  it('keeps clickable gaps correct after editing and undoing a mixed document', () => {
    const editor = createEditor();
    editor.commands.setContent({ type: 'doc', content: [
      { type: 'frontmatter' },
      { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'code' }] },
      { type: 'card' },
    ] });
    const check = () => {
      const expected = expectedGapPositions(editor);
      expect(expected).toHaveLength(2);
      expect(editor.view.dom.querySelectorAll('.editor-block-gap')).toHaveLength(expected.length);
      expected.forEach((pos, index) => {
        editor.view.dom.querySelectorAll('.editor-block-gap__hit')[index]
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        expect(editor.state.selection).toBeInstanceOf(GapCursor);
        expect(editor.state.selection.from).toBe(pos);
      });
    };
    check();
    editor.commands.setTextSelection(3);
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.insertContent('edit');
    check();
    editor.commands.undo();
    check();
  });

  it('avoids resolving every boundary in a large ordinary text document', () => {
    const editor = createEditor();
    editor.commands.setContent({ type: 'doc', content: Array.from({ length: 500 }, () => ({
      type: 'paragraph', content: [{ type: 'text', text: 'ordinary text' }],
    })) });
    const resolve = vi.spyOn(editor.state.doc, 'resolve');
    try {
      // Count expensive operations rather than elapsed time so this guard is
      // stable on both Windows and macOS, including slower CI machines.
      editor.view.someProp('decorations', decorations => {
        decorations(editor.state);
        return false;
      });
      expect(resolve.mock.calls.length).toBeLessThan(10);
      expect(editor.view.dom.querySelectorAll('.editor-block-gap')).toHaveLength(0);
    } finally {
      resolve.mockRestore();
    }
  });

  it('Enter creates a paragraph and undo restores the two adjacent cards', () => {
    const editor = createEditor();
    selectGap(editor);
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('types directly into a paragraph instead of generating frontmatter', () => {
    const editor = createEditor();
    selectGap(editor);
    editor.view.someProp('handleTextInput', handler => handler(editor.view, 1, 1, '你好', () => editor.state.tr));
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('你好');
  });

  it('does not replay input when a transaction filter rejects paragraph creation', () => {
    const editor = createEditor();
    selectGap(editor);
    const before = editor.state.doc;
    let rejected = 0;
    editor.registerPlugin(new Plugin({
      filterTransaction(tr) {
        if (!tr.docChanged) return true;
        rejected += 1;
        return false;
      },
    }));
    const handled = editor.view.someProp('handleTextInput', handler => (
      handler(editor.view, 1, 1, '/', () => editor.state.tr)
    ));
    expect(handled).toBe(true);
    expect(rejected).toBe(1);
    expect(editor.state.doc).toBe(before);
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
  });

  it('does not replay input after an appended transaction moves selection out of text', () => {
    const editor = createEditor();
    selectGap(editor);
    editor.registerPlugin(new Plugin({
      appendTransaction(transactions, _oldState, state) {
        if (!transactions.some(tr => tr.docChanged)) return null;
        return state.tr.setSelection(new GapCursor(state.doc.resolve(0)));
      },
    }));
    const handled = editor.view.someProp('handleTextInput', handler => (
      handler(editor.view, 1, 1, '/', () => editor.state.tr)
    ));
    expect(handled).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).textContent).toBe('');
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.from).toBe(0);
  });

  it('creates a text context for IME without consuming the composition event', () => {
    const editor = createEditor();
    selectGap(editor);
    const event = new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: '中', bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(event);
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(event.defaultPrevented).toBe(false);
  });

  it('pastes at the gap and keeps following content intact', () => {
    const editor = createEditor();
    selectGap(editor);
    editor.view.pasteText('pasted', new Event('paste') as ClipboardEvent);
    expect(editor.state.doc.textContent).toBe('pasted');
    expect(editor.state.doc.firstChild?.type.name).toBe('card');
    expect(editor.state.doc.lastChild?.type.name).toBe('card');
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('moves between adjacent boundaries with arrow keys', () => {
    const editor = createEditor();
    selectGap(editor, 0);
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.from).toBe(1);
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(editor.state.selection.from).toBe(0);
  });

  it('does not expose insertion zones or mutate a read-only editor', () => {
    const editor = createEditor();
    selectGap(editor);
    editor.setEditable(false);
    expect(editor.view.dom.querySelectorAll('.editor-block-gap')).toHaveLength(0);
    const before = editor.state.doc;
    editor.view.someProp('handleTextInput', handler => handler(editor.view, 1, 1, 'blocked', () => editor.state.tr));
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('leaves ordinary text selections alone and protects the frontmatter prefix', () => {
    const editor = createEditor();
    editor.commands.setContent({ type: 'doc', content: [{ type: 'frontmatter' }, { type: 'card' }, { type: 'paragraph' }] });
    expect(editor.view.dom.querySelectorAll('.editor-block-gap')).toHaveLength(1);
    editor.commands.setTextSelection(3);
    expect(paragraphAtGap(editor.state)).toBeNull();
  });
});
