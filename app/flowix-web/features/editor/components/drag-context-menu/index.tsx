import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import {
  activateAgentThreadCard,
  getBlockInfoForInteraction,
  type CurrentBlockInfo,
} from '@features/editor/components/drag-context-menu/block-info'
import {
  applyMenuItem,
  deleteBlock,
  setImageAlignment,
  pinBlock,
  unpinBlock,
} from '@features/editor/components/drag-context-menu/actions'
import {
  useBlockDragGesture,
} from '@features/editor/components/drag-context-menu/use-block-drag-gesture'
import { renderDragIcon } from '@features/editor/components/drag-context-menu/icons'
import type { BlockMenuItem } from '@features/editor/components/drag-context-menu/items'
import { HANDLE_SIZE } from '@features/editor/components/drag-context-menu/style'
import { useDragHandlePosition } from '@features/editor/components/drag-context-menu/use-drag-handle-position'
import { BlockActionMenu } from '@features/editor/components/drag-context-menu/block-action-menu'
import { useBlockMenuActions } from '@features/editor/components/drag-context-menu/block-menu-actions'
import { useEditorTypography } from '@features/preferences/public/runtime-api'

interface DragContextMenuProps {
  editor: Editor
}

interface MenuViewportPosition {
  left: number
  top: number
}

const MENU_GAP = 8
const MENU_VIEWPORT_PADDING = 8
// 底部状态栏 (h-6 = 24px) 会遮挡太贴近视口底部的弹窗 —
// 留出 30px 净空让菜单至少停在状态栏之上约 6px。
const MENU_BOTTOM_CLEARANCE = 30
export function DragContextMenu({ editor }: DragContextMenuProps) {
  // 字体/行高 (Preferences → Format) — 走窄 selector, 只在这两值变化时
  // 重渲染, 避免 theme / personalize / shortcuts 改动把整个组件拉一遍。
  // 这两个值进 useEffect deps, slider 拖动时 handle 跟着重新锚定。
  const { fontSize, lineHeight } = useEditorTypography()

  const [showMenu, setShowMenu] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [menuPosition, setMenuPosition] = useState<MenuViewportPosition | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [menuInputMode, setMenuInputMode] = useState<'mouse' | 'keyboard'>('mouse')
  const [menuTarget, setMenuTarget] = useState<CurrentBlockInfo | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const ignoreBlur = useRef(false)
  const menuOpenRef = useRef(false)
  const menuTargetRef = useRef<CurrentBlockInfo | null>(null)
  const menuAnchorRectRef = useRef<DOMRect | null>(null)
  const openMenuRef = useRef<(anchorRect?: DOMRect) => void>(() => {})
  const state = useDragHandlePosition(editor, fontSize, lineHeight, ignoreBlur, menuOpenRef, menuTargetRef)
  const handleTap = useCallback((anchorRect: DOMRect) => openMenuRef.current(anchorRect), [])

  const handleBlockDragStart = useCallback(() => {
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    setShowMenu(false)
    setIsHovered(false)
    setMenuTarget(null)
  }, [])
  const {
    isDragging,
    interactionBlockInfoRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
  } = useBlockDragGesture({
    editor,
    blockInfo: state.blockInfo,
    ignoreBlurRef: ignoreBlur,
    onDragStart: handleBlockDragStart,
    onTap: handleTap,
  })

  useEffect(() => {
    menuOpenRef.current = showMenu
  }, [showMenu])

  useEffect(() => {
    const handleBlur = () => {
      if (!ignoreBlur.current) {
        menuOpenRef.current = false
        menuTargetRef.current = null
        menuAnchorRectRef.current = null
        setShowMenu(false)
        setIsHovered(false)
        setMenuTarget(null)
        interactionBlockInfoRef.current = null
        unpinBlock(editor)
        window.requestAnimationFrame(state.refresh)
      }
    }

    editor.on('blur', handleBlur)
    return () => {
      editor.off('blur', handleBlur)
    }
  }, [editor, state.refresh])

  const updateMenuPosition = useCallback(() => {
    if (!containerRef.current || !menuRef.current) return
    const liveHandleRect = containerRef.current.getBoundingClientRect()
    // Prefer live geometry after opening so normal reflows remain anchored;
    // fall back to the pointerdown snapshot only when the handle is hidden.
    const handleRect = liveHandleRect.width > 0 && liveHandleRect.height > 0
      ? liveHandleRect
      : menuAnchorRectRef.current ?? liveHandleRect
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
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    unpinBlock(editor)
    setMenuPosition(null)
    setIsHovered(false)
    setShowMenu(false)
    setMenuTarget(null)
    interactionBlockInfoRef.current = null
    window.requestAnimationFrame(state.refresh)
  }, [editor, interactionBlockInfoRef, state.refresh])

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
    const scrollContainer = editorDom.closest('.editor-content') as HTMLElement | null
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

  // Click outside both the handle and the portalled menu dismisses the menu
  // and drops the pin.
  useEffect(() => {
    if (!showMenu) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      closeMenu()
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showMenu, closeMenu])

  const onMenuItem = useCallback((item: BlockMenuItem) => {
    applyMenuItem(editor, item, menuTarget)
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    setShowMenu(false)
    // 鼠标停在菜单项上(handle 之外),hover 态必须强制清零;
    // 否则 applyMenuItem 触发 selectionUpdate 把 handle 挪到新位置后,
    // 残留的 isHovered=true 会让新位置的 handle 误显 hover 背景。
    setIsHovered(false)
    // The transformed block may be at a different position; drop the pin
    // so the next selectionUpdate can re-pin to the new block.
    unpinBlock(editor)
    setMenuTarget(null)
  }, [editor, menuTarget])

  const onDelete = useCallback(() => {
    deleteBlock(editor, menuTarget)
    // The menu receives focus while it is open. Restore ProseMirror focus
    // after the document transaction so the next Mod/Ctrl+Z is owned by the
    // body history rather than by the menu or another native field.
    editor.view.focus()
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    setShowMenu(false)
    // 同 onMenuItem: 鼠标在菜单项上(handle 外),hover 态强制清零。
    setIsHovered(false)
    // The deleted node is gone — drop the pin. The plugin's docChanged
    // handler additionally re-validates any stale pin position.
    unpinBlock(editor)
    setMenuTarget(null)
  }, [editor, menuTarget])
  const onImageAlign = useCallback((alignment: 'left' | 'center' | 'right') => {
    setImageAlignment(editor, alignment, menuTarget)
    menuOpenRef.current = false
    menuTargetRef.current = null
    menuAnchorRectRef.current = null
    setShowMenu(false)
    setIsHovered(false)
    unpinBlock(editor)
    setMenuTarget(null)
  }, [editor, menuTarget])
  const menuActions = useBlockMenuActions(
    onMenuItem,
    onDelete,
    menuTarget?.typeName,
    onImageAlign,
  )

  const openMenu = useCallback((anchorRect?: DOMRect) => {
    const info = interactionBlockInfoRef.current ?? getBlockInfoForInteraction(editor, state.blockInfo)
    if (!info) return

    // Set this synchronously. The AgentThreadCard composer can blur the outer
    // editor before React's post-commit effect runs.
    menuOpenRef.current = true
    menuTargetRef.current = info
    menuAnchorRectRef.current = anchorRect ?? containerRef.current?.getBoundingClientRect() ?? null
    setMenuTarget(info)
    interactionBlockInfoRef.current = null
    activateAgentThreadCard(editor, info)
    pinBlock(editor, info)
    setMenuPosition(null)
    setIsHovered(false)
    setSelectedIndex(0)
    setMenuInputMode('mouse')
    setShowMenu(true)
  }, [editor, interactionBlockInfoRef, state.blockInfo])
  openMenuRef.current = openMenu

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

  return (
    <>
      <div
        ref={containerRef}
        data-editor-preserve-focus-on-pointerdown="true"
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
          zIndex: 1,
          background: showMenu ? 'var(--brand)' : (isHovered ? 'var(--muted)' : 'transparent'),
          color: showMenu ? 'var(--primary-foreground)' : 'var(--brand)',
          borderRadius: '4px',
          cursor: isDragging ? 'grabbing' : 'pointer',
          touchAction: 'none',
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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
      >
        {renderDragIcon(state.blockInfo)}
      </div>
      {showMenu && typeof document !== 'undefined' && createPortal(
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
        />,
        document.body,
      )}
    </>
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
