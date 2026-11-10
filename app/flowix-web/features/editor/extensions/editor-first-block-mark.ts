import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  AGENT_CARD_NODE_TYPE,
  FRONTMATTER_NODE_TYPE,
  findFirstBlock,
} from '../editor-body-navigation';

/**
 * The stylesheet asks two different "first block" questions, and they
 * historically disagreed about an agent card at the top of a document:
 *
 * - `.editor-first-block` — first *content* block. A leading agent card is
 *   chrome (it carries its own top offset), so it is skipped.
 * - `.editor-leading-block` — first block after the frontmatter, card included,
 *   because the gap widget above that card still needs the caret compensation.
 *
 * Both are node decorations instead of `:has(+ :nth-child(1 of …))`: WebKit
 * re-scans siblings per element for an `of S` nth-child inside `:has()`, which
 * made a 100 KB note with 103 code blocks spend 32–39 s inside `Editor.mount()`
 * (0.2 s with these classes). See the note in `styles/editor.css` and the guard
 * in `styles/selector-cost.test.ts`.
 */
const FIRST_CONTENT_BLOCK_SKIPS: ReadonlySet<string> = new Set([
  FRONTMATTER_NODE_TYPE,
  AGENT_CARD_NODE_TYPE,
]);
const LEADING_BLOCK_SKIPS: ReadonlySet<string> = new Set([FRONTMATTER_NODE_TYPE]);
const FIRST_CONTENT_BLOCK_CLASS = 'editor-first-block';
const LEADING_BLOCK_CLASS = 'editor-leading-block';

const firstBlockMarkKey = new PluginKey<DecorationSet>('editorFirstBlockMark');

function buildFirstBlockDecorations(doc: ProseMirrorNode): DecorationSet {
  // `leading` skips less than `content`, so it always starts at or before it and
  // a missing leading block implies a missing content block.
  const leading = findFirstBlock(doc, LEADING_BLOCK_SKIPS);
  if (!leading) return DecorationSet.empty;

  const content = findFirstBlock(doc, FIRST_CONTENT_BLOCK_SKIPS);
  const sameBlock = content !== null && content.from === leading.from;
  const decorations = [
    Decoration.node(leading.from, leading.to, {
      // A node decoration overrides rather than appends `class`, so both marks
      // have to travel on one decoration when they land on the same block.
      class: sameBlock
        ? `${FIRST_CONTENT_BLOCK_CLASS} ${LEADING_BLOCK_CLASS}`
        : LEADING_BLOCK_CLASS,
    }),
  ];
  if (content && !sameBlock) {
    decorations.push(Decoration.node(content.from, content.to, { class: FIRST_CONTENT_BLOCK_CLASS }));
  }
  return DecorationSet.create(doc, decorations);
}

export const EditorFirstBlockMark = Extension.create({
  name: 'editorFirstBlockMark',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: firstBlockMarkKey,
        // Recompute on document changes only: selection and typing inside a
        // block cannot move the mark.
        state: {
          init: (_config, state) => buildFirstBlockDecorations(state.doc),
          apply: (transaction, value) => (
            transaction.docChanged ? buildFirstBlockDecorations(transaction.doc) : value
          ),
        },
        props: {
          decorations: (state) => firstBlockMarkKey.getState(state),
        },
      }),
    ];
  },
});
