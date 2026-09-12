import { Fragment, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { Kbd } from '@shared/ui/shortcut-kbd'
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
}

export function BlockActionMenu({
  actions,
  selectedIndex,
  mouseHoverEnabled,
  menuRef,
  style,
  onHover,
  onKeyDown,
}: BlockActionMenuProps) {
  const { scrollerRef, itemRefs } = useSelectedItemScroll({
    items: actions,
    selectedIndex,
  })

  const handleItemMouseMove = (
    event: MouseEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.movementX === 0 && event.movementY === 0) return
    onHover(index)
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Block actions"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-[150] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      style={{ ...style, outline: 'none' }}
    >
      <div ref={scrollerRef}>
        {actions.map((action, index) => {
          return (
            <Fragment key={action.id}>
              {index > 0 && actions[index - 1]?.group !== action.group && (
                <hr className="mx-2 my-1 border-t border-[var(--border-popup)] opacity-60" />
              )}
              <button
                ref={(node) => {
                  itemRefs.current[index] = node
                }}
                type="button"
                role="menuitem"
                onMouseMove={(event) => handleItemMouseMove(event, index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  action.onSelect()
                }}
                className={`group relative flex h-7 min-h-7 w-full items-center justify-start gap-3 rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] transition-colors${mouseHoverEnabled ? ' hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]' : ''}${index === selectedIndex ? ' bg-[var(--brand)] text-[var(--primary-foreground)]' : ''}`}
                style={{ outline: 'none', boxShadow: 'none' }}
              >
                {action.icon}
                <span className="min-w-0 flex-1">{action.label}</span>
                {action.shortcut && (
                  <Kbd
                    chord={action.shortcut}
                    className={`shrink-0 ${index === selectedIndex ? 'text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]'}`}
                  />
                )}
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
