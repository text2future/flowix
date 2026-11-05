import { Plugin, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** View-only marker; focus styling is gated by the editor's focused/editable DOM state. */
export function createTableEditingCellPlugin() {
  return new Plugin({
    props: {
      decorations(state) {
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return null;
        const { $from, $to } = selection;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          const role = $from.node(depth).type.spec.tableRole;
          if (role !== 'cell' && role !== 'header_cell') continue;
          if ($to.pos > $from.end(depth)) return null;
          return DecorationSet.create(state.doc, [
            Decoration.node($from.before(depth), $from.after(depth), { class: 'table-editing-cell' }),
          ]);
        }
        return null;
      },
    },
  });
}
