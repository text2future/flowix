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
      className="fixed z-[1500] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg p-1"
      style={{ ...style, outline: 'none' }}
    >
      <div ref={scrollerRef}>
        {actions.map((action, index) => {
          const isDanger = action.group === 'danger'
          return (
            <Fragment key={action.id}>
              {index > 0 && actions[index - 1]?.group !== action.group && (
                <hr className="my-1 mx-2 border-t border-[var(--divider)]" />
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
                className={`relative flex items-center w-full px-3 py-1.5 text-sm cursor-pointer active:bg-[var(--accent)] text-left rounded text-[var(--foreground)]${mouseHoverEnabled ? ' hover:bg-[var(--muted)]' : ''}${index === selectedIndex ? ' bg-[var(--muted)]' : ''}${isDanger && mouseHoverEnabled ? ' hover:text-[var(--destructive)]' : ''}`}
                style={{ gap: 12, outline: 'none', boxShadow: 'none' }}
              >
                {action.icon}
                <span className="min-w-0 flex-1">{action.label}</span>
                {action.shortcut && (
                  <Kbd
                    chord={action.shortcut}
                    className="shrink-0 text-[var(--muted-foreground)]"
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
