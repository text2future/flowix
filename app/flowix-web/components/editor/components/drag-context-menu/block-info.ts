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

  // TextSelection / cursor: $from.parent is the immediate block the cursor
  // lives in (paragraph, heading, listItem, tableCell, blockquote, etc.).
  const { $from } = selection
  const parent = $from.parent
  if (!parent) return null
  // `$from.depth` is the depth of the parent (1 for top-level blocks,
  // 2 for listItem/taskItem, 4 for tableCell, etc.). `$from.start(depth)`
  // returns the position just inside the parent's open token, so subtract
  // 1 to land on the open token itself — that's the position `view.nodeDOM`
  // uses to return the parent's outer DOM. (Using `$from.before(1)` would
  // hardcode depth 1, which for a listItem cursor resolves to the *first*
  // listItem of the list, not the one the cursor is in.)
  if ($from.depth < 1) return null
  const pos = $from.start($from.depth) - 1
  const dom = view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return null
  return {
    node: parent,
    typeName: parent.type.name,
    attrs: parent.attrs,
    pos,
    nodeSize: parent.nodeSize,
    dom,
  }
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

  const from = info.pos + 1
  const to = info.pos + info.nodeSize - 1
  if (from > to) {
    // Empty block: nothing to select, but make sure focus lands at the
    // start of the block so the menu's transform commands act on it.
    editor.chain().focus().setTextSelection(from).run()
    return
  }
  editor.chain().focus().setTextSelection({ from, to }).run()
}
