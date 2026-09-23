import type { Editor } from '@tiptap/core'
import { NodeSelection } from 'prosemirror-state'
import { menuPinPluginKey } from '@features/editor/extensions/menu-pin'
import { getCurrentBlockInfo, type CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import type { BlockMenuItem, ImageAlignment } from '@features/editor/components/drag-context-menu/items'
import { terminateAgentThreadCardRuntime } from '@features/agent/thread-card/agent-thread-card-cleanup'

/**
 * Editor command dispatchers used by the drag handle. Kept separate from
 * the React component so they're trivially testable in isolation and
 * reusable from any future caller (e.g. a keyboard shortcut layer).
 */

// Pin / unpin the "this block is the menu's target" decoration via the
// menu-pin extension's transaction metadata API. The decoration is
// rendered by ProseMirror's view-update pipeline (see extensions/menu-pin.ts),
// not by direct DOM mutation, so it survives any external class-stripping.
export function pinBlock(editor: Editor, info: CurrentBlockInfo): void {
  // blur / click-outside 事件可能在 editor 已销毁后还 flush 进来 ──
  // 这里读 editor.view.dom 会触发 "editor view is not available"。
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.view.state.tr.setMeta(menuPinPluginKey, {
    pos: info.pos,
    typeName: info.typeName,
    nodeSize: info.nodeSize,
  }))
}

export function unpinBlock(editor: Editor): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.view.state.tr.setMeta(menuPinPluginKey, null))
}

export function applyMenuItem(
  editor: Editor,
  item: BlockMenuItem,
  target?: CurrentBlockInfo | null,
): void {
  // AgentThreadCard is a custom block with a nested composer, not a text
  // block that can be converted to a heading/list/code block. Its context
  // menu intentionally exposes only actions that apply to the card itself.
  if (target?.typeName === 'agentThreadCard') return

  if (item.kind === 'heading') {
    editor.chain().focus().toggleHeading({ level: item.level }).run()
  } else if (item.kind === 'paragraph') {
    editor.chain().focus().setParagraph().run()
  } else if (item.kind === 'list') {
    if (item.listType === 'bulletList') {
      editor.chain().focus().toggleBulletList().run()
    } else if (item.listType === 'orderedList') {
      editor.chain().focus().toggleOrderedList().run()
    } else {
      editor.chain().focus().toggleTaskList().run()
    }
  } else if (item.kind === 'block') {
    if (item.blockType === 'blockquote') {
      editor.chain().focus().toggleBlockquote().run()
    } else {
      editor.chain().focus().toggleCodeBlock().run()
    }
  }
}

/**
 * Delete the currently focused block (or selected node).
 *  - NodeSelection (e.g. freshly uploaded file attachment):
 *    standard `deleteSelection`, matching the convention
 *    those node types use for keyboard delete.
 *  - TextSelection / cursor: `deleteRange` from the block's open-token
 *    position to its end, deleting the entire block (heading, paragraph,
 *    listItem, codeBlock, etc.). Tables use the table extension command.
 * Returns true if a delete was actually attempted.
 */
export function deleteBlock(editor: Editor, target?: CurrentBlockInfo | null): boolean {
  if (target) {
    if (target.typeName === 'agentThreadCard') {
      terminateAgentThreadCardRuntime(target.attrs)
    }
    if (target.typeName === 'table') {
      editor.chain().focus().deleteTable().run()
      return true
    }
    if (isLastListItem(editor, target)) {
      return deleteLastListItem(editor, target.pos)
    }
    editor.chain().focus().deleteRange({
      from: target.pos,
      to: target.pos + target.nodeSize,
    }).run()
    return true
  }

  const { selection } = editor.state
  if (selection instanceof NodeSelection) {
    if (selection.node.type.name === 'agentThreadCard') {
      terminateAgentThreadCardRuntime(selection.node.attrs)
    }
    editor.chain().focus().deleteSelection().run()
    return true
  }
  const info: CurrentBlockInfo | null = getCurrentBlockInfo(editor)
  if (info) {
    if (info.typeName === 'agentThreadCard') {
      terminateAgentThreadCardRuntime(info.attrs)
    }
    if (info.typeName === 'table') {
      editor.chain().focus().deleteTable().run()
      return true
    }
    if (isLastListItem(editor, info)) {
      return deleteLastListItem(editor, info.pos)
    }
    editor.chain().focus().deleteRange({ from: info.pos, to: info.pos + info.nodeSize }).run()
    return true
  }
  return false
}

function isLastListItem(editor: Editor, info: CurrentBlockInfo): boolean {
  if (info.typeName !== 'listItem' && info.typeName !== 'taskItem') return false

  try {
    const $item = editor.state.doc.resolve(info.pos)
    return ($item.parent.type.name === 'bulletList' ||
      $item.parent.type.name === 'orderedList' ||
      $item.parent.type.name === 'taskList') && $item.parent.childCount === 1
  } catch {
    return false
  }
}

function deleteLastListItem(editor: Editor, itemPos: number): boolean {
  try {
    const { state } = editor
    const $item = state.doc.resolve(itemPos)
    const list = $item.parent
    const listPos = $item.before($item.depth)
    const paragraph = state.schema.nodes.paragraph?.create()
    if (!paragraph) return false

    // Remove the list as a whole. In a nested list, inserting the paragraph at
    // the same position leaves it inside the owning list item; at the root it
    // becomes the replacement top-level block.
    const tr = state.tr
      .delete(listPos, listPos + list.nodeSize)
      .insert(listPos, paragraph)
    editor.view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    return false
  }
}

export function setImageAlignment(
  editor: Editor,
  alignment: ImageAlignment,
  target?: CurrentBlockInfo | null,
): boolean {
  if (
    editor.isDestroyed ||
    editor.view.isDestroyed ||
    (target?.typeName !== 'image' && target?.typeName !== 'videoAttachment')
  ) return false
  const node = editor.state.doc.nodeAt(target.pos)
  if (
    !node ||
    node.type.name !== target.typeName ||
    node.nodeSize !== target.nodeSize ||
    editor.view.nodeDOM(target.pos) !== target.dom
  ) return false

  editor.view.focus()
  editor.view.dispatch(editor.view.state.tr.setNodeMarkup(target.pos, undefined, {
    ...node.attrs,
    align: alignment,
  }))
  return true
}
