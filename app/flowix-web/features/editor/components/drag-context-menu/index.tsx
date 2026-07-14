import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { Editor } from '@tiptap/core'
import { getCurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import {
  applyMenuItem,
  deleteBlock,
  pinBlock,
  unpinBlock,
} from '@features/editor/components/drag-context-menu/actions'
import {
  cancelBlockDrag,
  dropBlockDragAt,
  startBlockDrag,
  updateBlockDragPosition,
} from '@features/editor/extensions/block-drag'
import { renderDragIcon } from '@features/editor/components/drag-context-menu/icons'
import type { BlockMenuItem } from '@features/editor/components/drag-context-menu/items'
import { HANDLE_SIZE } from '@features/editor/components/drag-context-menu/style'
import { useDragHandlePosition } from '@features/editor/components/drag-context-menu/use-drag-handle-position'
import { BlockActionMenu } from '@features/editor/components/drag-context-menu/block-action-menu'
import { useBlockMenuActions } from '@features/editor/components/drag-context-menu/block-menu-actions'
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store'

interface DragContextMenuProps {
  editor: Editor
}

interface MenuViewportPosition {
  left: number
  top: number
}

interface PointerBlockDragState {
  pointerId: number
  startX: number
  startY: number
  started: boolean
}

const MENU_GAP = 8
const MENU_VIEWPORT_PADDING = 8
// 底部状态栏 (h-6 = 24px) 会遮挡太贴近视口底部的弹窗 —
// 留出 30px 净空让菜单至少停在状态栏之上约 6px。
const MENU_BOTTOM_CLEARANCE = 30
const BLOCK_DRAG_START_THRESHOLD_PX = 4

export function DragContextMenu({ editor }: DragContextMenuProps) {
  // 字体/行高 (Preferences → Format) — 走窄 selector, 只在这两值变化时
  // 重渲染, 避免 theme / personalize / shortcuts 改动把整个组件拉一遍。
  // 这两个值进 useEffect deps, slider 拖动时 handle 跟着重新锚定。
  const fontSize = useUserSettingsStore((s) => s.settings.format.fontSize)
  const lineHeight = useUserSettingsStore((s) => s.settings.format.lineHeight)

  const [showMenu, setShowMenu] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [menuPosition, setMenuPosition] = useState<MenuViewportPosition | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [menuInputMode, setMenuInputMode] = useState<'mouse' | 'keyboard'>('mouse')
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const ignoreBlur = useRef(false)
  const menuOpenRef = useRef(false)
  const didStartDrag = useRef(false)
  const pointerDragRef = useRef<PointerBlockDragState | null>(null)
  const state = useDragHandlePosition(editor, fontSize, lineHeight, ignoreBlur, menuOpenRef)

  useEffect(() => {
    menuOpenRef.current = showMenu
  }, [showMenu])

  useEffect(() => {
    const handleBlur = () => {
      if (!ignoreBlur.current) {
        setShowMenu(false)
        setIsHovered(false)
        unpinBlock(editor)
      }
    }

    editor.on('blur', handleBlur)
    return () => {
      editor.off('blur', handleBlur)
    }
  }, [editor])

  const updateMenuPosition = useCallback(() => {
    if (!containerRef.current || !menuRef.current) return
    const handleRect = containerRef.current.getBoundingClientRect()
    const menuRect = menuRef.current.getBoundingClientRect()
    const rightSpace = window.innerWidth - handleRect.right - MENU_GAP - MENU_VIEWPORT_PADDING
    const leftSpace = handleRect.left - MENU_GAP - MENU_VIEWPORT_PADDING
    const placeRight = rightSpace >= menuRect.width || rightSpace >= leftSpace
    const preferredLeft = placeRight
      ? handleRect.right + MENU_GAP
      : handleRect.left - MENU_GAP - menuRect.width
    const preferredTop = handleRect.top

    setMenuPosition({
      left: clamp(preferredLeft, MENU_VIEWPORT_PADDING, window.innerWidth - menuRect.width - MENU_VIEWPORT_PADDING),
      top: clamp(preferredTop, MENU_VIEWPORT_PADDING, window.innerHeight - menuRect.height - MENU_BOTTOM_CLEARANCE),
    })
  }, [])

  const closeMenu = useCallback(() => {
    unpinBlock(editor)
    setMenuPosition(null)
    setIsHovered(false)
    setShowMenu(false)
  }, [editor])

  useLayoutEffect(() => {
    if (!showMenu) return
    updateMenuPosition()
  }, [showMenu, state.x, state.y, updateMenuPosition])

  useEffect(() => {
    if (!showMenu) return
    // showMenu 可能在 editor 销毁之后还变化 (e.g. 卸载过程)
    // 此时 editor.view.dom 会触发 view-not-available 警告。
    if (editor.isDestroyed) return

    const editorDom = editor.view.dom as HTMLElement
    const scrollContainer = editorDom.closest('.markdown-editor') as HTMLElement | null
    const scrollTarget = scrollContainer || editorDom
    const closeOnScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      closeMenu()
    }

    scrollTarget.addEventListener('scroll', closeOnScroll, { passive: true })
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeOnScroll, true)

    return () => {
      scrollTarget.removeEventListener('scroll', closeOnScroll)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [showMenu, editor, closeMenu])

  // Click outside the handle dismisses the menu + drops the pin.
  useEffect(() => {
    if (!showMenu) return

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowMenu(false)
        // 关闭时强制清零 hover: 鼠标此时已在 handle 之外, mouseleave 不可靠
        // (在 child 被卸载/容器位置并发变化的窗口里会丢), 不主动清就会
        // 把脏 hover=true 带到下一次 handle 出现的位置。
        setIsHovered(false)
        unpinBlock(editor)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showMenu, editor])

  const onMenuItem = useCallback((item: BlockMenuItem) => {
    applyMenuItem(editor, item)
    setShowMenu(false)
    // 鼠标停在菜单项上(handle 之外),hover 态必须强制清零;
    // 否则 applyMenuItem 触发 selectionUpdate 把 handle 挪到新位置后,
    // 残留的 isHovered=true 会让新位置的 handle 误显 hover 背景。
    setIsHovered(false)
    // The transformed block may be at a different position; drop the pin
    // so the next selectionUpdate can re-pin to the new block.
    unpinBlock(editor)
  }, [editor])

  const onDelete = useCallback(() => {
    deleteBlock(editor)
    setShowMenu(false)
    // 同 onMenuItem: 鼠标在菜单项上(handle 外),hover 态强制清零。
    setIsHovered(false)
    // The deleted node is gone — drop the pin. The plugin's docChanged
    // handler additionally re-validates any stale pin position.
    unpinBlock(editor)
  }, [editor])
  const menuActions = useBlockMenuActions(onMenuItem, onDelete)

  const openMenu = () => {
    const info = getCurrentBlockInfo(editor)
    if (info) {
      pinBlock(editor, info)
    }
    setMenuPosition(null)
    setIsHovered(false)
    setSelectedIndex(0)
    setMenuInputMode('mouse')
    setShowMenu(true)
  }

  const handleMenuHover = (index: number) => {
    setMenuInputMode('mouse')
    setSelectedIndex(index)
  }

  const selectCurrentMenuAction = () => {
    const action = menuActions[selectedIndex]
    if (action) action.onSelect()
  }

  const moveSelection = (direction: 1 | -1) => {
    const count = menuActions.length
    if (count === 0) return
    setSelectedIndex((index) => (index + direction + count) % count)
  }

  const handleMenuKeyDown = (e: KeyboardEvent | globalThis.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setMenuInputMode('keyboard')
      moveSelection(-1)
      return true
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setMenuInputMode('keyboard')
      moveSelection(1)
      return true
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      setMenuInputMode('keyboard')
      moveSelection(e.shiftKey ? -1 : 1)
      return true
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      selectCurrentMenuAction()
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
      return true
    }
    return false
  }

  useEffect(() => {
    if (!showMenu) return

    const frameId = window.requestAnimationFrame(() => {
      ignoreBlur.current = true
      menuRef.current?.focus({ preventScroll: true })
      window.setTimeout(() => {
        ignoreBlur.current = false
      }, 0)
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [showMenu])

  const toggleMenu = () => {
    if (showMenu) {
      closeMenu()
    } else {
      openMenu()
    }
  }

  const onHandleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (showMenu && handleMenuKeyDown(e)) {
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleMenu()
    }
  }

  const suppressNextClickAfterDrag = () => {
    window.setTimeout(() => {
      didStartDrag.current = false
    }, 0)
  }

  const releasePointerCapture = (target: HTMLElement, pointerId: number) => {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId)
    }
  }

  return (
    <div
      ref={containerRef}
      role="button"
      aria-haspopup="menu"
      aria-expanded={showMenu}
      tabIndex={state.visible ? 0 : -1}
      className={`drag-context-menu-handle${showMenu ? ' active' : ''}`}
      style={{
        position: 'absolute',
        left: `${state.x}px`,
        top: `${state.y}px`,
        width: `${HANDLE_SIZE}px`,
        height: `${HANDLE_SIZE}px`,
        display: state.visible ? 'flex' : 'none',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
        zIndex: 100,
        background: showMenu ? 'var(--brand)' : (isHovered ? 'var(--muted)' : 'transparent'),
        color: showMenu ? 'var(--primary-foreground)' : 'var(--brand)',
        borderRadius: '4px',
        cursor: 'grab',
        boxShadow: 'none',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={(e) => {
        ignoreBlur.current = true
        window.setTimeout(() => {
          ignoreBlur.current = false
        }, 0)
        if (showMenu) {
          e.preventDefault()
        }
      }}
      onKeyDown={onHandleKeyDown}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        ignoreBlur.current = true
        pointerDragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          started: false,
        }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const drag = pointerDragRef.current
        if (!drag || drag.pointerId !== e.pointerId) return
        const dx = e.clientX - drag.startX
        const dy = e.clientY - drag.startY
        if (!drag.started) {
          if (Math.hypot(dx, dy) < BLOCK_DRAG_START_THRESHOLD_PX) return
          const started = startBlockDrag(editor, state.blockInfo)
          if (!started) {
            pointerDragRef.current = null
            ignoreBlur.current = false
            return
          }
          drag.started = true
          didStartDrag.current = true
          setShowMenu(false)
          setIsHovered(false)
          if (state.blockInfo) pinBlock(editor, state.blockInfo)
        }
        updateBlockDragPosition(editor, e.clientX, e.clientY)
        e.preventDefault()
      }}
      onPointerUp={(e) => {
        const drag = pointerDragRef.current
        if (!drag || drag.pointerId !== e.pointerId) return
        pointerDragRef.current = null
        if (drag.started) {
          dropBlockDragAt(editor, e.clientX, e.clientY)
          unpinBlock(editor)
          suppressNextClickAfterDrag()
        }
        ignoreBlur.current = false
        releasePointerCapture(e.currentTarget, e.pointerId)
      }}
      onPointerCancel={(e) => {
        const drag = pointerDragRef.current
        if (!drag || drag.pointerId !== e.pointerId) return
        pointerDragRef.current = null
        if (drag.started) {
          cancelBlockDrag(editor)
          unpinBlock(editor)
          suppressNextClickAfterDrag()
        }
        ignoreBlur.current = false
        releasePointerCapture(e.currentTarget, e.pointerId)
      }}
      onClick={() => {
        if (didStartDrag.current) return
        toggleMenu()
        ignoreBlur.current = false
      }}
    >
      {renderDragIcon(state.blockInfo)}
      {showMenu && (
        <BlockActionMenu
          actions={menuActions}
          selectedIndex={selectedIndex}
          mouseHoverEnabled={menuInputMode === 'mouse'}
          menuRef={(node) => {
            menuRef.current = node
          }}
          style={getMenuStyle(menuPosition)}
          onHover={handleMenuHover}
          onKeyDown={handleMenuKeyDown}
        />
      )}
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function getMenuStyle(position: MenuViewportPosition | null): CSSProperties {
  return {
    left: position ? `${position.left}px` : '-9999px',
    top: position ? `${position.top}px` : '-9999px',
    minWidth: 180,
  }
}
