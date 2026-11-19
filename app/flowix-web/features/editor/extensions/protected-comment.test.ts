import { Editor } from '@tiptap/core';
import { AllSelection } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import { afterEach, expect, it } from 'vitest';
import { createMarkdownEditorExtensions, serializeEditorMarkdown } from '../markdown-editor-extensions';
import { REPLACE_PROTECTED_COMMENTS_META } from './protected-comment';

const block = '<!--\nFLOWIX_MANAGED_INSTRUCTIONS_BEGIN\n\nprivate instructions\n\nFLOWIX_MANAGED_INSTRUCTIONS_END\n-->';
const editors: Editor[] = [];
function create(content: string) {
  const editor = new Editor({ extensions: createMarkdownEditorExtensions({ workspaceHost: 'column-1', getPlaceholder: () => '' }), content, contentType: 'markdown' });
  editors.push(editor);
  return editor;
}
function selectAll(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
}
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

it('keeps the protected comment while deleting selected visible content', () => {
  const editor = create(`Before\n\n${block}\n\nAfter`);
  selectAll(editor);
  const handled = editor.view.someProp('handleKeyDown', handler => handler(editor.view, new KeyboardEvent('keydown', { key: 'Backspace' })));
  expect(handled).toBe(true);
  expect(serializeEditorMarkdown(editor)).toContain(block);
  expect(editor.state.doc.textContent).not.toContain('Before');
  expect(editor.state.doc.textContent).not.toContain('After');
  editor.commands.undo();
  expect(editor.state.doc.textContent).toContain('Before');
  editor.commands.redo();
  expect(serializeEditorMarkdown(editor)).toContain(block);
});

it('retains the comment when replacing selected text', () => {
  const editor = create(`Before\n\n${block}\n\nAfter`);
  selectAll(editor);
  const handled = editor.view.someProp('handleTextInput', handler => handler(editor.view, 0, editor.state.doc.content.size, 'New', () => editor.state.tr));
  expect(handled).toBe(true);
  expect(editor.state.doc.textContent).toContain('New');
  expect(serializeEditorMarkdown(editor)).toContain(block);
});

it('pastes into a selection without removing the comment', () => {
  const editor = create(`Before\n\n${block}\n\nAfter`);
  selectAll(editor);
  const slice = new Slice(Fragment.from(editor.schema.text('Pasted')), 0, 0);
  const handled = editor.view.someProp('handlePaste', handler => handler(editor.view, new Event('paste') as ClipboardEvent, slice));
  expect(handled).toBe(true);
  expect(editor.state.doc.textContent).toContain('Pasted');
  expect(serializeEditorMarkdown(editor)).toContain(block);
});

it('blocks unhandled transactions but permits explicit external document replacement', () => {
  const editor = create(`Before\n\n${block}\n\nAfter`);
  const original = editor.state.doc;
  editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.content.size));
  expect(editor.state.doc.eq(original)).toBe(true);
  editor.chain().setMeta(REPLACE_PROTECTED_COMMENTS_META, true).setContent('External', { contentType: 'markdown' }).run();
  expect(editor.state.doc.textContent).toBe('External');
});

it('does not protect ordinary HTML comments', () => {
  const editor = create('Before\n\n<!-- ordinary -->\n\nAfter');
  editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.content.size));
  expect(serializeEditorMarkdown(editor)).not.toContain('ordinary');
});
