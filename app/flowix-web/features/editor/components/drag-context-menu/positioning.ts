import type { Editor } from '@tiptap/core'
import {
  getBlockInfoForInteraction,
  getFocusedAgentThreadCardInfo,
  type CurrentBlockInfo,
} from '@features/editor/components/drag-context-menu/block-info'
import { getYOffset } from '@features/editor/components/drag-context-menu/style'

/**
 * Geometry: where should the drag handle sit on screen for the editor's
 * current selection? Pure function of editor state + DOM rects.
 *
 * The X axis is fixed (18px from the proseMirror container's left edge).
 * For headings and paragraphs, the Y axis follows ProseMirror's first
 * text-line coordinate so block padding is included. Other blocks retain the
 * visible-block-top plus per-type offset fallback (see ./style.ts).
 */

export interface HandlePosition {
  visible: true
  x: number
  y: number
  blockInfo: CurrentBlockInfo
}

export interface HandleHidden {
  visible: false
}

// Visible block ancestor selector. List items are handled explicitly below;
// the selector remains the fallback for ordinary blocks.
// `.ProseMirror-node` is the catch-all for node-view wrappers.
const BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, ul, ol, table, .tableWrapper, blockquote, pre, .code-block-wrapper, .ProseMirror-node'

const HANDLE_X_OFFSET = 18

/** Small visual nudge for the larger heading glyphs. */
const HEADING_HANDLE_NUDGE: Record<number, number> = {
  1: 4,
  2: 3,
  3: 2,
}

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
  requireFocus = true,
  preferredInfo?: CurrentBlockInfo | null,
): HandlePosition | HandleHidden | null {
  const view = editor.view
  if (!view) return null

  // AgentThreadCard owns a nested ProseMirror composer. The outer editor is
  // intentionally blurred while the composer is active, but the card still
  // needs its block handle for moving the card itself.
  const focusedAgentThreadCard = getFocusedAgentThreadCardInfo(editor)
  if (requireFocus && !view.hasFocus() && !focusedAgentThreadCard && !preferredInfo) return null

  const editorDom = view.dom as HTMLElement
  const editorContent = editorDom.closest('.editor-content') as HTMLElement | null
  const info = preferredInfo ?? focusedAgentThreadCard ?? getBlockInfoForInteraction(editor)
  if (!info || !editorContent) return null

  // Anchor the handle on the visible block element. Table node DOM may be the
  // table itself or Tiptap's `.tableWrapper`; list item node DOM is the
  // rendered <li>. Resolve these before falling back to generic block ancestors.
  const domNode = getVisibleBlockElement(info)
  if (!domNode) return null

  const proseMirrorRect = view.dom.getBoundingClientRect()
  const contentRect = editorContent.getBoundingClientRect()
  const nodeRect = domNode.getBoundingClientRect()

  // The handle is absolutely positioned inside `.editor-content`, so both
  // axes must be expressed in that scroll container's content coordinates.
  // In particular, subtracting ProseMirror's top loses the height of any
  // non-ProseMirror header (the memo title) and shifts every handle upward.
  const x = nodeContentX(proseMirrorRect.left, contentRect.left, editorContent.scrollLeft)
  const y = textBlockContentY(view, info, contentRect.top, editorContent.scrollTop) ??
    nodeContentY(
      nodeRect.top,
      contentRect.top,
      editorContent.scrollTop,
      getYOffset(info, fontSize, lineHeight),
    )

  return { visible: true, x, y, blockInfo: info }
}

export function nodeContentX(
  proseMirrorLeft: number,
  scrollContainerLeft: number,
  scrollLeft: number,
): number {
  return proseMirrorLeft - scrollContainerLeft + scrollLeft + HANDLE_X_OFFSET
}

export function nodeContentY(
  nodeTop: number,
  scrollContainerTop: number,
  scrollTop: number,
  visualOffset: number,
): number {
  return nodeTop - scrollContainerTop + scrollTop + visualOffset
}

/**
 * Resolve the first rendered text-line top for headings and paragraphs in the
 * same content coordinate system as the absolutely-positioned handle.
 *
 * `EditorView.coordsAtPos` includes the browser's actual block padding, font
 * metrics and line-height. Keeping this measurement in the DOM/PM layout layer
 * avoids duplicating CSS spacing in TypeScript. Headings retain their small
 * visual nudge; paragraphs align directly to the measured text line. Empty
 * blocks still have a valid position (`info.pos + 1`), while malformed or
 * stale selections are handled by returning null and using the normal
 * block-top fallback.
 */
export function textBlockContentY(
  view: Editor['view'],
  info: CurrentBlockInfo,
  scrollContainerTop: number,
  scrollTop: number,
): number | null {
  if (info.typeName !== 'heading' && info.typeName !== 'paragraph') return null

  try {
    const textCoords = view.coordsAtPos(info.pos + 1)
    const level = info.typeName === 'heading' ? info.attrs.level : null
    const nudge = typeof level === 'number' ? HEADING_HANDLE_NUDGE[level] ?? 0 : 0
    return textCoords.top - scrollContainerTop + scrollTop + nudge
  } catch {
    // The view can be destroyed between selectionUpdate and the RAF callback.
    return null
  }
}

function getVisibleBlockElement(info: CurrentBlockInfo): HTMLElement | null {
  if (info.typeName === 'image' || info.typeName === 'videoAttachment') return info.dom
  if (info.typeName === 'agentThreadCard') return info.dom

  if (info.typeName === 'table') {
    if (info.dom.matches('table, .tableWrapper')) return info.dom
    const table = info.dom.querySelector('table')
    if (table instanceof HTMLElement) return table
  }
  if (info.typeName === 'listItem' || info.typeName === 'taskItem') {
    if (info.dom.matches('li')) return info.dom
    const item = info.dom.querySelector('li')
    if (item instanceof HTMLElement) return item
  }
  if (info.typeName === 'codeBlock') {
    if (info.dom.classList.contains('code-block-wrapper')) return info.dom
    const wrapper = info.dom.closest('.code-block-wrapper')
    if (wrapper instanceof HTMLElement) return wrapper
  }
  return info.dom.closest?.(BLOCK_SELECTOR) as HTMLElement | null
}
