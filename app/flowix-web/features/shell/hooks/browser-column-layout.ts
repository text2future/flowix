import {
  BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
  BROWSER_COLUMN_MIN_WIDTH,
} from '@features/workspace/public/shell-api';

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

export interface SidebarCollapseOnBrowserExpandInput {
  browserColumnVisible: boolean;
  /** Visibility of the browser column before the transition being handled. */
  previousBrowserColumnVisible: boolean;
  memoListVisible: boolean;
  canSplit: boolean;
}

/**
 * 展开右栏（column-2，visible false→true 的过渡瞬间）时，若侧边栏展开
 * 状态下双列放不下两个最小列（canSplit=false），应同时收起侧边栏让出宽度。
 * 只在过渡瞬间为真：右栏保持展开时手动重新展开侧边栏不受影响。
 */
export function shouldCollapseSidebarOnBrowserExpand({
  browserColumnVisible,
  previousBrowserColumnVisible,
  memoListVisible,
  canSplit,
}: SidebarCollapseOnBrowserExpandInput): boolean {
  return browserColumnVisible
    && !previousBrowserColumnVisible
    && memoListVisible
    && !canSplit;
}
