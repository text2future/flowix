import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import type { CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import { computeHandlePosition } from '@features/editor/components/drag-context-menu/positioning'

interface DragHandlePositionState {
  visible: boolean
  x: number
  y: number
  blockInfo: CurrentBlockInfo | null
}

const HIDDEN_STATE: DragHandlePositionState = {
  visible: false,
  x: 0,
  y: 0,
  blockInfo: null,
}

function isSameBlock(a: CurrentBlockInfo | null, b: CurrentBlockInfo | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.pos === b.pos && a.typeName === b.typeName && a.attrs.level === b.attrs.level
}

function shouldUpdateState(prev: DragHandlePositionState, next: DragHandlePositionState): boolean {
  return (
    prev.visible !== next.visible ||
    prev.x !== next.x ||
    prev.y !== next.y ||
    !isSameBlock(prev.blockInfo, next.blockInfo)
  )
}

export function useDragHandlePosition(
  editor: Editor,
  fontSize: number,
  lineHeight: number,
  ignoreBlurRef?: RefObject<boolean>,
  keepVisibleRef?: RefObject<boolean>,
): DragHandlePositionState {
  const [state, setState] = useState<DragHandlePositionState>(HIDDEN_STATE)
  const frameRef = useRef<number | null>(null)
  const trailingResizeRef = useRef<number | null>(null)

  useEffect(() => {
    // editor 可能被销毁后这条 effect 还触发 (e.g. 切换文档/语言时父组件
    // 先卸载, store 又 dispatch 了一次新引用)。访问 editor.view.dom 会
    // 触发 "editor view is not available"。
    if (!editor?.view?.dom || editor.view.isDestroyed) return

    let mounted = true

    const commitState = (next: DragHandlePositionState) => {
      if (!mounted) return
      setState((prev) => shouldUpdateState(prev, next) ? next : prev)
    }

    const updateDragHandle = () => {
      if (!mounted) return
      const pos = computeHandlePosition(editor, fontSize, lineHeight, !keepVisibleRef?.current)
      if (!pos || !pos.visible) {
        commitState(HIDDEN_STATE)
        return
      }
      commitState({
        visible: true,
        x: pos.x,
        y: pos.y,
        blockInfo: pos.blockInfo,
      })
    }

    const scheduleUpdate = () => {
      if (frameRef.current != null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        updateDragHandle()
      })
    }

    const scheduleTrailingResizeUpdate = () => {
      if (trailingResizeRef.current != null) {
        window.clearTimeout(trailingResizeRef.current)
      }
      trailingResizeRef.current = window.setTimeout(() => {
        trailingResizeRef.current = null
        scheduleUpdate()
      }, 80)
    }

    const editorDom = editor.view.dom as HTMLElement
    if (editor.view.isDestroyed) return
    const scrollContainer = editorDom.closest('.markdown-editor') as HTMLElement | null
    const scrollTarget = scrollContainer || editorDom
    const resizeTarget = scrollContainer || editorDom

    const handleBlur = () => {
      if (keepVisibleRef?.current) return
      if (ignoreBlurRef?.current) return
      commitState(HIDDEN_STATE)
    }
    const handleResize = () => {
      scheduleUpdate()
      scheduleTrailingResizeUpdate()
    }

    editor.on('selectionUpdate', updateDragHandle)
    editor.on('focus', updateDragHandle)
    editor.on('blur', handleBlur)
    scrollTarget.addEventListener('scroll', scheduleUpdate, { passive: true })

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(resizeTarget)
    updateDragHandle()

    return () => {
      mounted = false
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
      if (trailingResizeRef.current != null) window.clearTimeout(trailingResizeRef.current)
      frameRef.current = null
      trailingResizeRef.current = null
      editor.off('selectionUpdate', updateDragHandle)
      editor.off('focus', updateDragHandle)
      editor.off('blur', handleBlur)
      scrollTarget.removeEventListener('scroll', scheduleUpdate)
      resizeObserver.disconnect()
    }
  }, [editor, fontSize, lineHeight, ignoreBlurRef, keepVisibleRef])

  return state
}
