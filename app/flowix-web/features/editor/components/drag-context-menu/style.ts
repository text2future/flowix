import type { CurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'

/**
 * Y offset from block top edge, in px. Computed dynamically from the user's
 * font size / line height settings so the handle stays aligned when those
 * change. At the default `fontSize=15, lineHeight=1.6` the formulas reproduce
 * the original hand-tuned values (paragraph: 3, h1: 5, h2/h3: 3, h4: 2,
 * codeBlock: 2) and scale linearly with user settings otherwise.
 *
 * Reading guide:
 *   - Text-bearing blocks (paragraph / blockquote / list / table / hr /
 *     frontmatter) use `(lineHeight - handle) / 2` — handle centered on the
 *     first line. Tuned to within 1px of the formula historically.
 *   - codeBlock has `font-size: 0.85em` (see editor.css) — the formula uses
 *     that smaller line-height so the handle is centered on the actual
 *     rendered line, not the body line.
 *   - Headings h1–h4 have a hard-coded `line-height: 1.3` plus per-level
 *     rem-based font-size. We use a "near top" ratio (~10–14% of the
 *     heading's line-box) so the handle reads as anchored to the heading,
 *     not to its first line's center (which would float too far down on
 *     large h1s).
 *   - Heading h5/h6 inherit body fontSize with no rem override and
 *     visually feel like body text, so they use the centered formula.
 *   - Atom blocks (image / video / file / datetime)
 *     don't follow line-height — fixed 5px from the top of the node.
 *
 * Edit visually — these are derived from CSS variables. If the CSS
 * constants (0.85em codeblock, 1.3 heading line-height, h1–h4 rem sizes)
 * change in `css/editor.css`, update the mirrors below.
 * ───────────────────────────────────────────────────────────────────── */

/** Width/height of the drag handle — single source of truth. */
export const HANDLE_SIZE = 18

/** codeBlock 在 editor.css 里声明 `font-size: 0.85em`, 居中时按 em 缩放。 */
const CODE_BLOCK_FONT_SIZE_EM = 0.85

/** 标题的 line-height 在 editor.css 里硬编码为 1.3。 */
const HEADING_LINE_HEIGHT = 1.3

/**
 * 标题字号 — 走 `calc(Nrem * var(--editor-scale))`, 而
 * `--editor-scale = var(--app-font-size, 15px) / 16px`, 两者相消后
 * 渲染字号 = `fontSize × N` px。h5/h6 没有显式声明, 走 fallback `1`
 * (即继承 body 字号), 在 getYOffset 里会落到 body 居中分支。
 */
const HEADING_FONT_SIZE_REM: Record<number, number> = {
  1: 1.9,
  2: 1.4,
  3: 1.15,
  4: 1.05,
}

/**
 * 标题的 "near top" 视觉比例: 复现默认 15px 字号下的 5/3/3/2 偏移
 * (即原 hand-tune 值), 随用户调整 fontSize 等比缩放。
 *   5 / (15 * 1.9  * 1.3) ≈ 0.135
 *   3 / (15 * 1.4  * 1.3) ≈ 0.110
 *   3 / (15 * 1.15 * 1.3) ≈ 0.134
 *   2 / (15 * 1.05 * 1.3) ≈ 0.098
 */
const HEADING_NEAR_TOP_RATIO: Record<number, number> = {
  1: 0.135,
  2: 0.110,
  3: 0.134,
  4: 0.098,
}

/** 原子块 — 与字号 / 行高无关, 固定 5px 顶部偏移 (节点自带的内禀尺寸决定)。 */
const ATOM_Y_OFFSET: Record<string, number> = {
  image: 5,
  videoAttachment: 5,
  fileAttachment: 5,
  datetimeWidget: 5,
}
const ATOM_FALLBACK = 5

/**
 * Compute the Y offset to add to a block's top edge to position the
 * `HANDLE_SIZE × HANDLE_SIZE` drag handle.
 *
 * Inputs are clamped: `fontSize ≥ 1`, `lineHeight ≥ 0.1`. The result is
 * clamped to `≥ 0` so degenerate settings (e.g. fontSize=12, lineHeight=1.0
 * gives `pxLineHeight < HANDLE_SIZE`) put the handle flush at the block
 * top rather than producing a negative offset.
 */
export function getYOffset(
  info: CurrentBlockInfo,
  fontSize: number,
  lineHeight: number,
): number {
  // slider 在边界附近可能产 NaN / 0, 提前 clamp 让公式对 0 字号仍返回合理值,
  // 而不是依赖末尾 Math.max(0, ...) 把"用户配错"的信号吞掉。
  const safeFontSize = Math.max(1, fontSize)
  const safeLineHeight = Math.max(0.1, lineHeight)

  if (info.typeName === 'heading') {
    const level = info.attrs.level
    // h1–h4 走 near-top; h5/h6 没有显式 rem, 落到下面的 body 居中分支。
    if (typeof level === 'number' && level in HEADING_FONT_SIZE_REM) {
      const rem = HEADING_FONT_SIZE_REM[level]
      const ratio = HEADING_NEAR_TOP_RATIO[level]
      return Math.max(0, safeFontSize * rem * HEADING_LINE_HEIGHT * ratio)
    }
  }

  if (info.node.isLeaf) {
    return ATOM_Y_OFFSET[info.typeName] ?? ATOM_FALLBACK
  }

  const pxLineHeight =
    info.typeName === 'codeBlock'
      ? safeFontSize * CODE_BLOCK_FONT_SIZE_EM * safeLineHeight
      : safeFontSize * safeLineHeight
  return Math.max(0, (pxLineHeight - HANDLE_SIZE) / 2)
}
