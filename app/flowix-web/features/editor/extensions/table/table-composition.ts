import { Plugin, TextSelection } from '@tiptap/pm/state';
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { schemaSerializer } from './table-html';

/** Repair malformed empty-cell DOM left by WebKit when Apple IME commits. */
export function createTableCompositionPlugin() {
  let emptyCell: { dom: HTMLElement; paragraph: ProseMirrorNode; marks: readonly Mark[] } | null = null;
  return new Plugin({
    props: {
      handleDOMEvents: {
        compositionstart(view) {
          emptyCell = null;
          const { selection } = view.state;
          if (!view.editable || !(selection instanceof TextSelection) || !selection.empty) return false;
          const { $from } = selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            const cell = $from.node(depth);
            if (!['cell', 'header_cell'].includes(cell.type.spec.tableRole ?? '')) continue;
            if (cell.childCount === 1 && cell.firstChild?.type.name === 'paragraph' && cell.firstChild.content.size === 0) {
              const dom = view.nodeDOM($from.before(depth));
              if (dom instanceof HTMLElement) emptyCell = {
                dom, paragraph: cell.firstChild, marks: view.state.storedMarks ?? $from.marks(),
              };
            }
            break;
          }
          return false;
        },
        input(view, event) {
          const input = event as InputEvent;
          if (input.inputType !== 'insertFromComposition' || !input.data || !view.editable) return false;
          const context = emptyCell;
          const cell = context?.dom;
          const row = cell?.parentElement;
          if (!context || !cell?.isConnected || row?.tagName !== 'TR'
            || !cell.childNodes.length || !Array.from(cell.childNodes).every(node => node.nodeName === 'BR')) return false;
          const selection = cell.ownerDocument.getSelection();
          if (!selection?.isCollapsed || !selection.anchorNode || cell.contains(selection.anchorNode)) return false;
          let committed: Node = selection.anchorNode;
          while (committed.parentNode && committed.parentNode !== row) committed = committed.parentNode;
          if (committed.parentNode !== row || committed.textContent !== input.data) return false;
          const next = committed.nextSibling;
          const strayBreak = next?.nodeName === 'BR' && next.nextSibling === cell ? next : null;
          if (next !== cell && !strayBreak) return false;
          if (committed.nodeType !== 3 && !['B', 'STRONG', 'SPAN'].includes(committed.nodeName)) return false;

          // Apple IME can commit outside the empty cell, adding B for inherited
          // header weight. Normalize before the DOM observer parses that stray
          // wrapper as a user mark and loses the caret while rebuilding it.
          const paragraph = context.paragraph.type.create(context.paragraph.attrs,
            view.state.schema.text(input.data, context.marks), context.paragraph.marks);
          const dom = schemaSerializer(view.state.schema).serializeNode(paragraph, { document: cell.ownerDocument });
          cell.replaceChildren(dom);
          committed.parentNode.removeChild(committed);
          strayBreak?.remove();
          const range = cell.ownerDocument.createRange();
          range.selectNodeContents(dom);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
          return false;
        },
        compositionend() {
          const cell = emptyCell?.dom;
          emptyCell = null;
          if (!cell?.isConnected) return false;
          // WebKit replaces the empty paragraph with a bare BR when ending
          // Apple IME composition, moving committed text into the table row.
          // ProseMirror repairs that text, but the bare placeholder can then
          // become a real hardBreak. Remove only the invalid, direct-child BR;
          // paragraph-owned breaks (including intentional ones) stay intact.
          for (const child of Array.from(cell.childNodes)) {
            if (child.nodeName === 'BR') child.remove();
          }
          return false;
        },
      },
    },
    view() {
      return { destroy() { emptyCell = null; } };
    },
  });
}
