import { Fragment, useEffect, useState, useRef, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import { TrashSimpleIcon } from '@phosphor-icons/react'
import { Kbd } from '../../../ui/kbd'
import { getCurrentBlockInfo, selectBlockContent } from './block-info'
import {
  applyMenuItem,
  deleteBlock,
  pinBlock,
  unpinBlock,
} from './actions'
import { renderDragIcon } from './icons'
import {
  headingMenuItems,
  listMenuItems,
  type BlockMenuItem,
} from './items'
import { computeHandlePosition } from './positioning'
import { HANDLE_SIZE } from './style'
import { useUserSettingsStore } from '../../../../lib/store/user-settings-store'

interface DragContextMenuProps {
  editor: Editor
}

interface DragHandleState {
  visible: boolean
  x: number
  y: number
}

const MENU_MIN_SPACE = 300

export function DragContextMenu({ editor }: DragContextMenuProps) {
  // 字体/行高 (Preferences → Format) — 走窄 selector, 只在这两值变化时
  // 重渲染, 避免 theme / personalize / shortcuts 改动把整个组件拉一遍。
  // 这两个值进 useEffect deps, slider 拖动时 handle 跟着重新锚定。
  const fontSize = useUserSettingsStore((s) => s.settings.format.fontSize)
  const lineHeight = useUserSettingsStore((s) => s.settings.format.lineHeight)

  const [state, setState] = useState<DragHandleState>({
    visible: false,
    x: 0,
    y: 0,
  })
  const [showMenu, setShowMenu] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [menuPosition, setMenuPosition] = useState<'bottom' | 'top'>('bottom')
  const containerRef = useRef<HTMLDivElement>(null)
  const ignoreBlur = useRef(false)

  // Track the editor: re-anchor the handle on every selectionUpdate, focus,
  // scroll, and (debounced) resize. Hide on blur unless the user is mid-click.
  useEffect(() => {
    if (!editor?.view?.dom) return

    let mounted = true
    let rafId: number | null = null
    let frameSkip = 0

    const updateDragHandle = () => {
      if (!mounted) return
      const pos = computeHandlePosition(editor, fontSize, lineHeight)
      if (!pos || !pos.visible) {
        setState(prev => ({ ...prev, visible: false }))
        return
      }
      setState({ visible: true, x: pos.x, y: pos.y })
    }

    const handleScroll = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        updateDragHandle()
      })
    }

    const handleBlur = () => {
      if (!ignoreBlur.current) {
        setState(prev => ({ ...prev, visible: false }))
        // Editor lost focus: the menu's target is no longer actionable,
        // so drop the pin to keep the visual honest.
        unpinBlock(editor)
      }
    }

    editor.on('selectionUpdate', updateDragHandle)
    editor.on('focus', updateDragHandle)
    editor.on('blur', handleBlur)

    const editorDom = editor.view.dom as HTMLElement
    const scrollContainer = editorDom.closest('.markdown-editor') as HTMLElement
    const scrollTarget = scrollContainer || editorDom
    scrollTarget.addEventListener('scroll', handleScroll, { passive: true })

    // 3-frame skip keeps the resize handler light — the editor rarely
    // changes size, so a low-frequency update is enough to keep the
    // handle in sync without pegging the main thread.
    const resizeObserver = new ResizeObserver(() => {
      if (rafId) return
      frameSkip++
      if (frameSkip % 3 !== 0) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        updateDragHandle()
      })
    })
    resizeObserver.observe(scrollContainer || editorDom)

    return () => {
      mounted = false
      if (rafId) cancelAnimationFrame(rafId)
      editor.off('selectionUpdate', updateDragHandle)
      editor.off('focus', updateDragHandle)
      editor.off('blur', handleBlur)
      scrollTarget.removeEventListener('scroll', handleScroll)
      resizeObserver.disconnect()
    }
  }, [editor, fontSize, lineHeight])

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

  const onMenuItem = (item: BlockMenuItem) => {
    applyMenuItem(editor, item)
    setShowMenu(false)
    // 鼠标停在菜单项上(handle 之外),hover 态必须强制清零;
    // 否则 applyMenuItem 触发 selectionUpdate 把 handle 挪到新位置后,
    // 残留的 isHovered=true 会让新位置的 handle 误显 hover 背景。
    setIsHovered(false)
    // The transformed block may be at a different position; drop the pin
    // so the next selectionUpdate can re-pin to the new block.
    unpinBlock(editor)
  }

  const onDelete = () => {
    deleteBlock(editor)
    setShowMenu(false)
    // 同 onMenuItem: 鼠标在菜单项上(handle 外),hover 态强制清零。
    setIsHovered(false)
    // The deleted node is gone — drop the pin. The plugin's docChanged
    // handler additionally re-validates any stale pin position.
    unpinBlock(editor)
  }

  return (
    <div
      ref={containerRef}
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
        zIndex: 1000,
        background: showMenu ? 'var(--brand)' : (isHovered ? 'var(--muted)' : 'transparent'),
        color: showMenu ? 'var(--primary-foreground)' : 'var(--brand)',
        borderRadius: '4px',
        cursor: 'pointer',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={(e) => {
        ignoreBlur.current = true
        if (showMenu) {
          e.preventDefault()
        }
      }}
      onClick={() => {
        if (!showMenu && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect()
          const spaceBelow = window.innerHeight - rect.bottom
          setMenuPosition(spaceBelow > MENU_MIN_SPACE ? 'bottom' : 'top')
        }
        const nextOpen = !showMenu
        if (nextOpen) {
          const info = getCurrentBlockInfo(editor)
          if (info) {
            // 1) Real editor selection (TextSelection / NodeSelection) →
            //    browser-native ::selection styles apply.
            selectBlockContent(editor)
            // 2) Plugin-driven decoration (left accent bar + block tint)
            //    via the menu-pin plugin → rendered by PM view pipeline.
            pinBlock(editor, info.pos)
          }
        } else {
          unpinBlock(editor)
        }
        // 菜单打开 / 关闭的同一帧内,hover 态无条件清零。
        // 打开时背景切到 var(--brand) 不读 isHovered,所以清零无副作用。
        // 关闭时鼠标虽然还在 handle 上,但只要用户一动鼠标 onMouseEnter
        // 会自然把 hover 态打回 true — 而不主动恢复可以避免
        // "脏 hover=true 跟着 showMenu 一起走"在 handle 移到新块时
        // 把 hover 背景粘到新位置上。
        setIsHovered(false)
        setShowMenu(nextOpen)
        // Clear the ignoreBlur flag at the end of the click handler.
        // Any blur event triggered by this click's focus changes has
        // already fired (they're synchronous with the focus change),
        // so it saw ignoreBlur=true. Subsequent blur events — from the
        // user clicking elsewhere — should be honored.
        ignoreBlur.current = false
      }}
    >
      {renderDragIcon(editor)}
      {showMenu && (
        <div
          className="absolute z-50 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg p-1"
          style={{
            left: '100%',
            top: menuPosition === 'bottom' ? 0 : 'auto',
            bottom: menuPosition === 'top' ? 0 : 'auto',
            marginLeft: 8,
            minWidth: 180,
          }}
        >
          {headingMenuItems.map((item) => (
            <Fragment key={item.kind === 'heading' ? `h${item.level}` : 'paragraph'}>
              {renderMenuButton(item.icon, item.display, item.shortcut, () => onMenuItem(item))}
            </Fragment>
          ))}
          <hr className="my-1 mx-2 border-t border-[var(--divider)]" />
          {listMenuItems.map((item) => (
            <Fragment key={item.listType}>
              {renderMenuButton(item.icon, item.display, item.shortcut, () => onMenuItem(item))}
            </Fragment>
          ))}
          <hr className="my-1 mx-2 border-t border-[var(--divider)]" />
          {renderMenuButton(<TrashSimpleIcon size={16} weight="bold" />, '删除', undefined, onDelete)}
        </div>
      )}
    </div>
  )
}

function renderMenuButton(
  icon: ReactNode,
  label: string,
  shortcut: string | undefined,
  onClick: () => void,
) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="relative flex items-center w-full px-3 py-1.5 text-sm cursor-pointer active:bg-[var(--accent)] text-left rounded"
      style={{ gap: 12, color: 'var(--foreground)' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--muted)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {icon}
      <span>{label}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </button>
  )
}