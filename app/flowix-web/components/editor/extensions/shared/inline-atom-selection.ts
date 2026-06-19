import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export function setInlineAtomTextSelectionFromMouse(options: {
  view: EditorView;
  node: ProseMirrorNode;
  pos: number;
  event: MouseEvent;
  referenceElement: Element | HTMLElement | null;
}): void {
  const { view, node, pos, event, referenceElement } = options;
  const rect = (referenceElement instanceof HTMLElement ? referenceElement : view.dom).getBoundingClientRect();
  const after = event.clientX >= rect.left + rect.width / 2;
  const targetPos = pos + (after ? node.nodeSize : 0);
  const $target = view.state.doc.resolve(targetPos);
  const selection = TextSelection.near($target, after ? 1 : -1);

  view.dispatch(view.state.tr.setSelection(selection));
  view.focus();
}
