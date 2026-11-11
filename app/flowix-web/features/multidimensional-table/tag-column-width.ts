export const TAG_COLUMN_MIN_WIDTH = 120;
export const TAG_COLUMN_MAX_WIDTH = 320;

/** Fit the widest row with all cards side by side; rows wrap after reaching the maximum. */
export function autoTagColumnWidth(rowWidths: readonly number[], chromeWidth: number, headerWidth = 0): number {
  return autoContentColumnWidth(rowWidths, chromeWidth, headerWidth);
}

/** Fit the widest displayed text plus cell padding and any fixed inline controls. */
export function autoContentColumnWidth(contentWidths: readonly number[], chromeWidth: number, headerWidth = 0, minWidth = TAG_COLUMN_MIN_WIDTH): number {
  const widestContent = contentWidths.reduce((width, content) => Math.max(width, content), 0);
  return Math.min(TAG_COLUMN_MAX_WIDTH, Math.max(minWidth, Math.ceil(widestContent + chromeWidth), Math.ceil(headerWidth)));
}
