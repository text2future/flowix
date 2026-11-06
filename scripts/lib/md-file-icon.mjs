// Shared geometry for the Flowix `.md` document icon.
//
// Both platform icon artifacts draw from this file so macOS and Windows never
// drift apart:
//   - scripts/gen-md-icns.mjs -> app/flowix-desktop/icons/md.icns  (Finder)
//   - scripts/gen-md-ico.mjs  -> app/flowix-desktop/icons/md.ico   (Explorer)
//
// The drawing mirrors the in-app `NoteContentIcon` (features/content/components/
// note-content-icon.tsx): same "page + folded corner + M" family, redrawn at
// icon scale because the 16x16 path uses a much larger corner radius and a much
// bigger fold than a 1024px document icon wants.

// `M` mark, lifted verbatim from NoteContentIcon (16-unit canvas).
export const MARK =
	'M0 1.2147C0 0.5622 0.5145 0.0299 1.1599 0.0012C1.1667 0.0008 1.1737 0.0005 1.1806 0.0005C1.192 0.0002 1.2033 0 1.2147 0L1.2147 0.0008C1.6818 0.0124 2.0994 0.2985 2.2781 0.7322L3.39 3.431L4.5019 0.7322C4.6806 0.2985 5.0982 0.0124 5.5653 0.0008L5.5653 0C5.5767 0 5.588 0.0002 5.5994 0.0005C5.6063 0.0005 5.6133 0.0008 5.6201 0.0012C6.2655 0.0299 6.78 0.5622 6.78 1.2147L6.78 5.65C6.1091 5.65 5.5652 5.1061 5.5653 4.4353L5.5653 1.3824L4.2246 4.2297C4.106 4.4815 3.8904 4.6677 3.6346 4.7522C3.5842 4.7839 3.5242 4.8025 3.4582 4.8025C3.4353 4.8025 3.4126 4.8017 3.39 4.8002C3.3674 4.8017 3.3447 4.8025 3.3218 4.8025C3.2558 4.8025 3.1958 4.7839 3.1454 4.7522C2.8896 4.6677 2.674 4.4815 2.5554 4.2297L1.2147 1.3824L1.2147 4.4353C1.2148 5.1061 0.6709 5.65 0 5.65L0 1.2147Z';

export const THEMES = {
	// Flowix brand: same warm paper as the app icon, so a .md file reads as
	// "opened by Flowix" at a glance and stays distinguishable from WorkBuddy's
	// teal markdown icon in the same Finder / Explorer window.
	flowix: { page: '#F2DFB0', fold: '#E9D0A0', mark: '#3F4A4A', edge: '#D6B87C' },
	// The teal Markdown icon most editors ship (matches WorkBuddy / MacDown).
	markdown: { page: '#13B2BF', fold: '#AEFCFF', mark: '#FFFFFF', edge: '#0C8A95' },
};

// Canvas layout, tuned against a real 1024 macOS document icon: page occupies
// ~80% width / 88% height so it optically matches neighbouring .docx / .pdf.
export const CANVAS = 1024;
const PAGE = { w: 820, h: 900, x: 102, y: 62, r: 150, fold: 325 };

/**
 * Render the icon as a square SVG string on a 1024 canvas.
 *
 * `edge.stroke` / `edge.width` add an optional outline around the page body.
 * Windows Explorer draws file icons on both white and near-black backgrounds
 * and the warm palette is low-contrast on white, so the `.ico` variant asks for
 * a hairline edge that survives down at 16px.
 */
export function buildSvg({ page, fold, mark }, edge = null) {
	const { x, y, r, fold: foldSize } = PAGE;
	const xr = x + PAGE.w;
	const yb = y + PAGE.h;
	const fx = xr - foldSize;

	// Page body: right-top corner is cut on the fold diagonal.
	const body = [
		`M${x + r} ${y}`,
		`H${fx}`,
		`L${xr} ${y + foldSize}`,
		`V${yb - r}`,
		`A${r} ${r} 0 0 1 ${xr - r} ${yb}`,
		`H${x + r}`,
		`A${r} ${r} 0 0 1 ${x} ${yb - r}`,
		`V${y + r}`,
		`A${r} ${r} 0 0 1 ${x + r} ${y}`,
		'Z',
	].join(' ');

	// Folded corner: same top/right edges as the page, but its diagonal starts a
	// couple of px past the page's cut edge so the fold paints over that edge
	// instead of leaving a hairline of background between two antialiased
	// diagonals. Corners are rounded a little to match the page's soft edges.
	const o = 3;
	const folded = [
		`M${fx - o + 8} ${y}`,
		`Q${fx - o} ${y} ${fx - o} ${y + 8}`,
		`L${xr - 8} ${y + foldSize + o}`,
		`Q${xr} ${y + foldSize + o} ${xr} ${y + foldSize + o - 8}`,
		`V${y}`,
		`H${fx - o + 8}`,
		'Z',
	].join(' ');

	const markHeight = 370;
	const markScale = markHeight / 5.65;
	const markX = x + (PAGE.w - 6.78 * markScale) / 2;
	const markY = 460;

	const outline = edge
		? `<path fill="none" stroke="${edge.stroke}" stroke-width="${edge.width}" stroke-linejoin="round" d="${body}"/>`
		: '';

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <path fill="${page}" d="${body}"/>
  ${outline}
  <path fill="${fold}" d="${folded}"/>
  <g transform="translate(${markX} ${markY}) scale(${markScale})"><path fill="${mark}" d="${MARK}"/></g>
</svg>`;
}
