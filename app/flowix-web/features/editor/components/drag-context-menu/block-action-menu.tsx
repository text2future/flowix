import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { CaretRight } from '@phosphor-icons/react'
import { Kbd } from '@shared/ui/shortcut-kbd'
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator'
import { useSelectedItemScroll } from '@features/editor/extensions/shared/use-selected-item-scroll'
import type { BlockMenuAction } from '@features/editor/components/drag-context-menu/block-menu-actions'

interface BlockActionMenuProps {
  actions: BlockMenuAction[]
  selectedIndex: number
  mouseHoverEnabled: boolean
  menuRef: (node: HTMLDivElement | null) => void
  style: CSSProperties
  onHover: (index: number) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  ariaLabel?: string
}

/**
 * A submenu opens flush against the hovered row's trailing edge, with its first
 * row level with that row. `VIEWPORT_MARGIN` keeps a flipped or clamped panel on
 * screen in narrow panes.
 */
const VIEWPORT_MARGIN = 8
/** Delay before a hover-open submenu closes, so the pointer can traverse the gap. */
const SUBMENU_CLOSE_DELAY = 120

export function BlockActionMenu({
  actions,
  selectedIndex,
  mouseHoverEnabled,
  menuRef,
  style,
  onHover,
  onKeyDown,
  ariaLabel = 'Block actions',
}: BlockActionMenuProps) {
  const { scrollerRef, itemRefs } = useSelectedItemScroll({
    items: actions,
    selectedIndex,
  })
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null)
  const menuElementRef = useRef<HTMLDivElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const cancelPendingClose = useCallback(() => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const closeSubmenu = useCallback(() => {
    cancelPendingClose()
    setOpenSubmenuIndex(null)
  }, [cancelPendingClose])

  /**
   * Closing on a timeout (rather than immediately) is what lets the pointer
   * cross the offset gap between parent and submenu without the submenu
   * unmounting underneath it.
   */
  const scheduleSubmenuClose = useCallback(() => {
    cancelPendingClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpenSubmenuIndex(null)
    }, SUBMENU_CLOSE_DELAY)
  }, [cancelPendingClose])

  useEffect(() => cancelPendingClose, [cancelPendingClose])

  // The action list can be swapped while the menu stays mounted; a stale index
  // would leave the submenu anchored to an unrelated row.
  useEffect(() => {
    setOpenSubmenuIndex(null)
  }, [actions])

  const assignMenuRef = useCallback((node: HTMLDivElement | null) => {
    menuElementRef.current = node
    menuRef(node)
  }, [menuRef])

  const handleItemMouseMove = (
    event: MouseEvent<HTMLButtonElement>,
    index: number,
    hasChildren: boolean,
  ) => {
    if (event.movementX === 0 && event.movementY === 0) return
    onHover(index)
    if (!mouseHoverEnabled) return
    if (hasChildren) {
      cancelPendingClose()
      setOpenSubmenuIndex(index)
    } else {
      scheduleSubmenuClose()
    }
  }

  const handleItemClick = (action: BlockMenuAction, hasChildren: boolean, index: number) => {
    // A parent row is both an action and a disclosure. Clicking runs its own
    // `onSelect` (which typically performs the row's default behaviour and
    // closes the menu); the panel itself is revealed by hover / ArrowRight, so
    // a stray click must not silently swallow the action.
    if (action.onSelect) action.onSelect()
    if (hasChildren && openSubmenuIndex !== index) {
      cancelPendingClose()
      setOpenSubmenuIndex(index)
    }
  }

  /**
   * ArrowRight / ArrowLeft drive submenu traversal in addition to the caller's
   * ArrowUp / ArrowDown / Enter handling. Returning true means consumed.
   */
  const handleSubmenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const active = actions[selectedIndex]
    const hasChildren = (active?.children?.length ?? 0) > 0

    if (event.key === 'ArrowRight' && hasChildren) {
      event.preventDefault()
      event.stopPropagation()
      cancelPendingClose()
      setOpenSubmenuIndex(selectedIndex)
      return true
    }

    if (event.key === 'ArrowLeft' && openSubmenuIndex !== null) {
      event.preventDefault()
      event.stopPropagation()
      closeSubmenu()
      return true
    }

    if (event.key === 'Escape' && openSubmenuIndex !== null) {
      // Close the submenu first; the next Escape closes the parent menu.
      event.preventDefault()
      event.stopPropagation()
      closeSubmenu()
      return true
    }

    return false
  }

  return (
    <div
      ref={assignMenuRef}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (handleSubmenuKeyDown(event)) return
        onKeyDown(event)
      }}
      onMouseLeave={scheduleSubmenuClose}
      className="fixed z-[150] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      style={{ ...style, outline: 'none' }}
    >
      <div ref={scrollerRef}>
        {actions.map((action, index) => {
          const children = action.children ?? []
          const hasChildren = children.length > 0
          const submenuOpen = hasChildren && openSubmenuIndex === index

          return (
            <Fragment key={action.id}>
              {index > 0 && actions[index - 1]?.group !== action.group && (
                <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
              )}
              <button
                ref={(node) => {
                  itemRefs.current[index] = node
                }}
                type="button"
                role={action.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={action.checked}
                aria-haspopup={hasChildren ? 'menu' : undefined}
                aria-expanded={hasChildren ? submenuOpen : undefined}
                onMouseMove={(event) => handleItemMouseMove(event, index, hasChildren)}
                onClick={() => handleItemClick(action, hasChildren, index)}
                className={`group relative flex h-7 min-h-7 w-full items-center justify-start gap-3 rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] transition-colors${mouseHoverEnabled ? ' hover:bg-[var(--hover-bg)]' : ''}${index === selectedIndex ? ' bg-[var(--hover-bg)] text-[var(--foreground)]' : ''}`}
                style={{ outline: 'none', boxShadow: 'none' }}
              >
                {action.icon}
                <span className="min-w-0 flex-1">{action.label}</span>
                {action.shortcut && (
                  <Kbd
                    chord={action.shortcut}
                    className={`shrink-0 ${index === selectedIndex ? 'text-[var(--muted-foreground)]' : 'text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]'}`}
                  />
                )}
                {action.trailingIcon && (
                  <span
                    className={`ml-auto shrink-0 ${index === selectedIndex ? 'text-[var(--foreground)]' : 'text-[var(--brand)] group-hover:text-[var(--foreground)]'}`}
                  >
                    {action.trailingIcon}
                  </span>
                )}
                {hasChildren && (
                  <CaretRight
                    size={12}
                    weight="bold"
                    aria-hidden="true"
                    className={`ml-auto shrink-0 ${index === selectedIndex ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]'}`}
                  />
                )}
              </button>
              {submenuOpen && (
                <SubmenuPanel
                  actions={children}
                  anchor={itemRefs.current[index] ?? null}
                  parentRef={menuElementRef.current}
                  panelRef={submenuRef}
                  onPointerEnter={cancelPendingClose}
                  onPointerLeave={scheduleSubmenuClose}
                  ariaLabel={`${action.label} ${ariaLabel}`}
                  groupLabel={action.childrenGroupLabel}
                />
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

interface SubmenuPanelProps {
  actions: BlockMenuAction[]
  anchor: HTMLButtonElement | null
  parentRef: HTMLDivElement | null
  panelRef: { current: HTMLDivElement | null }
  onPointerEnter: () => void
  onPointerLeave: () => void
  ariaLabel: string
  /** Optional heading rendered above the rows as a non-interactive group title. */
  groupLabel?: string
}

function SubmenuPanel({
  actions,
  anchor,
  parentRef,
  panelRef,
  onPointerEnter,
  onPointerLeave,
  ariaLabel,
  groupLabel,
}: SubmenuPanelProps) {
  const localRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Measure after mount so the panel can flip left / clamp vertically when the
  // hovered row sits near a viewport edge.
  useEffect(() => {
    const panel = localRef.current
    if (!panel || !anchor || !parentRef) return
    const anchorRect = anchor.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()

    // Flush against the hovered row's own trailing edge so the panel hugs the
    // item it belongs to. The row is inset by the menu's padding, so this lands
    // slightly inside the menu's border rather than on it.
    let left = anchorRect.right
    if (left + panelRect.width > window.innerWidth - VIEWPORT_MARGIN) {
      left = anchorRect.left - panelRect.width
    }
    left = Math.max(VIEWPORT_MARGIN, left)

    // The panel's own padding offsets its first row from its top edge, so
    // align tops using that inset to make the first submenu row sit level
    // with the hovered parent row.
    const panelPadding = Number.parseFloat(window.getComputedStyle(panel).paddingTop) || 0
    const maxTop = window.innerHeight - panelRect.height - VIEWPORT_MARGIN
    const preferredTop = anchorRect.top - panelPadding
    const top = Math.max(VIEWPORT_MARGIN, Math.min(preferredTop, maxTop))

    setPosition({ left, top })
  }, [anchor, parentRef])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={(node) => {
        localRef.current = node
        panelRef.current = node
      }}
      role="menu"
      aria-label={ariaLabel}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onMouseDown={(event) => event.stopPropagation()}
      className="fixed z-[151] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      style={{
        left: position ? `${position.left}px` : '-9999px',
        top: position ? `${position.top}px` : '-9999px',
        minWidth: 160,
      }}
    >
      {groupLabel && (
        // Mirrors the slash menu's section header (`.slash-menu-header`, e.g.
        // the 智能体 group): same size, weight and colour, plus the 0.35rem
        // vertical rhythm so the heading breathes like the slash popup's.
        <div
          aria-hidden="true"
          className="flex items-center px-2 py-[0.35rem] text-xs leading-[1.2] text-[var(--muted-foreground)]"
        >
          {groupLabel}
        </div>
      )}
      {actions.map((action, index) => (
        <Fragment key={action.id}>
          {index > 0 && actions[index - 1]?.group !== action.group && (
            <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
          )}
          <button
            type="button"
            role={action.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={action.checked}
            disabled={action.disabled}
            aria-disabled={action.disabled}
            title={action.disabledReason}
            onClick={() => { if (!action.disabled) action.onSelect() }}
            // `gap-3` is applied only when a leading icon exists, otherwise an
            // absent icon would still indent the label.
            className={`group flex h-7 min-h-7 w-full items-center justify-start rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] transition-colors${action.disabled ? ' cursor-default opacity-40' : ' hover:bg-[var(--hover-bg)]'}${action.icon ? ' gap-3' : ''}`}
            style={{ outline: 'none', boxShadow: 'none' }}
          >
            {action.icon}
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
            {action.checked && (
                <span className="ml-auto shrink-0 text-[var(--brand)] group-hover:text-[var(--foreground)]">
                {action.trailingIcon}
              </span>
            )}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  )
}
