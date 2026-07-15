import { isTextSelection, type Editor } from '@tiptap/core';

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
