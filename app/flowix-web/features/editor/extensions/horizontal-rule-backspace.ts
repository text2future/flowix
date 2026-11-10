import { Extension } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, type EditorState, type Selection as PMSelection, type Transaction } from '@tiptap/pm/state';
import { isValidBlockGap } from './block-gap-cursor';

/**
 * Where the caret lands after crossing the divider. `dividerPos` is the
 * divider's own position, so everything above it lives in `0..dividerPos`; a
 * divider that opens the document leaves nothing to step into.
 */
function selectionAboveDivider(doc: ProseMirrorNode, dividerPos: number, divider: ProseMirrorNode): PMSelection | null {
  if (dividerPos > 0) {
    const previous = doc.resolve(dividerPos).nodeBefore;
    // Only a text block can take the caret; tables, lists and code blocks stay
    // block boundaries and fall through to the gap branch below.
    if (previous?.isTextblock) return TextSelection.create(doc, dividerPos - 1);
  }
  // Nothing text-like directly above: sit in the gap before the divider so
  // typing still starts a block above it.
  const $gap = doc.resolve(dividerPos);
  if (isValidBlockGap($gap)) return new GapCursor($gap);
  // Lists and tables are not closed blocks, so no gap exists beside them; the
  // end of their last text block is the equivalent landing spot.
  const near = Selection.near($gap, -1);
  if (near) return near;
  return NodeSelection.isSelectable(divider) ? NodeSelection.create(doc, dividerPos) : null;
}

/**
 * Resolves Backspace at the start of a block that sits directly below a
 * divider. Returns null whenever the key belongs to someone else.
 */
function backspaceTransaction(state: EditorState): Transaction | null {
  const { selection } = state;

  // A gap cursor sitting right below the divider (clicked into the boundary
  // between the divider and the next block) crosses it the same way. Handling
  // it here also keeps the list keymap from reading `$anchor.before()` at the
  // top level, which throws.
  if (selection instanceof GapCursor) {
    const gapPos = selection.from;
    const divider = gapPos > 0 ? state.doc.resolve(gapPos).nodeBefore : null;
    if (divider?.type.name !== 'horizontalRule') return null;
    const gapTarget = selectionAboveDivider(state.doc, gapPos - 1, divider);
    // Never fall through to the native keymaps: at the top level they throw.
    return gapTarget ? state.tr.setSelection(gapTarget).scrollIntoView() : state.tr;
  }

  if (!(selection instanceof TextSelection) || !selection.empty) return null;

  const { $from } = selection;
  // Only the very start of a normal text block looks "backwards" into the
  // divider. Code blocks own their own Backspace (line joining), so leave them.
  if (!$from.parent.isTextblock || $from.parent.type.spec.code || $from.parentOffset !== 0) return null;

  const blockStart = $from.before();
  const divider = state.doc.resolve(blockStart).nodeBefore;
  if (divider?.type.name !== 'horizontalRule') return null;

  const dividerPos = blockStart - divider.nodeSize;
  const target = selectionAboveDivider(state.doc, dividerPos, divider);

  // A block with text is never removed: only the caret crosses the divider.
  // Without this the editor keymap runs `undoInputRule` first, which turns a
  // divider created by typing `---` back into that literal text.
  if ($from.parent.content.size > 0) {
    return target ? state.tr.setSelection(target).scrollIntoView() : null;
  }

  // An empty block still collapses on its own Backspace; the divider is kept.
  // Skip the delete when the container requires this child, otherwise replace
  // fitting would synthesize a replacement block.
  const container = $from.node(-1);
  if (!container.canReplace($from.index(-1), $from.index(-1) + 1)) {
    return target ? state.tr.setSelection(target).scrollIntoView() : null;
  }

  const tr = state.tr.delete(blockStart, $from.after());
  // The delete only touches content after `dividerPos`, so the region above it
  // is unchanged; resolve the selection against the new document regardless.
  const nextDivider = tr.doc.nodeAt(dividerPos);
  if (!nextDivider) return tr;
  const nextTarget = selectionAboveDivider(tr.doc, dividerPos, nextDivider);
  return nextTarget ? tr.setSelection(nextTarget).scrollIntoView() : tr;
}

/**
 * Backspace at the start of the block below a divider crosses the divider
 * instead of selecting it or undoing the input rule that created it. An empty
 * block below the divider is deleted as usual.
 */
export const HorizontalRuleBackspace = Extension.create({
  name: 'horizontalRuleBackspace',
  // Above the editor keymap (100) but below the slash menu (1150), which must
  // keep owning Backspace while a query is being typed.
  priority: 1100,

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { editor } = this;
        if (!editor.isEditable) return false;

        const tr = backspaceTransaction(editor.state);
        if (!tr) return false;

        editor.view.dispatch(tr);
        return true;
      },
    };
  },
});
