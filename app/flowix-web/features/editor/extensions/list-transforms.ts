import { Extension, type Editor } from '@tiptap/core'
import { Fragment, type Node as PMNode } from 'prosemirror-model'
import { Selection, type Transaction } from 'prosemirror-state'
import { getCurrentBlockInfo, type CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import {
  convertItem,
  canMergeListRuns,
  createListOfType,
  isListTypeName,
  itemsOf,
  listWithItems,
  LIST_ITEM_TYPES,
  type ListTypeName,
} from './list-structure'

interface ItemContext {
  node: PMNode
  index: number
  list: PMNode
  listPos: number
}

function currentItem(editor: Editor, target?: CurrentBlockInfo | null): ItemContext | null {
  if (editor.isDestroyed) return null
  const info = target ?? getCurrentBlockInfo(editor)
  if (!info || !LIST_ITEM_TYPES.has(info.typeName)) return null
  const { doc } = editor.state
  const node = doc.nodeAt(info.pos)
  if (!node || node.type.name !== info.typeName || node.nodeSize !== info.nodeSize) return null
  if (target && editor.view.nodeDOM(info.pos) !== info.dom) return null
  const $item = doc.resolve(info.pos)
  if (!isListTypeName($item.parent.type.name)) return null
  return {
    node,
    index: $item.index(),
    list: $item.parent,
    listPos: $item.before($item.depth),
  }
}

function selectItem(tr: Transaction, itemPos: number): void {
  tr.setSelection(Selection.near(tr.doc.resolve(itemPos + 2)))
}

/** Convert one item, or a contiguous text selection of sibling items. */
export function convertSelectedListItems(
  editor: Editor,
  targetType: ListTypeName,
  target?: CurrentBlockInfo | null,
): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false
  const context = currentItem(editor, target)
  if (!context || context.list.type.name === targetType) return false

  const { state } = editor
  const { selection } = state
  const listEnd = context.listPos + context.list.nodeSize
  if (!selection.empty && (selection.from <= context.listPos || selection.to > listEnd)) return false
  const useRange = !selection.empty
  const indices: number[] = []
  let offset = context.listPos + 1
  context.list.forEach((item, _childOffset, index) => {
    if (useRange
      ? offset < selection.to && offset + item.nodeSize > selection.from
      : index === context.index) {
      indices.push(index)
    }
    offset += item.nodeSize
  })
  if (indices.length === 0) return false
  const fromIndex = indices[0]
  const toIndex = indices[indices.length - 1] + 1
  const original = itemsOf(context.list)
  const $list = state.doc.resolve(context.listPos)
  const previousSibling = fromIndex === 0 && $list.index() > 0
    ? $list.parent.child($list.index() - 1)
    : null
  const nextSibling = toIndex === original.length && $list.index() + 1 < $list.parent.childCount
    ? $list.parent.child($list.index() + 1)
    : null

  try {
    const before = listWithItems(context.list, original.slice(0, fromIndex))
    const convertedItems = original.slice(fromIndex, toIndex).map(item => convertItem(item, targetType, state.schema))
    const precedingOrdered = previousSibling?.type.name === 'orderedList' ? previousSibling : null
    const followingOrdered = nextSibling?.type.name === 'orderedList' ? nextSibling : null
    const orderedNeighbor = precedingOrdered ?? followingOrdered
    const orderedStart = precedingOrdered
      ? (Number(precedingOrdered.attrs.start) || 1) + precedingOrdered.childCount
      : followingOrdered
        ? Math.max(1, (Number(followingOrdered.attrs.start) || 1) - convertedItems.length)
        : 1
    const convertedAttrs = targetType === 'orderedList'
      ? { ...orderedNeighbor?.attrs, start: orderedStart }
      : undefined
    const converted = createListOfType(state.schema, targetType, convertedItems, convertedAttrs)
    const after = listWithItems(context.list, original.slice(toIndex), toIndex)
    const replacement = [before, converted, after].filter((node): node is PMNode => node != null)
    if (!$list.parent.canReplace($list.index(), $list.index() + 1, Fragment.fromArray(replacement))) return false

    const tr = state.tr.replaceWith(context.listPos, context.listPos + context.list.nodeSize, replacement)
    let convertedPos = context.listPos + (before?.nodeSize ?? 0)
    let selectedItemPos = convertedPos + 1
    if (!before) {
      const $converted = tr.doc.resolve(convertedPos)
      const previous = $converted.nodeBefore
      if (canMergeListRuns(previous, tr.doc.nodeAt(convertedPos))) {
        tr.join(convertedPos)
        convertedPos -= previous!.nodeSize
        selectedItemPos -= 2
      }
    }
    if (!after) {
      const current = tr.doc.nodeAt(convertedPos)
      if (current) {
        const nextPos = convertedPos + current.nodeSize
        if (canMergeListRuns(current, tr.doc.nodeAt(nextPos))) tr.join(nextPos)
      }
    }
    selectItem(tr, selectedItemPos)
    editor.view.dispatch(tr.scrollIntoView())
    editor.view.focus()
    return true
  } catch {
    return false
  }
}

/** Shared entry point for toolbar, slash menu, shortcuts, and block menu. */
export function applyListType(
  editor: Editor,
  targetType: ListTypeName,
  target?: CurrentBlockInfo | null,
): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false
  const context = currentItem(editor, target)
  if (context && context.list.type.name !== targetType) {
    return convertSelectedListItems(editor, targetType, target)
  }
  const chain = editor.chain().focus()
  if (targetType === 'bulletList') return chain.toggleBulletList().run()
  if (targetType === 'orderedList') return chain.toggleOrderedList().run()
  return chain.toggleTaskList().run()
}

/** Keep Tiptap's built-in list chords aligned with the block menu behavior. */
export const ListTypeShortcuts = Extension.create({
  name: 'listTypeShortcuts',
  priority: 1100,
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-7': () => { applyListType(this.editor, 'orderedList'); return true },
      'Mod-Shift-8': () => { applyListType(this.editor, 'bulletList'); return true },
      'Mod-Shift-9': () => { applyListType(this.editor, 'taskList'); return true },
    }
  },
})

/** Tab across adjacent list runs, preserving the source item's list type. */
export function indentAcrossListTypes(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable || !editor.state.selection.empty) return false
  const source = currentItem(editor)
  if (!source || source.index !== 0) return false
  const { state } = editor
  const $list = state.doc.resolve(source.listPos)
  const parentIndex = $list.index()
  if (parentIndex === 0) return false
  const previousList = $list.parent.child(parentIndex - 1)
  if (!isListTypeName(previousList.type.name) || previousList.type === source.list.type) return false

  const previousPos = source.listPos - previousList.nodeSize
  const previousItems = itemsOf(previousList)
  const previousItem = previousItems[previousItems.length - 1]
  const children = itemsOf(previousItem)
  const lastChild = children[children.length - 1]
  const sourceItems = itemsOf(source.list)
  const sourceType = source.list.type.name as ListTypeName

  try {
    const childList = lastChild?.type === source.list.type
      ? lastChild.type.createChecked(lastChild.attrs, lastChild.content.append(Fragment.from(source.node)))
      : createListOfType(state.schema, sourceType, [source.node], source.list.attrs)
    const newChildren = lastChild?.type === source.list.type
      ? [...children.slice(0, -1), childList]
      : [...children, childList]
    const newPreviousItem = previousItem.type.createChecked(previousItem.attrs, Fragment.fromArray(newChildren))
    const newPreviousList = listWithItems(previousList, [...previousItems.slice(0, -1), newPreviousItem])!
    const remaining = listWithItems(source.list, sourceItems.slice(1), 1)
    const replacement = [newPreviousList, remaining].filter((node): node is PMNode => node != null)
    if (!$list.parent.canReplace(parentIndex - 1, parentIndex + 1, Fragment.fromArray(replacement))) return false

    const tr = state.tr.replaceWith(previousPos, source.listPos + source.list.nodeSize, replacement)
    const childPos = previousPos + 1 + newPreviousList.content.size - newPreviousItem.nodeSize
      + 1 + newPreviousItem.content.size - childList.nodeSize
    selectItem(tr, childPos + 1 + childList.content.size - source.node.nodeSize)
    editor.view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    return false
  }
}

/** Shift-Tab from a mixed nested list creates a sibling list at the parent level. */
export function outdentAcrossListTypes(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable || !editor.state.selection.empty) return false
  const source = currentItem(editor)
  if (!source) return false
  const { state } = editor
  const $sourceList = state.doc.resolve(source.listPos)
  const parentItem = $sourceList.parent
  if (!LIST_ITEM_TYPES.has(parentItem.type.name)) return false
  const parentItemPos = $sourceList.before($sourceList.depth)
  const $parentItem = state.doc.resolve(parentItemPos)
  const parentList = $parentItem.parent
  if (!isListTypeName(parentList.type.name)) return false
  // Native liftListItem absorbs a child into the outer list. Keep a distinct
  // wrapper when the child and parent list types differ, even for ul <-> ol.
  if (parentList.type === source.list.type) return false
  const parentListPos = $parentItem.before($parentItem.depth)
  const parentIndex = $parentItem.index()
  const sourceListIndex = $sourceList.index()

  try {
    const sourceItems = itemsOf(source.list)
    const remainingSource = listWithItems(source.list,
      sourceItems.filter((_item, index) => index !== source.index),
      source.index === 0 ? 1 : 0)
    const parentChildren = itemsOf(parentItem)
    const newParentChildren = [
      ...parentChildren.slice(0, sourceListIndex),
      ...(remainingSource ? [remainingSource] : []),
      ...parentChildren.slice(sourceListIndex + 1),
    ]
    const newParentItem = parentItem.type.createChecked(parentItem.attrs, Fragment.fromArray(newParentChildren))
    const parentItems = itemsOf(parentList)
    const before = listWithItems(parentList, [...parentItems.slice(0, parentIndex), newParentItem])!
    const sourceType = source.list.type.name as ListTypeName
    const liftedAttrs = sourceType === 'orderedList'
      ? { ...source.list.attrs, start: (Number(source.list.attrs.start) || 1) + source.index }
      : source.list.attrs
    const lifted = createListOfType(state.schema, sourceType, [source.node], liftedAttrs)
    const after = listWithItems(parentList, parentItems.slice(parentIndex + 1), parentIndex + 1)
    const replacement = [before, lifted, after].filter((node): node is PMNode => node != null)
    const $outer = state.doc.resolve(parentListPos)
    if (!$outer.parent.canReplace($outer.index(), $outer.index() + 1, Fragment.fromArray(replacement))) return false

    const tr = state.tr.replaceWith(parentListPos, parentListPos + parentList.nodeSize, replacement)
    selectItem(tr, parentListPos + before.nodeSize + 1)
    editor.view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    return false
  }
}
