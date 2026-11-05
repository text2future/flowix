import { Plugin, TextSelection } from '@tiptap/pm/state';

/** Text gestures stay separate from view-only cell highlight decorations. */
export function createTableTextSelectionPlugin() {
  return new Plugin({
    props: {
      // prosemirror-tables' handleTripleClick selects a whole cell. Handle the
      // textblock first, matching the editor's ordinary paragraph selection.
      handleTripleClickOn(view, pos, node, nodePos, event) {
        if (event.button !== 0) return false;
        const cellRole = node.type.spec.tableRole;
        if (cellRole === 'cell' || cellRole === 'header_cell') {
          // Padding/empty-space clicks may report the cell rather than its
          // paragraph. Resolve the closest textblock instead of falling back
          // to prosemirror-tables' whole-cell selection.
          const near = TextSelection.near(view.state.doc.resolve(
            Math.max(nodePos + 1, Math.min(pos, nodePos + node.nodeSize - 1)),
          ));
          if (near.$from.parent.inlineContent
            && near.from > nodePos && near.to < nodePos + node.nodeSize) {
            view.focus();
            view.dispatch(view.state.tr.setSelection(TextSelection.create(
              view.state.doc, near.$from.start(), near.$from.end(),
            )).setMeta('pointer', true));
          }
          return true;
        }
        if (!node.inlineContent) return false;
        const $node = view.state.doc.resolve(nodePos);
        for (let depth = $node.depth; depth > 0; depth -= 1) {
          const role = $node.node(depth).type.spec.tableRole;
          if (role !== 'cell' && role !== 'header_cell') continue;
          view.focus();
          view.dispatch(view.state.tr.setSelection(TextSelection.create(
            view.state.doc, nodePos + 1, nodePos + 1 + node.content.size,
          )).setMeta('pointer', true));
          return true;
        }
        return false;
      },
    },
  });
}
