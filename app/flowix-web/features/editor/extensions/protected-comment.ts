import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** Explicitly reserved for replacing the entire document from an external source. */
export const REPLACE_PROTECTED_COMMENTS_META = 'flowix:replace-protected-comments';
const BEGIN = 'FLOWIX_MANAGED_INSTRUCTIONS_BEGIN';
const END = 'FLOWIX_MANAGED_INSTRUCTIONS_END';

function isProtectedComment(node: ProseMirrorNode): boolean {
  if (node.type.name !== 'preservedHtmlBlock' && node.type.name !== 'preservedHtmlInline') return false;
  const html = String(node.attrs.html ?? '').trim();
  const lines = html.split(/\r?\n/).map(line => line.trim());
  return lines[0] === '<!--' && lines[1] === BEGIN
    && lines[lines.length - 2] === END && lines[lines.length - 1] === '-->'
    && !lines.slice(1, -1).some(line => line.includes('-->'));
}

function protectedComments(doc: ProseMirrorNode): { node: ProseMirrorNode; pos: number }[] {
  const found: { node: ProseMirrorNode; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (isProtectedComment(node)) found.push({ node, pos });
  });
  return found;
}

/** Delete selected editable ranges from right to left, retaining hidden atoms. */
function deleteAroundComments(view: EditorView, text?: string, slice?: Slice): boolean {
  const { state } = view;
  const { from, to } = state.selection;
  const comments = protectedComments(state.doc).filter(({ node, pos }) => pos < to && pos + node.nodeSize > from);
  if (!comments.length) return false;
  const tr = state.tr;
  let end = to;
  for (const { node, pos } of comments.reverse()) {
    const after = Math.min(to, pos + node.nodeSize);
    if (end > after) tr.delete(after, end);
    end = Math.max(from, pos);
  }
  if (end > from) tr.delete(from, end);
  if (text || slice) {
    const position = Math.min(tr.mapping.map(from, -1), tr.doc.content.size);
    const $position = tr.doc.resolve(position);
    const selection = Selection.findFrom($position, 1, true) ?? Selection.findFrom($position, -1, true);
    if (selection instanceof TextSelection) {
      tr.setSelection(selection);
      if (text) tr.insertText(text);
      else if (slice) tr.replaceSelection(slice);
    } else {
      const paragraph = state.schema.nodes.paragraph;
      if (!paragraph) return false;
      if (text) tr.insert(position, paragraph.create(null, state.schema.text(text)));
      else if (slice) tr.replaceRange(position, position, slice);
    }
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Protect Flowix-owned hidden comments, without affecting ordinary comments. */
export const ProtectedComment = Extension.create({
  name: 'protectedComment',
  priority: 1100,
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('protected-comment'),
      filterTransaction(tr, state) {
        if (!tr.docChanged || tr.getMeta(REPLACE_PROTECTED_COMMENTS_META)) return true;
        const before = protectedComments(state.doc);
        if (!before.length) return true;
        const after = protectedComments(tr.doc);
        // A matching count/content also allows normal edits to move comments as
        // surrounding text changes, while rejecting deletion or modification.
        return before.length <= after.length && before.every(({ node }, i) => node.eq(after[i].node));
      },
      props: {
        handleKeyDown(view, event) {
          if ((event.key === 'Backspace' || event.key === 'Delete') && !view.state.selection.empty) {
            return deleteAroundComments(view);
          }
          return false;
        },
        handleTextInput(view, _from, _to, text) {
          return deleteAroundComments(view, text);
        },
        handlePaste(view, _event, slice) {
          return deleteAroundComments(view, undefined, slice);
        },
        handleDOMEvents: {
          cut(view, event) {
            const { from, to } = view.state.selection;
            if (!event.clipboardData || !protectedComments(view.state.doc).some(({ node, pos }) => pos < to && pos + node.nodeSize > from)) return false;
            const clipboard = view.serializeForClipboard(view.state.selection.content());
            event.clipboardData.clearData();
            event.clipboardData.setData('text/html', clipboard.dom.innerHTML);
            event.clipboardData.setData('text/plain', clipboard.text);
            event.preventDefault();
            return deleteAroundComments(view);
          },
        },
      },
    })];
  },
});
