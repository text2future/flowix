import { useMemo, type ReactNode } from 'react'
import { TrashSimpleIcon } from '@phosphor-icons/react'
import {
  headingMenuItems,
  listMenuItems,
  type BlockMenuItem,
} from '@features/editor/components/drag-context-menu/items'

export type BlockMenuActionGroup = 'heading' | 'list' | 'danger'

export interface BlockMenuAction {
  id: string
  group: BlockMenuActionGroup
  icon: ReactNode
  label: string
  shortcut?: string
  onSelect: () => void
}

export function useBlockMenuActions(
  onMenuItem: (item: BlockMenuItem) => void,
  onDelete: () => void,
): BlockMenuAction[] {
  return useMemo(() => [
    ...headingMenuItems.map((item): BlockMenuAction => ({
      id: item.kind === 'heading' ? `h${item.level}` : 'paragraph',
      group: 'heading',
      icon: item.icon,
      label: item.display,
      shortcut: item.shortcut,
      onSelect: () => onMenuItem(item),
    })),
    ...listMenuItems.map((item): BlockMenuAction => ({
      id: item.listType,
      group: 'list',
      icon: item.icon,
      label: item.display,
      shortcut: item.shortcut,
      onSelect: () => onMenuItem(item),
    })),
    {
      id: 'delete',
      group: 'danger',
      icon: <TrashSimpleIcon size={16} weight="bold" />,
      label: '删除',
      onSelect: onDelete,
    },
  ], [onMenuItem, onDelete])
}
