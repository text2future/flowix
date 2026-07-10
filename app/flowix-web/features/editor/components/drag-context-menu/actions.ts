import type { Editor } from '@tiptap/core'
import { NodeSelection } from 'prosemirror-state'
import { menuPinPluginKey } from '@features/editor/extensions/menu-pin'
import { getCurrentBlockInfo, type CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import type { BlockMenuItem } from '@features/editor/components/drag-context-menu/items'
import { terminateAgentThreadCardRuntime } from '@features/editor/extensions/agent-thread-card/agent-thread-card-cleanup'

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

export function applyMenuItem(editor: Editor, item: BlockMenuItem): void {
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
export function deleteBlock(editor: Editor): boolean {
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
    editor.chain().focus().deleteRange({ from: info.pos, to: info.pos + info.nodeSize }).run()
    return true
  }
  return false
}
