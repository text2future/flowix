import type { Editor } from '@tiptap/core'
import { getCurrentBlockInfo } from './block-info'
import { getYOffset } from './style'

/**
 * Geometry: where should the drag handle sit on screen for the editor's
 * current selection? Pure function of editor state + DOM rects.
 *
 * The X axis is fixed (18px from the proseMirror container's left edge).
 * The Y axis follows the visible block ancestor's top, plus a per-type
 * Y offset (see ./style.ts).
 */

export interface HandlePosition {
  visible: true
  x: number
  y: number
}

export interface HandleHidden {
  visible: false
}

// Visible block ancestor selector. The handle positions itself on the
// outermost "block" the user reads as a unit (the whole <ul>/<ol> for a
// listItem cursor, the <td> for a tableCell, the <p> for a paragraph).
// `.ProseMirror-node` is the catch-all for node-view wrappers.
const BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, .ProseMirror-node'

const HANDLE_X_OFFSET = 18

/** Resolve the current handle position. Returns `{ visible: false }` when
 *  the editor has no usable focus / no resolvable block (callers typically
 *  use this to hide the handle entirely).
 *
 *  `fontSize` and `lineHeight` come from the user settings (Preferences →
 *  Format) and feed into `getYOffset` so the handle stays aligned with the
 *  first line of text when the user changes typography. They are passed
 *  in (not read from CSS variables) so the caller controls re-positioning
 *  via React effect deps. */
export function computeHandlePosition(
  editor: Editor,
  fontSize: number,
  lineHeight: number,
): HandlePosition | HandleHidden | null {
  const view = editor.view
  if (!view?.hasFocus()) return null

  const editorDom = view.dom as HTMLElement
  const editorContent = editorDom.closest('.editor-content') as HTMLElement | null
  const info = getCurrentBlockInfo(editor)
  if (!info || !editorContent) return null

  // Anchor the handle on the visible block ancestor (e.g. the
  // <ul>/<ol> for a listItem, the <td> for a tableCell).
  const domNode = info.dom.closest?.(BLOCK_SELECTOR) as HTMLElement | null
  if (!domNode) return null

  const proseMirrorRect = view.dom.getBoundingClientRect()
  const contentRect = editorContent.getBoundingClientRect()
  const nodeRect = domNode.getBoundingClientRect()

  // X: fixed offset from proseMirror left edge. Use proseMirrorRect
  // (.markdown-editor container) as the X reference — contentRect
  // (.editor-content inner div) scrolls internally, so its viewport-
  // relative top moves around and breaks Y if used as reference.
  const x = (proseMirrorRect.left - contentRect.left) + HANDLE_X_OFFSET
  const y = nodeRect.top - proseMirrorRect.top + getYOffset(info, fontSize, lineHeight)

  return { visible: true, x, y }
}