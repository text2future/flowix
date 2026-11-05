const MENU_MARGIN = 8;
const MAX_MENU_WIDTH = 720;

export function getTableMenuHorizontalLayout(
  tableCenter: number,
  root: { left: number; right: number },
  viewportWidth: number,
  measuredWidth = MAX_MENU_WIDTH,
) {
  const left = Math.max(0, root.left) + MENU_MARGIN;
  const right = Math.min(viewportWidth, root.right) - MENU_MARGIN;
  if (right <= left) return null;
  const maxWidth = Math.min(MAX_MENU_WIDTH, right - left);
  const width = Math.min(measuredWidth, maxWidth);
  const center = Math.max(left + width / 2, Math.min(tableCenter, right - width / 2));
  return { left: center - root.left, maxWidth };
}
