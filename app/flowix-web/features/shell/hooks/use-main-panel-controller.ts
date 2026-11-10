import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  resolveBrowserColumnLayout,
  shouldCollapseSidebarOnBrowserExpand,
} from '@features/shell/hooks/browser-column-layout';
import { useResizablePanels } from '@features/shell/hooks/use-resizable-panels';

// Slightly longer than --flowix-motion-duration (180ms, see styles/index.css)
// so the flag outlives the transition even if a frame is dropped. Kept local:
// this is a layout-sync signal, not a shared motion token.
const MEMO_LIST_ANIMATION_MS = 200;

interface MainPanelControllerOptions {
  browserColumnVisible: boolean;
  browserColumnSplitRatio: number;
  documentPanelMinWidth: number;
  memoListVisible: boolean;
  setBrowserColumnSplitRatio(ratio: number): void;
  setMemoListVisible(visible: boolean): void;
}

export function useMainPanelController({
  browserColumnVisible,
  browserColumnSplitRatio,
  documentPanelMinWidth,
  memoListVisible,
  setBrowserColumnSplitRatio,
  setMemoListVisible,
}: MainPanelControllerOptions) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const {
    resizeMemoList,
    setIsDraggingListDivider,
    isDraggingListDivider,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
  } = useResizablePanels({
    documentPanelMinWidth,
    layoutWidth: viewportWidth,
    memoListVisible,
    noteNavigationWidth: 0,
  });

  // True while the memo list is mid-collapse/expand. Consumers use this to
  // gate transitions on the sibling columns so their widths interpolate in
  // lockstep with ListColumn's animated width — otherwise the flex row
  // overflows the container for the duration of the transition and
  // overflow-x-auto flashes a horizontal scrollbar.
  const [isMemoListAnimating, setIsMemoListAnimating] = useState(false);
  const memoListAnimateTimerRef = useRef<number | null>(null);
  const hasSeenInitialMemoListVisible = useRef(false);
  useEffect(() => {
    if (!hasSeenInitialMemoListVisible.current) {
      hasSeenInitialMemoListVisible.current = true;
      return;
    }
    setIsMemoListAnimating(true);
    if (memoListAnimateTimerRef.current !== null) {
      window.clearTimeout(memoListAnimateTimerRef.current);
    }
    memoListAnimateTimerRef.current = window.setTimeout(() => {
      memoListAnimateTimerRef.current = null;
      setIsMemoListAnimating(false);
    }, MEMO_LIST_ANIMATION_MS);
  }, [memoListVisible]);
  useEffect(() => () => {
    if (memoListAnimateTimerRef.current !== null) {
      window.clearTimeout(memoListAnimateTimerRef.current);
      memoListAnimateTimerRef.current = null;
    }
  }, []);

  const browserColumnLayout = resolveBrowserColumnLayout({
    viewportWidth,
    noteNavigationWidth: 0,
    memoListWidth,
    memoListVisible: !isMemoListHidden,
    dividerCount: !isMemoListHidden ? 1 : 0,
    splitRatio: browserColumnSplitRatio,
  });
  const browserColumnLayoutKey = [
    viewportWidth,
    memoListWidth,
    browserColumnLayout.mainColumnWidth,
    browserColumnLayout.browserColumnWidth,
    isMemoListHidden ? 'memo-hidden' : 'memo-visible',
  ].join(':');

  const handleBrowserColumnResize = useCallback((nextWidth: number) => {
    if (!browserColumnLayout.canSplit || browserColumnLayout.availableDocumentWidth <= 0) return;
    setBrowserColumnSplitRatio(nextWidth / browserColumnLayout.availableDocumentWidth);
  }, [
    browserColumnLayout.availableDocumentWidth,
    browserColumnLayout.canSplit,
    setBrowserColumnSplitRatio,
  ]);

  const collapseMemoList = useCallback(() => {
    setMemoListVisible(false);
  }, [setMemoListVisible]);
  const handleToggleMemoList = useCallback(() => {
    setMemoListVisible(!memoListVisible);
  }, [memoListVisible, setMemoListVisible]);

  // 展开右栏（column-2，覆盖显式 toggle 与列表点行/恢复会话等所有
  // visible false→true 路径）时，若双列放不下两个最小列，在展开的同一帧
  // 收起左侧列表侧边栏让出宽度。判定见 shouldCollapseSidebarOnBrowserExpand。
  // 用 layout effect：收起必须在首帧 paint 前生效，否则展开瞬间会闪一帧
  // 「侧边栏占位 + canSplit=false 网格」的溢出/横向滚动条。
  const prevBrowserColumnVisibleRef = useRef(browserColumnVisible);
  useLayoutEffect(() => {
    const wasVisible = prevBrowserColumnVisibleRef.current;
    prevBrowserColumnVisibleRef.current = browserColumnVisible;
    if (shouldCollapseSidebarOnBrowserExpand({
      browserColumnVisible,
      previousBrowserColumnVisible: wasVisible,
      memoListVisible,
      canSplit: browserColumnLayout.canSplit,
    })) {
      setMemoListVisible(false);
    }
  }, [browserColumnVisible, browserColumnLayout.canSplit, memoListVisible, setMemoListVisible]);

  return {
    browserColumnLayout,
    browserColumnLayoutKey,
    collapseMemoList,
    handleBrowserColumnResize,
    resizeMemoList,
    setIsDraggingListDivider,
    handleToggleMemoList,
    isDraggingListDivider,
    isMemoListAnimating,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
  };
}
