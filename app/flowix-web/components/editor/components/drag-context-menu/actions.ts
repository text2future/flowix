import type { Editor } from '@tiptap/core'
import { NodeSelection } from 'prosemirror-state'
import { menuPinPluginKey } from '../../extensions/menu-pin'
import { getCurrentBlockInfo, type CurrentBlockInfo } from './block-info'
import type { BlockMenuItem } from './items'

/**
 * Editor command dispatchers used by the drag handle. Kept separate from
 * the React component so they're trivially testable in isolation and
 * reusable from any future caller (e.g. a keyboard shortcut layer).
 */

// Pin / unpin the "this block is the menu's target" decoration via the
// menu-pin extension's transaction metadata API. The decoration is
// rendered by ProseMirror's view-update pipeline (see extensions/menu-pin.ts),
// not by direct DOM mutation, so it survives any external class-stripping.
export function pinBlock(editor: Editor, pos: number): void {
  editor.view.dispatch(editor.view.state.tr.setMeta(menuPinPluginKey, pos))
}

export function unpinBlock(editor: Editor): void {
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
 *    listItem, tableCell, codeBlock, etc.).
 * Returns true if a delete was actually attempted.
 */
export function deleteBlock(editor: Editor): boolean {
  const { selection } = editor.state
  if (selection instanceof NodeSelection) {
    editor.chain().focus().deleteSelection().run()
    return true
  }
  const info: CurrentBlockInfo | null = getCurrentBlockInfo(editor)
  if (info) {
    editor.chain().focus().deleteRange({ from: info.pos, to: info.pos + info.nodeSize }).run()
    return true
  }
  return false
}