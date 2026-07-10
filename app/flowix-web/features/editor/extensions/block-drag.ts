import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { getCurrentBlockInfo, type CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'

interface DraggedBlockRange {
  from: number
  to: number
  parentStart: number
  parentTypeName: string
}

interface BlockDragState extends DraggedBlockRange {
  dropPos: number | null
}

export interface BlockDragTarget {
  pos: number
  nodeSize: number
}

export const blockDragPluginKey = new PluginKey<BlockDragState | null>('blockDrag')

/**
 * Editor-level block move state.
 *
 * UI surfaces such as the left gutter handle or an AgentThreadCard header
 * should call start/update/drop/cancel below. The plugin itself owns only the
 * ProseMirror state and drop-line decoration.
 */
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
            const from = tr.mapping.map(value.from, -1)
            const to = tr.mapping.map(value.to, 1)
            if (from >= to) return null
            const dropPos = value.dropPos == null ? null : tr.mapping.map(value.dropPos, -1)
            return { ...value, from, to, dropPos }
          },
        },
        props: {
          decorations(state) {
            const drag = blockDragPluginKey.getState(state)
            if (drag?.dropPos == null) return null
            return DecorationSet.create(state.doc, [
              Decoration.widget(drag.dropPos, () => {
                const marker = document.createElement('div')
                marker.className = 'flowix-block-drop-indicator'
                marker.contentEditable = 'false'
                return marker
              }, { side: -1 }),
            ])
          },
        },
      }),
    ]
  },
})

export function startBlockDrag(editor: Editor, info?: CurrentBlockInfo | null): boolean {
  // editor 可能已经被销毁 (e.g. 语言切换触发重建, 仍有 in-flight 调用);
  // 继续读 editor.view.dom 会触发 "editor view is not available"。
  if (editor.isDestroyed) return false
  const block = info ?? getCurrentBlockInfo(editor)
  if (!block) return false

  return startBlockDragForView(editor.view, block)
}

export function startBlockDragForView(view: EditorView, block: BlockDragTarget): boolean {
  if (view.isDestroyed) return false
  const $pos = view.state.doc.resolve(block.pos)
  const parent = $pos.parent
  const range: BlockDragState = {
    from: block.pos,
    to: block.pos + block.nodeSize,
    parentStart: $pos.start($pos.depth),
    parentTypeName: parent.type.name,
    dropPos: null,
  }

  view.dispatch(view.state.tr.setMeta(blockDragPluginKey, range))
  return true
}

/** Cancel an in-flight block drag and remove the drop indicator. */
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

/** Update the candidate insert position for the current pointer coordinates. */
export function updateBlockDragPosition(editor: Editor, clientX: number, clientY: number): boolean {
  if (editor.isDestroyed) return false
  return updateBlockDragPositionForView(editor.view, clientX, clientY)
}

/** Move the dragged block to the current or computed insert position. */
export function dropBlockDragAt(editor: Editor, clientX: number, clientY: number): boolean {
  if (editor.isDestroyed) return false
  return dropBlockDragAtForView(editor.view, clientX, clientY)
}

export function updateBlockDragPositionForView(view: EditorView, clientX: number, clientY: number): boolean {
  const drag = blockDragPluginKey.getState(view.state)
  if (!drag) return false
  const validDropPos = getValidDropPos(view, drag, clientX, clientY)
  if (drag.dropPos !== validDropPos) {
    view.dispatch(view.state.tr.setMeta(blockDragPluginKey, { ...drag, dropPos: validDropPos }))
  }
  return validDropPos != null
}

export function dropBlockDragAtForView(view: EditorView, clientX: number, clientY: number): boolean {
  if (view.isDestroyed) return false
  return moveDraggedBlock(view, clientX, clientY)
}

function getValidDropPos(
  view: EditorView,
  drag: DraggedBlockRange,
  clientX: number,
  clientY: number,
): number | null {
  const dropPos = findInsertPos(view, drag, clientX, clientY)
  return dropPos != null && isValidDropPos(view, drag, dropPos) ? dropPos : null
}

function moveDraggedBlock(view: EditorView, clientX: number, clientY: number): boolean {
  const drag = blockDragPluginKey.getState(view.state)
  if (!drag) return false

  const insertPos = drag.dropPos ?? findInsertPos(view, drag, clientX, clientY)
  if (insertPos == null || !isValidDropPos(view, drag, insertPos)) {
    view.dispatch(view.state.tr.setMeta(blockDragPluginKey, null))
    return false
  }

  const { state } = view
  const slice = state.doc.slice(drag.from, drag.to)
  const blockSize = drag.to - drag.from
  const mappedInsertPos = insertPos > drag.from ? insertPos - blockSize : insertPos

  if (mappedInsertPos === drag.from) {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }

  try {
    const tr = state.tr
      .delete(drag.from, drag.to)
      .insert(mappedInsertPos, slice.content)
      .setMeta(blockDragPluginKey, null)
    view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    view.dispatch(state.tr.setMeta(blockDragPluginKey, null))
    return false
  }
}

function findInsertPos(
  view: EditorView,
  drag: DraggedBlockRange,
  clientX: number,
  clientY: number,
): number | null {
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

function findInsertPosBySiblingRects(
  view: EditorView,
  drag: DraggedBlockRange,
  clientY: number,
): number | null {
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

function isValidDropPos(view: EditorView, drag: DraggedBlockRange, insertPos: number): boolean {
  if (insertPos >= drag.from && insertPos <= drag.to) return false

  const { doc } = view.state
  if (insertPos < 0 || insertPos > doc.content.size) return false

  try {
    const $insert = doc.resolve(insertPos)
    const sameParent =
      $insert.parent.type.name === drag.parentTypeName &&
      $insert.start($insert.depth) === drag.parentStart
    if (!sameParent) return false

    const slice = doc.slice(drag.from, drag.to)
    return $insert.parent.canReplace($insert.index(), $insert.index(), slice.content)
  } catch {
    return false
  }
}
