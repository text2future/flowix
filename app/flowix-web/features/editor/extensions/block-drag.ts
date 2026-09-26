import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { Fragment, type Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey, Selection, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { getCurrentBlockInfo, type CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import {
  canMergeListRuns,
  createListOfType,
  isListTypeName,
  itemsOf,
  listWithItems,
  LIST_ITEM_TYPES,
  LIST_TYPES,
  type ListTypeName,
} from './list-structure'

interface DraggedBlockRange {
  from: number
  to: number
  parentStart: number
  parentTypeName: string
  isListItem: boolean
  sourceDepth: number
  sourceListTypeName: string | null
}

export interface BlockDropTarget {
  insertPos: number
  listPos: number
  listTypeName: string
  createList: boolean
  anchorPos: number
  anchorDepth: number
  desiredDepth: number
  side: 'before' | 'after'
  splitList?: { listPos: number; boundaryIndex: number }
  nestList?: { itemPos: number }
}

interface BlockDragState extends DraggedBlockRange {
  /** Kept for the existing drop-line API and backwards-compatible tests. */
  dropPos: number | null
  dropTarget: BlockDropTarget | null
}

export interface BlockDragTarget {
  pos: number
  nodeSize: number
}

export const blockDragPluginKey = new PluginKey<BlockDragState | null>('blockDrag')

/** Editor-level block move state. List items are moved as complete nodes. */
export const BlockDragExtension = Extension.create({
  name: 'blockDrag',

  addProseMirrorPlugins() {
    return [
      new Plugin<BlockDragState | null>({
        key: blockDragPluginKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(blockDragPluginKey)
            if (meta !== undefined) return meta
            if (!value || !tr.docChanged) return value

            // Keep insertions at either boundary out of the dragged node.
            const from = tr.mapping.mapResult(value.from, 1)
            const to = tr.mapping.mapResult(value.to, -1)
            if (from.deletedAcross || to.deletedAcross || from.pos >= to.pos) return null
            const node = tr.doc.nodeAt(from.pos)
            if (!node || node.type !== tr.before.nodeAt(value.from)?.type
              || to.pos !== from.pos + node.nodeSize) return null
            const $source = tr.doc.resolve(from.pos)
            const parent = $source.parent
            if (parent.type.name !== value.parentTypeName) return null
            return {
              ...value,
              from: from.pos,
              to: to.pos,
              parentStart: $source.start($source.depth),
              sourceDepth: value.isListItem ? getListItemDepth(tr.doc, from.pos) : 0,
              dropPos: value.dropPos == null ? null : tr.mapping.map(value.dropPos, -1),
              dropTarget: value.dropTarget ? mapDropTarget(value.dropTarget, tr.mapping) : null,
            }
          },
        },
        props: {
          decorations(state) {
            const drag = blockDragPluginKey.getState(state)
            if (!drag) return null

            const decorations = []
            const draggedNode = state.doc.nodeAt(drag.from)
            if (draggedNode && drag.to === drag.from + draggedNode.nodeSize) {
              decorations.push(Decoration.node(drag.from, drag.to, {
                class: 'flowix-block-drag-source',
              }))
            }

            const dropPos = drag.dropTarget?.insertPos ?? drag.dropPos
            if (dropPos != null) {
              decorations.push(Decoration.widget(dropPos, () => {
                const marker = document.createElement('div')
                marker.className = 'flowix-block-drop-indicator'
                marker.contentEditable = 'false'
                return marker
              }, { side: -1 }))
            }

            return decorations.length > 0
              ? DecorationSet.create(state.doc, decorations)
              : null
          },
        },
      }),
    ]
  },
})

export function startBlockDrag(editor: Editor, info?: CurrentBlockInfo | null): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false
  const block = info ?? getCurrentBlockInfo(editor)
  if (!block) return false
  return startBlockDragForView(editor.view, block)
}

export function startBlockDragForView(view: EditorView, block: BlockDragTarget): boolean {
  if (view.isDestroyed) return false

  const node = view.state.doc.nodeAt(block.pos)
  if (!node) return false
  const $pos = view.state.doc.resolve(block.pos)
  const parent = $pos.parent
  const isListItem = LIST_ITEM_TYPES.has(node.type.name) && LIST_TYPES.has(parent.type.name)
  const range: BlockDragState = {
    from: block.pos,
    to: block.pos + block.nodeSize,
    parentStart: $pos.start($pos.depth),
    parentTypeName: parent.type.name,
    isListItem,
    sourceDepth: isListItem ? getListItemDepth(view.state.doc, block.pos) : 0,
    sourceListTypeName: isListItem ? parent.type.name : null,
    dropPos: null,
    dropTarget: null,
  }

  view.dispatch(view.state.tr.setMeta(blockDragPluginKey, range))
  return true
}

export function endBlockDrag(editor: Editor): void {
  if (editor.isDestroyed) return
  endBlockDragForView(editor.view)
}

export const cancelBlockDrag = endBlockDrag

export function endBlockDragForView(view: EditorView): void {
  if (view.isDestroyed) return
  view.dispatch(view.state.tr.setMeta(blockDragPluginKey, null))
}

export const cancelBlockDragForView = endBlockDragForView

export function updateBlockDragPosition(editor: Editor, clientX: number, clientY: number): boolean {
  if (editor.isDestroyed) return false
  return updateBlockDragPositionForView(editor.view, clientX, clientY)
}

export function dropBlockDragAt(editor: Editor, clientX: number, clientY: number): boolean {
  if (editor.isDestroyed) return false
  return dropBlockDragAtForView(editor.view, clientX, clientY)
}

export function updateBlockDragPositionForView(view: EditorView, clientX: number, clientY: number): boolean {
  const drag = blockDragPluginKey.getState(view.state)
  if (!drag) return false

  const target = getValidDropTarget(view, drag, clientX, clientY)
  const dropPos = target?.insertPos ?? null
  if (drag.dropPos !== dropPos
    || drag.dropTarget?.splitList?.listPos !== target?.splitList?.listPos
    || drag.dropTarget?.splitList?.boundaryIndex !== target?.splitList?.boundaryIndex
    || drag.dropTarget?.nestList?.itemPos !== target?.nestList?.itemPos) {
    view.dispatch(view.state.tr.setMeta(blockDragPluginKey, {
      ...drag,
      dropPos,
      dropTarget: target,
    }))
  }
  return target != null
}

export function dropBlockDragAtForView(view: EditorView, clientX: number, clientY: number): boolean {
  if (view.isDestroyed) return false
  return moveDraggedBlock(view, clientX, clientY)
}

function getValidDropTarget(
  view: EditorView,
  drag: DraggedBlockRange,
  clientX: number,
  clientY: number,
): BlockDropTarget | null {
  const editorRect = view.dom.getBoundingClientRect()
  if (editorRect.width > 0 && editorRect.height > 0
    && (clientX < editorRect.left - 48 || clientX > editorRect.right + 48
      || clientY < editorRect.top - 48 || clientY > editorRect.bottom + 48)) return null

  if (drag.isListItem) {
    const target = findListDropTarget(view, drag, clientX, clientY)
    return target && isValidDropPos(view, drag, target) ? target : null
  }

  const splitTarget = findSplitListTarget(view, drag, clientX, clientY)
  if (splitTarget && isValidDropPos(view, drag, splitTarget)) return splitTarget

  const dropPos = findInsertPos(view, drag, clientX, clientY)
  const target = dropPos == null ? null : makeGenericDropTarget(dropPos)
  return target && isValidDropPos(view, drag, target)
    ? target
    : null
}

function makeGenericDropTarget(insertPos: number): BlockDropTarget {
  return {
    insertPos,
    listPos: -1,
    listTypeName: '',
    createList: false,
    anchorPos: insertPos,
    anchorDepth: 0,
    desiredDepth: 0,
    side: 'before',
  }
}

function moveDraggedBlock(view: EditorView, clientX: number, clientY: number): boolean {
  const drag = blockDragPluginKey.getState(view.state)
  if (!drag) return false

  // Re-resolve on pointerup because the final animation-frame update may not
  // have run yet, and list targets depend on the final vertical coordinate.
  const target = getValidDropTarget(view, drag, clientX, clientY)
  if (!target) {
    view.dispatch(view.state.tr.setMeta(blockDragPluginKey, null))
    return false
  }

  const { state } = view
  if (target.splitList) return moveBlockBetweenListItems(view, drag, target.splitList)
  if (target.nestList) return moveListItemIntoNestedList(view, drag, target.nestList)
  const slice = state.doc.slice(drag.from, drag.to)
  const sourceListPos = drag.isListItem ? drag.parentStart - 1 : null
  const sourceList = sourceListPos == null ? null : state.doc.nodeAt(sourceListPos)
  const sourceIndex = drag.isListItem ? state.doc.resolve(drag.from).index() : 0
  try {
    const tr = state.tr.delete(drag.from, drag.to)
    const mappedInsertPos = tr.mapping.map(target.insertPos, -1)
    const content = target.createList
      ? sourceList && isListTypeName(sourceList.type.name)
        ? wrapDraggedItem(state, sourceList, state.doc.nodeAt(drag.from)!, sourceIndex)
        : null
      : slice.content
    if (!content) throw new Error('Cannot create list drop target')
    tr.insert(mappedInsertPos, content)
    if (sourceListPos != null) {
      cleanupSourceList(tr, tr.mapping.map(sourceListPos, -1), sourceList?.childCount === 1)
    }
    if (target.createList) {
      mergeAdjacentRootLists(tr, tr.mapping.map(target.insertPos, -1))
    }
    removeEmptyLists(tr)
    tr.setMeta(blockDragPluginKey, null)
    view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }
}

function nestItemInParent(
  state: EditorView['state'],
  parentItem: PMNode,
  sourceList: PMNode,
  sourceItem: PMNode,
  sourceIndex: number,
): PMNode {
  const children = itemsOf(parentItem)
  const lastChild = children[children.length - 1]
  const nestedList = lastChild?.type === sourceList.type
    ? lastChild.type.createChecked(lastChild.attrs, lastChild.content.append(Fragment.from(sourceItem)))
    : createListOfType(state.schema, sourceList.type.name as ListTypeName, [sourceItem],
      sourceList.type.name === 'orderedList'
        ? { ...sourceList.attrs, start: (Number(sourceList.attrs.start) || 1) + sourceIndex }
        : sourceList.attrs)
  const content = lastChild?.type === sourceList.type
    ? [...children.slice(0, -1), nestedList]
    : [...children, nestedList]
  return parentItem.type.createChecked(parentItem.attrs, Fragment.fromArray(content))
}

function moveListItemIntoNestedList(
  view: EditorView,
  drag: DraggedBlockRange,
  target: NonNullable<BlockDropTarget['nestList']>,
): boolean {
  const { state } = view
  const sourceItem = state.doc.nodeAt(drag.from)
  const $source = state.doc.resolve(drag.from)
  const sourceList = $source.parent
  if (!sourceItem || !isListTypeName(sourceList.type.name)) return false
  const sourceIndex = $source.index()
  const sourceListPos = drag.parentStart - 1
  try {
    const tr = state.tr.delete(drag.from, drag.to)
    const itemPos = tr.mapping.map(target.itemPos, -1)
    const parentItem = tr.doc.nodeAt(itemPos)
    if (!parentItem || !LIST_ITEM_TYPES.has(parentItem.type.name)) throw new Error('Drop item disappeared')
    const updated = nestItemInParent(state, parentItem, sourceList, sourceItem, sourceIndex)
    const $item = tr.doc.resolve(itemPos)
    if (!$item.parent.canReplace($item.index(), $item.index() + 1, Fragment.from(updated))) {
      throw new Error('Drop item cannot contain the nested list')
    }
    tr.replaceWith(itemPos, itemPos + parentItem.nodeSize, updated)
    cleanupSourceList(tr, tr.mapping.map(sourceListPos, -1), sourceList.childCount === 1)
    removeEmptyLists(tr)
    tr.setMeta(blockDragPluginKey, null)
    view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }
}

function moveBlockBetweenListItems(
  view: EditorView,
  drag: DraggedBlockRange,
  target: NonNullable<BlockDropTarget['splitList']>,
): boolean {
  const { state } = view
  const block = state.doc.nodeAt(drag.from)
  if (!block || drag.to !== drag.from + block.nodeSize) return false
  const sourceList = drag.isListItem ? state.doc.resolve(drag.from).parent : null
  const sourceIndex = drag.isListItem ? state.doc.resolve(drag.from).index() : 0
  const sourceListPos = drag.isListItem ? drag.parentStart - 1 : null
  try {
    const tr = state.tr.delete(drag.from, drag.to)
    const listPos = tr.mapping.map(target.listPos, -1)
    const list = tr.doc.nodeAt(listPos)
    if (!list || !LIST_TYPES.has(list.type.name)) throw new Error('Drop list disappeared')
    const items = itemsOf(list)
    if (target.boundaryIndex <= 0 || target.boundaryIndex >= items.length) {
      throw new Error('Drop boundary is outside the list')
    }
    const before = listWithItems(list, items.slice(0, target.boundaryIndex))!
    const after = listWithItems(list, items.slice(target.boundaryIndex), target.boundaryIndex)!
    const middle = sourceList
      ? wrapDraggedItem(state, sourceList, block, sourceIndex)
      : block
    const replacement = [before, middle, after]
    const $list = tr.doc.resolve(listPos)
    if (!$list.parent.canReplace($list.index(), $list.index() + 1, Fragment.fromArray(replacement))) {
      throw new Error('Destination cannot contain the block')
    }
    tr.replaceWith(listPos, listPos + list.nodeSize, replacement)
    tr.setSelection(Selection.near(tr.doc.resolve(listPos + before.nodeSize + 1)))
    if (sourceListPos != null) cleanupSourceList(tr, tr.mapping.map(sourceListPos, -1), sourceList?.childCount === 1)
    removeEmptyLists(tr)
    tr.setMeta(blockDragPluginKey, null)
    view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }
}

function wrapDraggedItem(
  state: EditorView['state'],
  sourceList: PMNode,
  item: PMNode,
  index: number,
): PMNode {
  if (!isListTypeName(sourceList.type.name)) throw new Error('Source item has no list')
  const attrs = sourceList.type.name === 'orderedList'
    ? { ...sourceList.attrs, start: (Number(sourceList.attrs.start) || 1) + index }
    : sourceList.attrs
  return createListOfType(state.schema, sourceList.type.name, [item], attrs)
}

function findSplitListTarget(
  view: EditorView,
  drag: DraggedBlockRange,
  clientX: number,
  clientY: number,
): BlockDropTarget | null {
  const container = getContainingListContainer(view, clientY)
  if (!container || container.node.childCount < 2) return null
  if (container.pos >= drag.from && container.pos < drag.to) return null
  const dom = view.nodeDOM(container.pos)
  if (!(dom instanceof HTMLElement)) return null
  const rect = dom.getBoundingClientRect()
  if (Number.isFinite(rect.left) && Number.isFinite(rect.right)
    && (clientX < rect.left - 48 || clientX > rect.right + 16)) return null

  let boundaryIndex = container.node.childCount
  let offset = 0
  for (let index = 0; index < container.node.childCount; index += 1) {
    const item = container.node.child(index)
    const itemPos = container.pos + 1 + offset
    // A <li> rect includes nested lists. Its leading paragraph gives a stable
    // boundary for the row itself, even when the item owns many descendants.
    const heading = view.nodeDOM(itemPos + 1)
    const itemDom = view.nodeDOM(itemPos)
    const anchor = heading instanceof HTMLElement ? heading : itemDom
    if (anchor instanceof HTMLElement) {
      const itemRect = anchor.getBoundingClientRect()
      if (clientY < itemRect.top + itemRect.height / 2) {
        boundaryIndex = index
        break
      }
    }
    offset += item.nodeSize
  }
  if (boundaryIndex <= 0 || boundaryIndex >= container.node.childCount) return null
  let boundaryOffset = 0
  for (let index = 0; index < boundaryIndex; index += 1) {
    boundaryOffset += container.node.child(index).nodeSize
  }
  const insertPos = container.pos + 1 + boundaryOffset
  return {
    insertPos,
    listPos: container.pos,
    listTypeName: container.node.type.name,
    createList: false,
    anchorPos: insertPos,
    anchorDepth: container.depth,
    desiredDepth: container.depth,
    side: 'before',
    splitList: { listPos: container.pos, boundaryIndex },
  }
}

function findInsertPos(view: EditorView, drag: DraggedBlockRange, clientX: number, clientY: number): number | null {
  const blockPos = findInsertPosBySiblingRects(view, drag, clientY)
  if (blockPos != null) return blockPos

  const coords = view.posAtCoords({ left: clientX, top: clientY })
  if (!coords) return null
  const { doc } = view.state
  const $pos = doc.resolve(coords.pos)
  let parentDepth: number | null = null

  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth)
    const start = depth === 0 ? 0 : $pos.start(depth)
    if (node.type.name === drag.parentTypeName && start === drag.parentStart) {
      parentDepth = depth
      break
    }
  }
  if (parentDepth == null || parentDepth + 1 > $pos.depth) return null

  const childPos = $pos.before(parentDepth + 1)
  const child = doc.nodeAt(childPos)
  if (!child) return null
  const dom = view.nodeDOM(childPos)
  if (!(dom instanceof HTMLElement)) return childPos
  const rect = dom.getBoundingClientRect()
  return clientY > rect.top + rect.height / 2 ? childPos + child.nodeSize : childPos
}

function findInsertPosBySiblingRects(view: EditorView, drag: DraggedBlockRange, clientY: number): number | null {
  const { doc } = view.state
  try {
    const $parentStart = doc.resolve(drag.parentStart)
    const parent = $parentStart.parent
    if (parent.type.name !== drag.parentTypeName) return null

    let offset = 0
    for (let index = 0; index < parent.childCount; index += 1) {
      const child = parent.child(index)
      const childPos = drag.parentStart + offset
      const dom = view.nodeDOM(childPos)
      if (dom instanceof HTMLElement) {
        const rect = dom.getBoundingClientRect()
        if (clientY < rect.top + rect.height / 2) return childPos
      }
      offset += child.nodeSize
    }
    return drag.parentStart + parent.content.size
  } catch {
    return null
  }
}

interface ListItemRecord {
  pos: number
  node: PMNode
  depth: number
  top: number
  bottom: number
}

interface TopLevelBlockRecord {
  pos: number
  node: PMNode
  top: number
  bottom: number
}

function findListDropTarget(view: EditorView, drag: DraggedBlockRange, clientX: number, clientY: number): BlockDropTarget | null {
  const topLevelBlocks = getTopLevelBlockRecords(view)
  const listContainer = getContainingListContainer(view, clientY)

  // A pointer outside every rendered list is a root-level drop. This is the
  // path that allows a list item to land between two ordinary paragraphs.
  // The containing list may be nested in a blockquote or another block node;
  // it does not have to be a direct child of the document.
  if (!listContainer) {
    return resolveRootListDropTarget(drag, clientY, topLevelBlocks)
  }

  const records: ListItemRecord[] = []
  view.state.doc.descendants((node, pos) => {
    if (!LIST_ITEM_TYPES.has(node.type.name)) return true
    // The dragged item and every descendant item are one indivisible block.
    if (pos >= drag.from && pos < drag.to) return true
    if (!isWithinList(view.state.doc, pos, listContainer.pos)) return true

    const dom = view.nodeDOM(pos)
    const item = dom instanceof HTMLElement
      ? (dom.matches('li') ? dom : dom.closest('li'))
      : null
    if (!(item instanceof HTMLElement)) return true

    const rect = item.getBoundingClientRect()
    records.push({
      pos,
      node,
      depth: getListItemDepth(view.state.doc, pos),
      top: rect.top,
      bottom: rect.bottom,
    })
    return true
  })

  if (records.length === 0) return null
  records.sort((a, b) => a.pos - b.pos)

  // Ancestor <li> rectangles include their child lists. Prefer the deepest
  // containing item so nested items have independent vertical drop targets.
  const containing = records
    .filter((record) => clientY >= record.top && clientY <= record.bottom)
    .sort((a, b) => b.depth - a.depth || (a.bottom - a.top) - (b.bottom - b.top))
  const anchor = containing[0] ?? findNearestListItem(records, clientY)
  if (!anchor) return null

  const side: 'before' | 'after' = clientY > anchor.top + (anchor.bottom - anchor.top) / 2
    ? 'after'
    : 'before'
  const nested = resolveNestedListDropTarget(view, drag, anchor, clientX)
  if (nested) return nested
  return resolveListDropTarget(view.state.doc, drag, anchor, side)
    ?? findSplitListTarget(view, drag, clientX, clientY)
}

function resolveNestedListDropTarget(
  view: EditorView,
  drag: DraggedBlockRange,
  anchor: ListItemRecord,
  clientX: number,
): BlockDropTarget | null {
  if (anchor.pos <= drag.from && drag.to <= anchor.pos + anchor.node.nodeSize) return null
  const contentDom = view.nodeDOM(anchor.pos + 1)
  if (!(contentDom instanceof HTMLElement)) return null
  const rect = contentDom.getBoundingClientRect()
  if (!Number.isFinite(rect.left) || clientX < rect.left + 24) return null
  if (!drag.sourceListTypeName || !isListTypeName(drag.sourceListTypeName)) return null
  const insertPos = anchor.pos + anchor.node.nodeSize - 1
  return {
    insertPos,
    listPos: -1,
    listTypeName: drag.sourceListTypeName,
    createList: false,
    anchorPos: anchor.pos,
    anchorDepth: anchor.depth,
    desiredDepth: anchor.depth + 1,
    side: 'after',
    nestList: { itemPos: anchor.pos },
  }
}

interface ListContainerRecord {
  pos: number
  node: PMNode
  depth: number
  top: number
  bottom: number
}

function getContainingListContainer(view: EditorView, clientY: number): ListContainerRecord | null {
  const records: ListContainerRecord[] = []
  view.state.doc.descendants((node, pos) => {
    if (!LIST_TYPES.has(node.type.name)) return true
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return true
    const rect = dom.getBoundingClientRect()
    if (clientY >= rect.top && clientY <= rect.bottom) {
      records.push({
        pos,
        node,
        depth: getListNestingDepth(view.state.doc, pos),
        top: rect.top,
        bottom: rect.bottom,
      })
    }
    return true
  })

  records.sort((a, b) => b.depth - a.depth || (a.bottom - a.top) - (b.bottom - b.top))
  return records[0] ?? null
}

function getTopLevelBlockRecords(view: EditorView): TopLevelBlockRecord[] {
  const records: TopLevelBlockRecord[] = []
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset)
    if (!(dom instanceof HTMLElement)) return
    const rect = dom.getBoundingClientRect()
    records.push({ pos: offset, node, top: rect.top, bottom: rect.bottom })
  })
  return records
}

function isWithinList(doc: PMNode, itemPos: number, listPos: number): boolean {
  try {
    const $item = doc.resolve(itemPos)
    for (let depth = 1; depth <= $item.depth; depth += 1) {
      if (LIST_TYPES.has($item.node(depth).type.name) && $item.before(depth) === listPos) return true
    }
  } catch {
    return false
  }
  return false
}

export function resolveRootListDropTarget(
  drag: Pick<DraggedBlockRange, 'sourceDepth' | 'sourceListTypeName'>,
  clientY: number,
  records: TopLevelBlockRecord[],
): BlockDropTarget | null {
  if (records.length === 0) return null

  let insertPos: number | null = null
  let anchorPos = records[0].pos
  let side: 'before' | 'after' = 'before'

  const containing = records.find((record) => clientY >= record.top && clientY <= record.bottom)
  if (containing) {
    anchorPos = containing.pos
    side = clientY > containing.top + (containing.bottom - containing.top) / 2 ? 'after' : 'before'
    insertPos = side === 'before' ? containing.pos : containing.pos + containing.node.nodeSize
  } else {
    const next = records.find((record) => clientY < record.top)
    if (next) {
      anchorPos = next.pos
      insertPos = next.pos
    } else {
      const previous = records[records.length - 1]
      anchorPos = previous.pos
      side = 'after'
      insertPos = previous.pos + previous.node.nodeSize
    }
  }

  if (insertPos == null) return null

  const listTypeName = drag.sourceListTypeName ?? 'bulletList'
  return {
    insertPos,
    listPos: -1,
    listTypeName,
    createList: true,
    anchorPos,
    anchorDepth: -1,
    desiredDepth: 0,
    side,
  }
}

function findNearestListItem(records: ListItemRecord[], clientY: number): ListItemRecord | null {
  let previous: ListItemRecord | null = null
  for (const record of records) {
    if (clientY < record.top) return previous ?? record
    previous = record
  }
  return previous
}

/** Resolve a list target from a visual anchor and the source item depth. */
export function resolveListDropTarget(
  doc: PMNode,
  drag: Pick<DraggedBlockRange, 'from' | 'to' | 'sourceDepth' | 'sourceListTypeName'>,
  anchor: Pick<ListItemRecord, 'pos' | 'depth'>,
  side: 'before' | 'after',
): BlockDropTarget | null {
  const anchorNode = doc.nodeAt(anchor.pos)
  if (!anchorNode || !LIST_ITEM_TYPES.has(anchorNode.type.name)) return null

  const desiredDepth = Math.min(drag.sourceDepth, anchor.depth + 1)
  const context = getListItemContext(doc, anchor.pos, anchorNode, anchor.depth)
  if (!context) return null

  // Walk upward when the desired child list does not exist. Root-level drops
  // may create one list wrapper; nested levels are never synthesized here.
  for (let depth = desiredDepth; depth >= 0; depth -= 1) {
    const candidate = getTargetAtDepth(context, depth, side, drag.sourceListTypeName)
    if (!candidate || !isCompatibleTargetList(candidate.listTypeName, drag.sourceListTypeName, anchorNode.type.name)) {
      continue
    }

    return {
      insertPos: candidate.insertPos,
      listPos: candidate.listPos,
      listTypeName: candidate.listTypeName,
      createList: false,
      anchorPos: anchor.pos,
      anchorDepth: anchor.depth,
      desiredDepth: depth,
      side,
    }
  }
  return null
}

interface ListItemContext {
  doc: PMNode
  anchor: { pos: number; node: PMNode; depth: number }
  ancestors: Array<{ pos: number; node: PMNode; depth: number }>
}

interface TargetAtDepth {
  listPos: number
  listTypeName: string
  insertPos: number
}

function getListItemContext(doc: PMNode, anchorPos: number, anchorNode: PMNode, anchorDepth: number): ListItemContext | null {
  try {
    const $anchor = doc.resolve(anchorPos)
    const ancestors: Array<{ pos: number; node: PMNode; depth: number }> = []
    for (let depth = 1; depth <= $anchor.depth; depth += 1) {
      const node = $anchor.node(depth)
      if (LIST_ITEM_TYPES.has(node.type.name)) {
        ancestors.push({ pos: $anchor.before(depth), node, depth: ancestors.length })
      }
    }
    return { doc, anchor: { pos: anchorPos, node: anchorNode, depth: anchorDepth }, ancestors }
  } catch {
    return null
  }
}

function getTargetAtDepth(
  context: ListItemContext,
  depth: number,
  side: 'before' | 'after',
  sourceListTypeName: string | null,
): TargetAtDepth | null {
  if (depth === context.anchor.depth + 1) {
    const childList = findChildList(context.anchor, sourceListTypeName)
    if (!childList) return null
    return {
      listPos: childList.pos,
      listTypeName: childList.node.type.name,
      insertPos: side === 'before' ? childList.pos + 1 : childList.pos + 1 + childList.node.content.size,
    }
  }

  const item = depth === context.anchor.depth ? context.anchor : context.ancestors[depth]
  if (!item) return null
  const parent = getParentList(context.doc, item.pos)
  if (!parent) return null
  return {
    listPos: parent.pos,
    listTypeName: parent.node.type.name,
    insertPos: side === 'before' ? item.pos : item.pos + item.node.nodeSize,
  }
}

function findChildList(
  item: { pos: number; node: PMNode },
  sourceListTypeName: string | null,
): { pos: number; node: PMNode } | null {
  let result: { pos: number; node: PMNode } | null = null
  item.node.forEach((child, offset) => {
    if (result || !LIST_TYPES.has(child.type.name)) return
    if (sourceListTypeName === 'taskList' && child.type.name !== 'taskList') return
    if (sourceListTypeName !== 'taskList' && child.type.name === 'taskList') return
    result = { pos: item.pos + 1 + offset, node: child }
  })
  return result
}

function getParentList(doc: PMNode, itemPos: number): { pos: number; node: PMNode } | null {
  try {
    const $item = doc.resolve(itemPos)
    return { pos: $item.before($item.depth), node: $item.parent }
  } catch {
    return null
  }
}

function isCompatibleTargetList(listTypeName: string, sourceListTypeName: string | null, sourceItemTypeName: string): boolean {
  if (sourceItemTypeName === 'taskItem' || sourceListTypeName === 'taskList') return listTypeName === 'taskList'
  return listTypeName === 'bulletList' || listTypeName === 'orderedList'
}

function getListNestingDepth(doc: PMNode, listPos: number): number {
  try {
    const $list = doc.resolve(listPos)
    let depth = 0
    for (let level = 1; level <= $list.depth; level += 1) {
      if (LIST_TYPES.has($list.node(level).type.name)) depth += 1
    }
    return depth
  } catch {
    return 0
  }
}

function getListItemDepth(doc: PMNode, itemPos: number): number {
  try {
    const $pos = doc.resolve(itemPos)
    let depth = 0
    for (let level = 1; level <= $pos.depth; level += 1) {
      if (LIST_ITEM_TYPES.has($pos.node(level).type.name)) depth += 1
    }
    return depth
  } catch {
    return 0
  }
}

function mapDropTarget(target: BlockDropTarget, mapping: { map: (pos: number, assoc?: number) => number }): BlockDropTarget {
  return {
    ...target,
    insertPos: mapping.map(target.insertPos, -1),
    listPos: mapping.map(target.listPos, -1),
    anchorPos: mapping.map(target.anchorPos, -1),
    splitList: target.splitList
      ? { ...target.splitList, listPos: mapping.map(target.splitList.listPos, -1) }
      : undefined,
    nestList: target.nestList
      ? { itemPos: mapping.map(target.nestList.itemPos, -1) }
      : undefined,
  }
}

function isValidDropPos(view: EditorView, drag: DraggedBlockRange, target: BlockDropTarget): boolean {
  const { insertPos } = target
  if (insertPos >= drag.from && insertPos <= drag.to) return false
  const { doc } = view.state
  if (insertPos < 0 || insertPos > doc.content.size) return false

  try {
    const $insert = doc.resolve(insertPos)
    if (target.nestList) {
      const parentItem = doc.nodeAt(target.nestList.itemPos)
      const sourceItem = doc.nodeAt(drag.from)
      const $source = doc.resolve(drag.from)
      const sourceList = $source.parent
      if (!parentItem || !LIST_ITEM_TYPES.has(parentItem.type.name)
        || !sourceItem || !isListTypeName(sourceList.type.name)) return false
      const updated = nestItemInParent(view.state, parentItem, sourceList, sourceItem, $source.index())
      const $item = doc.resolve(target.nestList.itemPos)
      return $item.parent.canReplace($item.index(), $item.index() + 1, Fragment.from(updated))
    }
    if (target.splitList) {
      const list = doc.nodeAt(target.splitList.listPos)
      const block = doc.nodeAt(drag.from)
      if (!list || !LIST_TYPES.has(list.type.name) || !block) return false
      const index = target.splitList.boundaryIndex
      if (index <= 0 || index >= list.childCount) return false
      const items = itemsOf(list)
      const before = listWithItems(list, items.slice(0, index))!
      const after = listWithItems(list, items.slice(index), index)!
      const middle = drag.isListItem
        ? wrapDraggedItem(view.state, doc.resolve(drag.from).parent, block, doc.resolve(drag.from).index())
        : block
      const $list = doc.resolve(target.splitList.listPos)
      return $list.parent.canReplace($list.index(), $list.index() + 1, Fragment.fromArray([before, middle, after]))
    }
    if (drag.isListItem && target.createList) {
      if ($insert.depth !== 0 || !LIST_TYPES.has(target.listTypeName)) return false
      const listType = view.state.schema.nodes[target.listTypeName]
      if (!listType) return false
      const list = listType.create(null, doc.slice(drag.from, drag.to).content)
      return $insert.parent.canReplace($insert.index(), $insert.index(), Fragment.from(list))
    }
    if (drag.isListItem && !LIST_TYPES.has($insert.parent.type.name)) return false
    if (!drag.isListItem) {
      const sameParent = $insert.parent.type.name === drag.parentTypeName && $insert.start($insert.depth) === drag.parentStart
      if (!sameParent) return false
    }
    const slice = doc.slice(drag.from, drag.to)
    return $insert.parent.canReplace($insert.index(), $insert.index(), slice.content)
  } catch {
    return false
  }
}

function mergeAdjacentRootLists(tr: Transaction, insertedPos: number): void {
  let currentPos = insertedPos
  let current = tr.doc.nodeAt(currentPos)
  if (!current || !LIST_TYPES.has(current.type.name)) return

  const previousPos = getPreviousSiblingPos(tr.doc, currentPos)
  const previous = previousPos == null ? null : tr.doc.nodeAt(previousPos)
  if (previousPos != null && canMergeListRuns(previous, current)) {
    tr.join(currentPos)
    currentPos = previousPos
    current = tr.doc.nodeAt(currentPos)
  }

  if (!current || !LIST_TYPES.has(current.type.name)) return
  const nextPos = currentPos + current.nodeSize
  const next = tr.doc.nodeAt(nextPos)
  if (canMergeListRuns(current, next)) tr.join(nextPos)
}

function getPreviousSiblingPos(doc: PMNode, pos: number): number | null {
  let previousPos: number | null = null
  doc.forEach((_node, offset) => {
    if (offset < pos) previousPos = offset
  })
  return previousPos
}

function cleanupSourceList(tr: Transaction, sourceListPos: number, sourceWasSingleton: boolean): void {
  if (!sourceWasSingleton) return
  const list = tr.doc.nodeAt(sourceListPos)
  if (!list || !LIST_TYPES.has(list.type.name)) return

  // Deleting the source list's only item can leave a schema-preserving
  // placeholder. An empty item that existed alongside the source is user data.
  if (list.childCount === 1 && isEmptyListItem(list.firstChild)) {
    tr.delete(sourceListPos, sourceListPos + list.nodeSize)
  }
}

function isEmptyListItem(node: PMNode | null): boolean {
  if (!node || !LIST_ITEM_TYPES.has(node.type.name) || node.childCount !== 1) return false
  const paragraph = node.firstChild
  return !!paragraph && paragraph.type.name === 'paragraph' && paragraph.content.size === 0
}

function removeEmptyLists(tr: { doc: PMNode; delete: (from: number, to: number) => unknown }): void {
  const emptyLists: number[] = []
  tr.doc.descendants((node, pos) => {
    if (LIST_TYPES.has(node.type.name) && node.childCount === 0) emptyLists.push(pos)
    return true
  })

  for (const pos of emptyLists.sort((a, b) => b - a)) {
    const node = tr.doc.nodeAt(pos)
    if (node && LIST_TYPES.has(node.type.name) && node.childCount === 0) tr.delete(pos, pos + node.nodeSize)
  }
}
