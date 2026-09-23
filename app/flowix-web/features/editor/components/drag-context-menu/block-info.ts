import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection } from 'prosemirror-state'

/**
 * Pure ProseMirror-native helper for resolving the "block" the cursor
 * (or a NodeSelection) is currently on. Deterministic given editor state —
 * no React, no DOM mutation, no class manipulation. It is the data layer the
 * drag-context-menu component sits on top of.
 *
 * Naming: `pos` is the open-token position of the node; `nodeSize` is
 * `node.nodeSize` (includes the open and close tokens); `from` / `to`
 * for TextSelection sit just inside the open / close respectively.
 */

export interface CurrentBlockInfo {
  /** The ProseMirror node the user is currently focused on or has selected. */
  node: PMNode
  /** The schema-level name string (e.g. 'heading', 'paragraph', 'image'). */
  typeName: string
  /** The node's attributes (e.g. { level: 2 } for a heading). */
  attrs: Record<string, unknown>
  /** Open-token position of the node in the document. */
  pos: number
  /** Total byte size of the node, for `deleteRange`. */
  nodeSize: number
  /**
   * Outer DOM for the node (from `view.nodeDOM(pos)`), suitable for
   * `getBoundingClientRect` and visual anchoring. Callers may walk up
   * via `closest` to reach a visible block ancestor when desired.
   */
  dom: HTMLElement
}

const LIST_ITEM_TYPES = new Set(['listItem', 'taskItem'])

/** Resolve the block the editor's current selection is on (PM-native, not DOM). */
export function getCurrentBlockInfo(editor: Editor): CurrentBlockInfo | null {
  const view = editor.view
  if (!view) return null
  const { selection } = view.state

  // NodeSelection: the selected node IS the block the user means
  // (e.g. freshly uploaded file attachments).
  if (selection instanceof NodeSelection) {
    const node = selection.node
    const dom = view.nodeDOM(selection.from)
    if (!(dom instanceof HTMLElement)) return null
    return {
      node,
      typeName: node.type.name,
      attrs: node.attrs,
      pos: selection.from,
      nodeSize: node.nodeSize,
      dom,
    }
  }

  // TextSelection / cursor: use the nearest wrapping block when the cursor
  // is inside one. This keeps the handle's visual anchor and the command /
  // drag target aligned for lists, tables, and quotes.
  // Plain text blocks (paragraph, heading, codeBlock, etc.) fall back to the
  // immediate parent.
  const { $from } = selection
  if ($from.depth < 1) return null
  const depth = getTargetBlockDepth($from)
  const node = $from.node(depth)
  const pos = $from.before(depth)
  const dom = view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return null
  return {
    node,
    typeName: node.type.name,
    attrs: node.attrs,
    pos,
    nodeSize: node.nodeSize,
    dom,
  }
}

/**
 * Resolve an AgentThreadCard whose nested composer currently owns focus.
 *
 * The composer is a second ProseMirror editor mounted inside the card's
 * NodeView. In that state the outer editor selection is deliberately cleared
 * (so the card does not remain NodeSelected), which means
 * `getCurrentBlockInfo()` can no longer describe the card. Match the live
 * NodeView DOM back to the document instead of relying on the outer selection.
 */
export function getFocusedAgentThreadCardInfo(editor: Editor): CurrentBlockInfo | null {
  if (editor.isDestroyed) return null

  const view = editor.view
  if (!view || view.isDestroyed) return null

  const activeElement = view.dom.ownerDocument.activeElement
  if (!(activeElement instanceof HTMLElement)) return null

  const composer = activeElement.closest<HTMLElement>('.agent-thread-card__composer')
  if (!composer || !view.dom.contains(composer)) return null

  const card = composer.closest<HTMLElement>('[data-agent-thread-card="true"]')
  if (!card || !view.dom.contains(card)) return null

  let result: CurrentBlockInfo | null = null
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'agentThreadCard') return true
    if (view.nodeDOM(pos) !== card) return true

    result = {
      node,
      typeName: node.type.name,
      attrs: node.attrs,
      pos,
      nodeSize: node.nodeSize,
      dom: card,
    }
    return false
  })

  return result
}

function isCurrentBlockInfo(editor: Editor, info: CurrentBlockInfo): boolean {
  if (editor.isDestroyed || editor.view.isDestroyed) return false

  const { doc } = editor.view.state
  const node = doc.nodeAt(info.pos)
  return !!(
    node &&
    node.type.name === info.typeName &&
    node.nodeSize === info.nodeSize &&
    editor.view.nodeDOM(info.pos) === info.dom
  )
}

/** Resolve the block that should own the next drag-handle interaction. */
export function getBlockInfoForInteraction(
  editor: Editor,
  preferredInfo?: CurrentBlockInfo | null,
): CurrentBlockInfo | null {
  if (preferredInfo && isCurrentBlockInfo(editor, preferredInfo)) return preferredInfo
  return getFocusedAgentThreadCardInfo(editor) ?? getCurrentBlockInfo(editor)
}

/**
 * Re-activate the AgentThreadCard after the menu has locked its explicit
 * interaction target. The nested composer intentionally leaves the outer
 * editor selection on the previous text block, so relying on that selection
 * would target the wrong block.
 */
export function activateAgentThreadCard(
  editor: Editor,
  info: CurrentBlockInfo | null,
): boolean {
  if (editor.isDestroyed || !info || info.typeName !== 'agentThreadCard') return false

  const view = editor.view
  if (!view || view.isDestroyed) return false

  const node = view.state.doc.nodeAt(info.pos)
  if (
    !node ||
    node.type.name !== 'agentThreadCard' ||
    node.nodeSize !== info.nodeSize ||
    view.nodeDOM(info.pos) !== info.dom
  ) {
    return false
  }

  const { selection } = view.state
  if (selection instanceof NodeSelection && selection.from === info.pos) return true

  try {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, info.pos)))
    return true
  } catch {
    return false
  }
}

function getTargetBlockDepth($from: { depth: number; node: (depth: number) => PMNode }): number {
  for (let depth = $from.depth; depth >= 1; depth--) {
    if ($from.node(depth).type.name === 'table') {
      return depth
    }
  }

  // A list item is the editable/dragged unit. Walk outwards from the
  // selection so a nested item wins over each of its ancestor items.
  for (let depth = $from.depth; depth >= 1; depth--) {
    if (LIST_ITEM_TYPES.has($from.node(depth).type.name)) {
      return depth
    }
  }

  return $from.depth
}
