import type { TableBorderStyle, TableStyleId } from './table-presentation';

export function TableAlignmentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h18" />
      <path d="M3 12h18" />
      <path d="M11 19h10" />
    </svg>
  );
}

export function TableBackgroundIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18.992 12H2.041" />
      <path d="M21.145 18.38A3.34 3.34 0 0 1 20 16.5a3.3 3.3 0 0 1-1.145 1.88c-.575.46-.855 1.02-.855 1.595A2 2 0 0 0 20 22a2 2 0 0 0 2-2.025c0-.58-.285-1.13-.855-1.595" />
      <path d="m8.5 4.5 2.148-2.148a1.205 1.205 0 0 1 1.704 0l7.296 7.296a1.205 1.205 0 0 1 0 1.704l-7.592 7.592a3.615 3.615 0 0 1-5.112 0l-3.888-3.888a3.615 3.615 0 0 1 0-5.112L5.67 7.33" />
    </svg>
  );
}

/**
 * 表格 bubble 里所有图标统一 16×16 占位。主题缩略图的内容是 4:3 (32×24),
 * 用 preserveAspectRatio 等比缩到 16×12 居中, 不拉伸成变形的方表; 笔画略
 * 调粗补偿缩小后的视觉损失。触发按钮与菜单项共用同一尺寸。
 */
export function TableStyleIcon({ styleId }: { styleId: TableStyleId }) {
  return (
    <svg className="shrink-0" viewBox="0 0 32 24" width={16} height={16}
      preserveAspectRatio="xMidYMid meet"
      fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {styleId === 'default' || styleId === 'literature' ? <>
        <rect x="3" y="3" width="26" height="18" rx={styleId === 'default' ? 1 : 0} />
        <path d="M3 9h26M3 15h26M13 3v18M21 3v18" />
        {styleId === 'literature' && <path d="M3 6h26M3 12h26M3 18h26" strokeOpacity="0.35" />}
      </> : <>
        <path d="M5 10h7M18 10h3M25 10h2M5 15h7M18 15h3M25 15h2M5 19h7M18 19h3M25 19h2" strokeOpacity="0.4" />
        {styleId === 'business-blue' && <><rect x="3" y="2" width="26" height="5" fill="currentColor" stroke="none" /><path d="M3 22h26" strokeWidth="3" strokeOpacity="0.3" /></>}
        {styleId === 'striped' && <><path d="M3 4h26M3 13h26M3 21h26" strokeWidth="5" strokeOpacity="0.18" /><path d="M3 7h26" /></>}
        {styleId === 'comparison' && <><rect x="16" y="3" width="7" height="19" fill="currentColor" fillOpacity="0.18" stroke="none" /><path d="M16 3h7M16 22h7M3 7h26" /></>}
        {styleId === 'financial-brief' && <path d="M3 3h26M3 7h26M3 17h26M3 21h26M3 23h26" />}
        {styleId === 'hk-financial' && <path d="M3 5h26M17 13h12M17 21h12M17 23h12" />}
        {styleId === 'three-line' && <><path d="M3 3h26M3 22h26" strokeWidth="2" /><path d="M3 7h26" /></>}
        {styleId === 'grouped' && <><path d="M3 3h26M3 22h26" /><path d="M3 7h26M3 17h26" strokeWidth="4" strokeOpacity="0.2" /></>}
        {styleId === 'minimal' && <path d="M3 7h26M3 13h26M3 18h26" strokeOpacity="0.45" strokeWidth="0.8" />}
      </>}
    </svg>
  );
}

/**
 * Border menu affordances. Same composition as lucide's
 * `square-dashed-top-solid` (24×24 / stroke-width 2 / dashed placeholder edges
 * + solid highlighted edge), but square-cornered: at the toolbar's 16×16 the
 * corner arcs crowd the second line of a double edge. Corners are short right
 * angle L strokes, never arcs.
 *
 * 双线的第二条线跟着目标边走 (上双线 y=3/6.5, 下双线 y=21/17.5), 两条都
 * 贯穿 x=3..21、端点对齐, 不是悬在方框内部的一条横线。全虚线 / 上实线 /
 * 下实线 / 双线是同一套几何的四个状态, 上下边框两组选项能一眼对照。
 *
 * 虚线段短、间距大 (段 2 / gap 4), 且四角与虚线统一 1/2 透明: 在 16×16 下
 * 不会被 round cap 糊成一条灰线, 与全强度的实线/双线拉开明显层次。
 */
const BORDER_ICON_SQUARE_CORNERS = 'M3 5V3h2M19 3h2v2M21 19v2h-2M5 21H3v-2';

const BORDER_ICON_DASHES = {
  top: 'M8 3h2M14 3h2',
  right: 'M21 8v2M21 14v2',
  bottom: 'M8 21h2M14 21h2',
  left: 'M3 8v2M3 14v2',
} as const;

const BORDER_ICON_LINES = {
  top: { solid: 'M3 3h18', double: 'M3 3h18M3 6.5h18' },
  bottom: { solid: 'M3 21h18', double: 'M3 21h18M3 17.5h18' },
} as const;

type BorderIconEdge = keyof typeof BORDER_ICON_LINES;

/** Dashes for every edge except the ones drawn as a solid / double line. */
function borderIconDashes(highlighted: readonly BorderIconEdge[] = []): string {
  const skip = new Set<string>(highlighted);
  return (['top', 'right', 'bottom', 'left'] as const)
    .filter(edge => !skip.has(edge))
    .map(edge => BORDER_ICON_DASHES[edge])
    .join('');
}

function BorderIconSvg({ dashes, lines, slash = false }: {
  dashes: string;
  lines?: string;
  /** 「无边框」= 全虚线上叠一道斜杠, 与「默认(模板决定)」的全虚线区分。 */
  slash?: boolean;
}) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={`${BORDER_ICON_SQUARE_CORNERS}${dashes}`} strokeOpacity="0.5" />
      {lines && <path d={lines} />}
      {slash && <path d="M8 16 16 8" strokeOpacity="0.8" />}
    </svg>
  );
}

/**
 * One option in the border menu: what `style` does to `edge`.
 * single → 上/下实线, double → 双线, auto → 全虚线, none → 全虚线 + 斜杠.
 */
export function TableBorderIcon({ edge, style = 'single' }: { edge: BorderIconEdge; style?: TableBorderStyle }) {
  const highlighted = style === 'single' || style === 'double' ? [edge] : [];
  const lines = style === 'single' ? BORDER_ICON_LINES[edge].solid
    : style === 'double' ? BORDER_ICON_LINES[edge].double
      : undefined;
  return <BorderIconSvg dashes={borderIconDashes(highlighted)} lines={lines} slash={style === 'none'} />;
}

/** Trigger icon for the border menu: 上实线 + 下实线, left/right stay dashed. */
export function TableBordersIcon() {
  return (
    <BorderIconSvg
      dashes={borderIconDashes(['top', 'bottom'])}
      lines={`${BORDER_ICON_LINES.top.solid}${BORDER_ICON_LINES.bottom.solid}`}
    />
  );
}

/**
 * Trigger icon for the row/column operations menu, following lucide's
 * `between-vertical-end` (two columns + a downward chevron between them).
 * Same 24-grid / stroke-2 / 16×16 rendering as the border icons above, so the
 * bubble's icon-only triggers keep one stroke weight.
 */
export function TableOperationsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="13" rx="1" />
      <path d="m9 22 3-3 3 3" />
      <rect x="14" y="3" width="7" height="13" rx="1" />
    </svg>
  );
}

/**
 * Insert-row menu icons, derived from lucide's `grid-2x2-plus`: dropping the
 * bottom-left cell and the row's inner divider leaves one plain bar plus the
 * plus sign — i.e. "add a row" rather than "a whole table". All four corners
 * use rx=2, so the bar doesn't read as round-on-top / square-on-bottom.
 *
 * + 仍在行的下方 / 上方: 这两枚靠上下位置区分「下方插入行 / 上方插入行」,
 * `above` 是同一张图沿 y=12 的垂直镜像。但 + 的中心是 x=12, 与横条
 * (x=3..21, 中心同为 12) 左右对齐 —— 参考图的 + 贴在右下角 (x=19), 在
 * 16px 下会把视线拉到一侧, 这里改成水平居中、上下位置不变。
 */
export function TableInsertRowIcon({ placement }: { placement: 'above' | 'below' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform={placement === 'above' ? 'translate(0 24) scale(1 -1)' : undefined}>
        <rect x="3" y="3" width="18" height="9" rx="2" />
        <path d="M9 19h6M12 16v6" />
      </g>
    </svg>
  );
}

/**
 * Delete-row counterpart to `TableInsertRowIcon`: same rounded bar (same rx=2
 * corners, no inner divider), centred vertically so an X can sit beside it
 * rather than below it. The bar is 9 grid units wide so the two shapes keep a
 * visible 2px gap at 16px: the bar's right edge (12) plus its 1-unit stroke is
 * 13, the X's round cap reaches left to 16 — 3 grid units = 2px once the
 * 24-grid is scaled to 16px. Keeping the bar as the shared shape makes insert
 * / delete read as one family.
 */
export function TableDeleteRowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="8" width="9" height="8" rx="2" />
      <path d="M17 9l5 6M22 9l-5 6" />
    </svg>
  );
}

/**
 * Insert-column menu icons: `TableInsertRowIcon` rotated 90° (x,y → 24-y,x),
 * so the bar becomes a column and the plus sits beside it. `left` (insert
 * before) puts the plus on the left; `right` mirrors the same drawing on x=12.
 * The plus is centred on the bar's vertical axis (y=12), which is the column
 * counterpart of the row pair's horizontal centring. Same 24-grid / stroke 2 /
 * rx=2 / 2-unit gap.
 */
export function TableInsertColumnIcon({ placement }: { placement: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform={placement === 'right' ? 'translate(24 0) scale(-1 1)' : undefined}>
        <rect x="12" y="3" width="9" height="18" rx="2" />
        <path d="M2 12h6M5 9v6" />
      </g>
    </svg>
  );
}

/**
 * Delete-column counterpart: `TableDeleteRowIcon` rotated the same 90° — a
 * short rounded column with an X below it, on the x=12 centre line. Bar bottom
 * 12 + 1-unit stroke = 13, X round cap starts at 16, so the 3 grid units /
 * 2px gap is preserved from the row version.
 */
export function TableDeleteColumnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="3" width="8" height="9" rx="2" />
      <path d="M9 17l6 5M15 17l-6 5" />
    </svg>
  );
}

/**
 * Delete-table button, following lucide's `trash` outline (lid, handle,
 * tapered body) but without the inner ribs: at 16×16 those short vertical
 * strokes turn into visual noise next to the border/operations glyphs.
 * Shares the 24-grid / stroke-2 geometry of the other bubble icons.
 */
export function TableDeleteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
