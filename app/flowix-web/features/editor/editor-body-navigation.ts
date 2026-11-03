import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

/**
 * 文档层定位助手：把「正文从哪开始 / 是否为空 / 怎么造空段落」与编辑器组件解耦。
 * 全部只读 `editor.state`, 不持有外面任何 ref, 所以可以独立演进和测试。
 */
export interface EditableBodyStart {
  block: ProseMirrorNode | null;
  blockIndex: number;
  position: number;
}

/**
 * Find the first real body block without treating the protected frontmatter
 * node (which renders the tag row) as document content.
 */
export function getEditableBodyStart(editor: Editor): EditableBodyStart {
  let position = 0;
  for (let index = 0; index < editor.state.doc.childCount; index += 1) {
    const block = editor.state.doc.child(index);
    if (block.type.name !== 'frontmatter') {
      return { block, blockIndex: index, position };
    }
    position += block.nodeSize;
  }

  return {
    block: null,
    blockIndex: editor.state.doc.childCount,
    position,
  };
}

export function isBlankEditorDocument(editor: Editor): boolean {
  const { block, blockIndex } = getEditableBodyStart(editor);
  return !block || Boolean(
    blockIndex === editor.state.doc.childCount - 1 &&
    block.type.name === 'paragraph' &&
    block.textContent.trim() === '',
  );
}

export function createEmptyParagraph(editor: Editor, text?: string): ProseMirrorNode {
  const paragraph = editor.state.schema.nodes.paragraph;
  return paragraph.create(null, text ? editor.state.schema.text(text) : undefined);
}

/**
 * WebKit can fail to place the native caret in an empty paragraph immediately
 * after a non-editable block NodeView. The first click then only focuses the
 * editor and a second click is needed before typing works. Resolve that
 * paragraph explicitly while a media block is selected.
 */
export function focusEmptyParagraphAfterMedia(
  view: Editor['view'],
  event: MouseEvent,
): boolean {
  if (event.button !== 0) return false;

  const selection = view.state.selection;
  if (
    !(selection instanceof NodeSelection) ||
    (selection.node.type.name !== 'image' && selection.node.type.name !== 'videoAttachment')
  ) return false;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;

  const paragraph = target.closest('p');
  if (
    !(paragraph instanceof HTMLElement) ||
    !view.dom.contains(paragraph) ||
    paragraph.textContent !== '' ||
    paragraph.closest('[contenteditable="false"]')
  ) return false;

  try {
    const textPosition = view.posAtDOM(paragraph, 0);
    const nextSelection = TextSelection.create(view.state.doc, textPosition);
    if (!nextSelection.$from.parent.isTextblock || !nextSelection.empty) return false;

    view.dispatch(view.state.tr.setSelection(nextSelection).setMeta('pointer', true));
    view.focus();
    event.preventDefault();
    return true;
  } catch {
    // The DOM may have been replaced between the pointer event and the
    // position lookup (for example while a NodeView is updating).
    return false;
  }
}
