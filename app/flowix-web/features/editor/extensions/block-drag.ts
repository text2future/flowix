import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { getCurrentBlockInfo, type CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'

export const BLOCK_DRAG_MIME = 'application/x-flowix-block-drag'

interface DraggedBlockRange {
  from: number
  to: number
  parentStart: number
  parentTypeName: string
}

interface BlockDragState extends DraggedBlockRange {
  dropPos: number | null
}

export const blockDragPluginKey = new PluginKey<BlockDragState | null>('blockDrag')

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
      new Plugin({
        props: {
          handleDOMEvents: {
            dragleave(view, event) {
              const drag = blockDragPluginKey.getState(view.state)
              if (!drag) return false
              if (event.relatedTarget instanceof Node && view.dom.contains(event.relatedTarget)) {
                return false
              }
              view.dispatch(view.state.tr.setMeta(blockDragPluginKey, { ...drag, dropPos: null }))
              return false
            },
          },
        },
      }),
      new Plugin({
        props: {
          handleDOMEvents: {
            dragover(view, event) {
              const drag = blockDragPluginKey.getState(view.state)
              if (!drag) return false
              event.preventDefault()
              const dropPos = findInsertPos(view, drag, event.clientX, event.clientY)
              const validDropPos = dropPos != null && isValidDropPos(view, drag, dropPos)
                ? dropPos
                : null
              if (event.dataTransfer) {
                event.dataTransfer.dropEffect = validDropPos == null ? 'none' : 'move'
              }
              if (drag.dropPos !== validDropPos) {
                view.dispatch(view.state.tr.setMeta(blockDragPluginKey, { ...drag, dropPos: validDropPos }))
              }
              return true
            },
            drop(view, event) {
              if (!hasActiveBlockDrag(view)) return false
              event.preventDefault()
              moveDraggedBlock(view, event.clientX, event.clientY)
              return true
            },
          },
        },
      }),
    ]
  },
})

export function startBlockDrag(editor: Editor, info?: CurrentBlockInfo | null): boolean {
  const block = info ?? getCurrentBlockInfo(editor)
  if (!block) return false

  const $pos = editor.state.doc.resolve(block.pos)
  const parent = $pos.parent
  const range: BlockDragState = {
    from: block.pos,
    to: block.pos + block.nodeSize,
    parentStart: $pos.start($pos.depth),
    parentTypeName: parent.type.name,
    dropPos: null,
  }

  editor.view.dispatch(editor.state.tr.setMeta(blockDragPluginKey, range))
  return true
}

export function endBlockDrag(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(blockDragPluginKey, null))
}

function hasActiveBlockDrag(view: EditorView): boolean {
  return blockDragPluginKey.getState(view.state) != null
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
