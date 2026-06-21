import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection } from 'prosemirror-state'

/**
 * Pure ProseMirror-native helpers for resolving the "block" the cursor
 * (or a NodeSelection) is currently on, and for setting a real editor
 * selection covering that block's content.
 *
 * Both functions are deterministic given editor state — no React, no DOM
 * mutation, no class manipulation. They are the data layer the
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

const WRAPPING_BLOCK_TYPES = new Set([
  'blockquote',
  'table',
  'bulletList',
  'orderedList',
  'taskList',
])

const LIST_BLOCK_TYPES = new Set([
  'bulletList',
  'orderedList',
  'taskList',
])

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

function getTargetBlockDepth($from: { depth: number; node: (depth: number) => PMNode }): number {
  for (let depth = $from.depth; depth >= 1; depth--) {
    if ($from.node(depth).type.name === 'table') {
      return depth
    }
  }

  for (let depth = 1; depth <= $from.depth; depth++) {
    if (LIST_BLOCK_TYPES.has($from.node(depth).type.name)) {
      return depth
    }
  }

  for (let depth = $from.depth; depth >= 1; depth--) {
    if (WRAPPING_BLOCK_TYPES.has($from.node(depth).type.name)) {
      return depth
    }
  }
  return $from.depth
}

/**
 * Set a real editor selection covering the current block's content. This
 * anchors the visual selection to the editor's native ::selection (and
 * ProseMirror-selectednode for atoms) — the most stable "this block is
 * selected" signal because it survives transient DOM mutations, React
 * effect re-runs, and external class-stripping code.
 *
 * - Text-bearing block (paragraph, heading, listItem, blockquote, codeBlock,
 *   tableCell, ...): TextSelection from `pos + 1` (just inside open) to
 *   `pos + nodeSize - 1` (just before close). Empty blocks (from === to)
 *   fall through to a cursor — no visual selection, but no error.
 * - Leaf / atom block (image, videoAttachment, fileAttachment,
 *   etc.): NodeSelection on the whole node, matching the convention those
 *   node types use for keyboard delete.
 */
export function selectBlockContent(editor: Editor): void {
  const info = getCurrentBlockInfo(editor)
  if (!info) return

  if (info.node.isLeaf) {
    editor.chain().focus().setNodeSelection(info.pos).run()
    return
  }

  const textblockSelection = getFirstTextblockSelection(info)
  if (textblockSelection) {
    editor.chain().focus().setTextSelection(textblockSelection).run()
    return
  }

  if (NodeSelection.isSelectable(info.node)) {
    editor.chain().focus().setNodeSelection(info.pos).run()
  }
}

function getFirstTextblockSelection(info: CurrentBlockInfo): { from: number; to: number } | null {
  if (!isWrappingBlock(info)) {
    return getNodeTextSelection(info.pos, info.node)
  }

  let selection: { from: number; to: number } | null = null
  info.node.descendants((node, relativePos) => {
    if (!node.isTextblock) return true
    selection = getNodeTextSelection(info.pos + 1 + relativePos, node)
    return false
  })
  return selection
}

function getNodeTextSelection(pos: number, node: PMNode): { from: number; to: number } | null {
  if (!node.isTextblock) return null
  const from = pos + 1
  const to = pos + node.nodeSize - 1
  return { from, to }
}

function isWrappingBlock(info: CurrentBlockInfo): boolean {
  return WRAPPING_BLOCK_TYPES.has(info.typeName)
}
