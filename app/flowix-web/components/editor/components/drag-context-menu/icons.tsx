import type { ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import {
  TextHOneIcon,
  TextHTwoIcon,
  TextHThreeIcon,
  TextHFourIcon,
} from '@phosphor-icons/react'
import { getCurrentBlockInfo } from './block-info'

/**
 * Handle's icon. Pure render-time derivation from
 * `editor.view.state.selection` — no extra React state needed, since
 * the parent component already re-renders on every selectionUpdate
 * (position update) and the icon is just another view of that same state.
 */

const HEADING_ICONS = {
  1: TextHOneIcon,
  2: TextHTwoIcon,
  3: TextHThreeIcon,
  4: TextHFourIcon,
} as const

type HeadingLevel = keyof typeof HEADING_ICONS

/** Default grip glyph used for every non-heading block. */
export function DefaultDragIcon() {
  return (
    <svg
      width="12"
      height="13"
      viewBox="0 0 12 15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="1" y="1" width="10" height="1.8" rx="0.75" fill="currentColor" />
      <rect x="4" y="6" width="6" height="1.8" rx="0.75" fill="currentColor" />
      <rect x="2" y="11" width="9" height="1.8" rx="0.75" fill="currentColor" />
    </svg>
  )
}

/** H1–H4 Phosphor icon when the cursor sits in a matching heading,
 *  otherwise the default grip glyph. */
export function renderDragIcon(editor: Editor): ReactNode {
  const info = getCurrentBlockInfo(editor)
  if (info?.typeName === 'heading') {
    const level = info.attrs.level
    if (level === 1 || level === 2 || level === 3 || level === 4) {
      const Icon = HEADING_ICONS[level as HeadingLevel]
      return <Icon size={16} weight="bold" />
    }
  }
  return <DefaultDragIcon />
}