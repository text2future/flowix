import { Extension } from '@tiptap/core';
import { GapCursor, gapCursor } from '@tiptap/pm/gapcursor';
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, Plugin, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// ProseMirror uses this validator internally but omits it from its public types.
// Keep the compatibility boundary here so hot zones use precisely its rules.
export function isValidBlockGap($pos: ResolvedPos): boolean {
  return (GapCursor as typeof GapCursor & { valid(pos: ResolvedPos): boolean }).valid($pos);
}

// Ordinary inline content makes a boundary invalid. Check this before resolve,
// which scans the document's preceding siblings for every candidate position.
// Special text blocks (including code blocks) still use GapCursor's validator.
function isOpenTextBlock(node: ProseMirrorNode | null): boolean {
  return !!node && node.inlineContent && !node.isAtom
    && !node.type.spec.isolating && !node.type.spec.createGapCursor;
}

function createBlockGapWidget(pos: number): Decoration {
  return Decoration.widget(pos, (view, getPos) => {
    const boundary = document.createElement('div');
    boundary.className = 'editor-block-gap';
    boundary.contentEditable = 'false';
    const hit = document.createElement('span');
    hit.className = 'editor-block-gap__hit';
    hit.setAttribute('aria-hidden', 'true');
    hit.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || !view.editable) return;
      // Decorations can survive edits. Resolve the current position on click.
      const position = getPos();
      if (position === undefined) return;
      const resolved = view.state.doc.resolve(position);
      if (!isValidBlockGap(resolved)) return;
      event.preventDefault();
      view.dispatch(view.state.tr.setSelection(new GapCursor(resolved)));
      view.focus();
    });
    boundary.appendChild(hit);
    return boundary;
  }, { key: `block-gap-${pos}`, side: -1, stopEvent: () => true });
}

function buildBlockGapDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  const addBoundary = (pos: number, index: number) => {
    const before = index > 0 ? doc.child(index - 1) : null;
    const after = index < doc.childCount ? doc.child(index) : null;
    // Performance contract: filter BEFORE resolve. Resolving every boundary
    // repeatedly scans preceding siblings, making many-block documents O(n²).
    // This is only a rejection filter; GapCursor remains the final authority.
    if (isOpenTextBlock(before) || isOpenTextBlock(after)) return;
    const $pos = doc.resolve(pos);
    if (!isValidBlockGap($pos) || after?.type.name === 'frontmatter') return;
    decorations.push(createBlockGapWidget(pos));
  };
  doc.forEach((_node, pos, index) => addBoundary(pos, index));
  addBoundary(doc.content.size, doc.childCount);
  return DecorationSet.create(doc, decorations);
}

/** Never let schema ordering choose frontmatter as the new text container. */
export function paragraphAtGap(state: EditorState): Transaction | null {
  if (!(state.selection instanceof GapCursor)) return null;
  const { $from } = state.selection;
  if ($from.nodeAfter?.type.name === 'frontmatter') return null;
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph || !$from.parent.canReplaceWith($from.index(), $from.index(), paragraph)) return null;
  const tr = state.tr.insert($from.pos, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, $from.pos + 1));
}

// Normalize typing before menus; keep gap navigation below editor keymaps.
// Paste stays on the existing pipeline, preserving uploads, metadata, and undo.
const BlockGapInput = Extension.create({
  name: 'blockGapInput',
  priority: 1200,
  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { state, view } = this.editor;
        const { selection } = state;
        if (!this.editor.isEditable || !(selection instanceof TextSelection) || !selection.empty) return false;
        const { $from } = selection;
        if ($from.parent.type.name !== 'paragraph' || $from.parent.content.size !== 0) return false;
        const start = $from.before();
        const $start = state.doc.resolve(start);
        const previous = $start.nodeBefore;
        // Keep native media selection after removing its empty sibling, but
        // do not reveal the entire media rectangle: that can pull the viewport
        // back to the top of a tall image or video.
        if (previous && ['videoAttachment', 'videoEmbed', 'image'].includes(previous.type.name)) {
          if (!$start.parent.canReplace($start.index(), $start.index() + 1)) return true;
          const tr = state.tr.delete(start, $from.after());
          tr.setSelection(NodeSelection.create(tr.doc, start - previous.nodeSize));
          view.dispatch(tr);
          return true;
        }
        // Native joinBackward deletes non-selectable atoms instead of the
        // empty paragraph. Collapse the paragraph to a gap without touching
        // the embedded document or focusing its nested editor.
        if (!previous?.isBlock || !previous.isAtom || NodeSelection.isSelectable(previous)
          || previous.type.name === 'frontmatter') return false;
        // Delete only this sibling, without letting replace fitting lift a
        // list item or synthesize replacement content for a required child.
        if (!$start.parent.canReplace($start.index(), $start.index() + 1)) return true;
        const tr = state.tr.delete(start, $from.after());
        const $gap = tr.doc.resolve(start);
        tr.setSelection(isValidBlockGap($gap) ? new GapCursor($gap) : Selection.near($gap));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (!view.editable || event.isComposing || event.key !== 'Enter'
              || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
            const tr = paragraphAtGap(view.state);
            if (!tr) return false;
            view.dispatch(tr.scrollIntoView());
            return true;
          },
          handleTextInput(view, _from, _to, text) {
            if (!view.editable) return false;
            const tr = paragraphAtGap(view.state);
            if (!tr) return false;
            const previousDoc = view.state.doc;
            view.dispatch(tr);
            const selection = view.state.selection;
            // Filters can reject insertion; appended transactions can move the
            // selection again. Consume the event without replaying it unless
            // normalization actually produced a collapsed text context.
            if (view.state.doc === previousDoc || !(selection instanceof TextSelection)
              || !selection.empty || !selection.$from.parent.isTextblock) return true;
            // The original positions describe a gap, not text. Re-enter the
            // input chain with the new text selection so slash menus and input
            // rules see exactly the same event as they do in a normal paragraph.
            const { from, to } = selection;
            const insertText = () => view.state.tr.insertText(text, from, to).scrollIntoView();
            const handled = view.someProp('handleTextInput', handler => handler(view, from, to, text, insertText));
            if (!handled) view.dispatch(insertText());
            return true;
          },
          handleDOMEvents: {
            beforeinput(view, event) {
              if (!view.editable || (event as InputEvent).inputType !== 'insertCompositionText') return false;
              const tr = paragraphAtGap(view.state);
              if (tr) view.dispatch(tr);
              // Keep the native IME event alive in the newly created paragraph.
              return false;
            },
          },
        },
      }),
    ];
  },
});

export const BlockGapCursor = Extension.create({
  name: 'blockGapCursor',
  // Interaction menus and normal editor keymaps get first refusal.
  priority: 50,

  addExtensions() {
    return [BlockGapInput];
  },

  extendNodeSchema(extension) {
    // GapCursor still checks that both sides are closed blocks. Override only
    // the defaultType test, which can otherwise pick the frontmatter node.
    if (extension.name === 'doc') return { allowGapCursor: true };
    // Code blocks need a gap point on both sides too, but they can never be a
    // leaf: unlike the card (`content: ''` → isLeaf → isAtom) or the image,
    // math and web-card nodes (`atom: true`), a code block must hold text, so
    // `closedBefore`/`closedAfter` see inline content and reject every position
    // next to it. `createGapCursor` is the same `needsGap()` branch as `isAtom`,
    // declared instead of structural — the upstream-sanctioned escape hatch for
    // exactly this shape. Requires prosemirror-gapcursor >= 1.4.0; on an older
    // version the field is ignored silently and the insertion points disappear.
    return extension.name === 'codeBlock' ? { createGapCursor: true } : {};
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          decorations(state) {
            return editor.isEditable ? buildBlockGapDecorations(state.doc) : null;
          },
        },
      }),
      gapCursor(),
    ];
  },
});
