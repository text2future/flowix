import type { ReactNode } from 'react'
import { TextHOneIcon, TextHTwoIcon, TextHThreeIcon, TextHFourIcon, TextTIcon, ListBulletsIcon, ListNumbersIcon, CheckSquareIcon } from '@phosphor-icons/react'

/**
 * Menu items for the drag handle popover. Kept as data (not inline JSX in
 * the component) so:
 *   - the component file focuses on UI lifecycle (positioning, click, focus)
 *   - the items list is the single source of truth for what the menu offers
 *   - adding / removing items is a one-line data change, no JSX churn
 *
 * The discriminated union (`kind`) lets the call site narrow without
 * `'field' in item` checks.
 */

export type BlockMenuItem =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; icon: ReactNode; display: string; shortcut: string }
  | { kind: 'paragraph'; icon: ReactNode; display: string; shortcut: string }
  | { kind: 'list'; listType: 'bulletList' | 'orderedList' | 'taskList'; icon: ReactNode; display: string; shortcut: string }

export type ListMenuItem = Extract<BlockMenuItem, { kind: 'list' }>

const ICON_PROPS = { size: 16, weight: 'bold' as const }

export const headingMenuItems: BlockMenuItem[] = [
  { kind: 'heading', level: 1, icon: <TextHOneIcon {...ICON_PROPS} />, display: '#', shortcut: 'Mod+1' },
  { kind: 'heading', level: 2, icon: <TextHTwoIcon {...ICON_PROPS} />, display: '##', shortcut: 'Mod+2' },
  { kind: 'heading', level: 3, icon: <TextHThreeIcon {...ICON_PROPS} />, display: '###', shortcut: 'Mod+3' },
  { kind: 'heading', level: 4, icon: <TextHFourIcon {...ICON_PROPS} />, display: '####', shortcut: 'Mod+4' },
  { kind: 'paragraph', icon: <TextTIcon {...ICON_PROPS} />, display: '正文', shortcut: 'Mod+0' },
]

export const listMenuItems: ListMenuItem[] = [
  // 快捷键与 actions.ts 里的 defaultBinding 保持一致: Mod+Alt+8/7/9
  // (不是 Notion/Tiptap 默认的 Mod+Shift, 后者会与 Tiptap 内置 keymap 双 toggle 抵消)。
  { kind: 'list', listType: 'bulletList', icon: <ListBulletsIcon {...ICON_PROPS} />, display: '无序列表', shortcut: 'Mod+Alt+8' },
  { kind: 'list', listType: 'orderedList', icon: <ListNumbersIcon {...ICON_PROPS} />, display: '有序列表', shortcut: 'Mod+Alt+7' },
  { kind: 'list', listType: 'taskList', icon: <CheckSquareIcon {...ICON_PROPS} />, display: '待办列表', shortcut: 'Mod+Alt+9' },
]
