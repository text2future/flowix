/** The main and browser document panes share the same minimum width. */
export const BROWSER_COLUMN_MIN_WIDTH = 420;
export const BROWSER_COLUMN_DEFAULT_SPLIT_RATIO = 0.5;
export const BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH = 220;
export const BROWSER_COLUMN_FILE_TREE_MIN_WIDTH = 200;
export const BROWSER_COLUMN_FILE_TREE_MAX_WIDTH = 420;

const BROWSER_COLUMN_MIN_RATIO = 0.05;
const BROWSER_COLUMN_MAX_RATIO = 0.95;

export function clampSplitRatio(splitRatio: number): number {
  return Number.isFinite(splitRatio)
    ? Math.min(BROWSER_COLUMN_MAX_RATIO, Math.max(BROWSER_COLUMN_MIN_RATIO, splitRatio))
    : BROWSER_COLUMN_DEFAULT_SPLIT_RATIO;
}

export function clampFileTreeWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.min(BROWSER_COLUMN_FILE_TREE_MAX_WIDTH, Math.max(BROWSER_COLUMN_FILE_TREE_MIN_WIDTH, width))
    : BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH;
}
