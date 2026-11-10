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

/** Top-level node types that render editor chrome instead of document content. */
export const FRONTMATTER_NODE_TYPE = 'frontmatter';
export const AGENT_CARD_NODE_TYPE = 'agentThreadCard';

export interface FirstBlock {
  node: ProseMirrorNode;
  index: number;
  from: number;
  to: number;
}

/**
 * Range of the first top-level block whose type is not in `skippedTypes`.
 *
 * Callers intentionally skip different chrome: body navigation skips the
 * frontmatter row only, while the first-block CSS marks also skip a leading
 * agent card (the card carries its own top offset, but the gap above it still
 * needs the caret compensation). Each caller owns its skip set; this stays the
 * single traversal over the document.
 */
export function findFirstBlock(
  doc: ProseMirrorNode,
  skippedTypes: ReadonlySet<string>,
): FirstBlock | null {
  let from = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const node = doc.child(index);
    if (!skippedTypes.has(node.type.name)) {
      return { node, index, from, to: from + node.nodeSize };
    }
    from += node.nodeSize;
  }
  return null;
}

const BODY_START_SKIPS: ReadonlySet<string> = new Set([FRONTMATTER_NODE_TYPE]);

/**
 * Find the first real body block without treating the protected frontmatter
 * node (which renders the tag row) as document content.
 */
export function getEditableBodyStart(editor: Editor): EditableBodyStart {
  const first = findFirstBlock(editor.state.doc, BODY_START_SKIPS);
  if (!first) {
    return {
      block: null,
      blockIndex: editor.state.doc.childCount,
      position: editor.state.doc.content.size,
    };
  }
  return { block: first.node, blockIndex: first.index, position: first.from };
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
