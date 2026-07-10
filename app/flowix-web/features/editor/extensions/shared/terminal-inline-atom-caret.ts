import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Adds a view-only zero-width caret anchor after inline atom nodes that end a
 * textblock. The anchor is not part of the document and is never serialized.
 */
export function createTerminalInlineAtomCaretDecorations(
  doc: ProseMirrorNode,
  nodeTypeNames: string | readonly string[],
): DecorationSet {
  const names = Array.isArray(nodeTypeNames) ? nodeTypeNames : [nodeTypeNames];
  const nameSet = new Set(names);
  const decorations: Decoration[] = [];

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!nameSet.has(node.type.name)) return;

    const afterPos = pos + node.nodeSize;
    const $after = doc.resolve(afterPos);
    if (!$after.parent.isTextblock) return;
    if ($after.parentOffset !== $after.parent.content.size) return;

    decorations.push(Decoration.widget(
      afterPos,
      () => {
        const anchor = document.createElement('span');
        anchor.className = 'terminal-inline-atom-caret-anchor';
        anchor.setAttribute('aria-hidden', 'true');
        anchor.appendChild(document.createTextNode('\u200B'));
        return anchor;
      },
      {
        key: `terminal-inline-atom-caret-${node.type.name}-${afterPos}`,
        side: 1,
      },
    ));
  });

  return DecorationSet.create(doc, decorations);
}
