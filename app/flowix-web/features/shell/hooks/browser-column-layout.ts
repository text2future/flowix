import {
  BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
  BROWSER_COLUMN_MIN_WIDTH,
} from '@features/workspace/store/browser-column-store';

export interface BrowserColumnLayoutInput {
  viewportWidth: number;
  noteNavigationWidth: number;
  memoListWidth: number;
  memoListVisible: boolean;
  dividerCount: number;
  splitRatio: number;
}

export interface BrowserColumnLayoutResult {
  canSplit: boolean;
  availableDocumentWidth: number;
  mainColumnWidth: number;
  browserColumnWidth: number;
}

export function resolveBrowserColumnLayout({
  viewportWidth,
  noteNavigationWidth,
  memoListWidth,
  memoListVisible,
  dividerCount,
  splitRatio,
}: BrowserColumnLayoutInput): BrowserColumnLayoutResult {
  const fixedLeftWidth = noteNavigationWidth
    + (memoListVisible ? memoListWidth : 0)
    + dividerCount;
  const availableDocumentWidth = Math.max(0, viewportWidth - fixedLeftWidth);
  const canSplit = availableDocumentWidth >= BROWSER_COLUMN_MIN_WIDTH * 2;

  if (!canSplit) {
    return {
      canSplit: false,
      availableDocumentWidth,
      mainColumnWidth: BROWSER_COLUMN_MIN_WIDTH,
      browserColumnWidth: BROWSER_COLUMN_MIN_WIDTH,
    };
  }

  const minimumRatio = BROWSER_COLUMN_MIN_WIDTH / availableDocumentWidth;
  const clampedRatio = Math.min(
    1 - minimumRatio,
    Math.max(
      minimumRatio,
      Number.isFinite(splitRatio) ? splitRatio : BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
    ),
  );
  const browserColumnWidth = availableDocumentWidth * clampedRatio;
  return {
    canSplit,
    availableDocumentWidth,
    mainColumnWidth: availableDocumentWidth - browserColumnWidth,
    browserColumnWidth,
  };
}
