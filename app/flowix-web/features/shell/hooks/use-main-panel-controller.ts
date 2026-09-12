import { useCallback, useEffect, useState } from 'react';
import { resolveBrowserColumnLayout } from '@features/shell/hooks/browser-column-layout';
import { useMacosTrackpadSwipe, type MacosTrackpadSwipeDirection } from '@features/shell/hooks/use-macos-trackpad-swipe';
import { useResizablePanels } from '@features/shell/hooks/use-resizable-panels';

type PanelVisibilityState = {
  memoListVisible: boolean;
  noteNavigationVisible: boolean;
};

type PanelVisibilityTransition = Partial<PanelVisibilityState>;

const PANEL_SWIPE_AREA_SELECTOR =
  '[data-memo-list-swipe-area], [data-workspace-host="main-third"]';

export function isPanelSwipeArea(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(PANEL_SWIPE_AREA_SELECTOR));
}

export function resolvePanelSwipeTransition(
  state: PanelVisibilityState,
  direction: MacosTrackpadSwipeDirection,
): PanelVisibilityTransition | null {
  if (direction === 'left') return state.memoListVisible ? { memoListVisible: false } : null;
  return state.memoListVisible ? null : { memoListVisible: true };
}

interface MainPanelControllerOptions {
  browserColumnSplitRatio: number;
  documentPanelMinWidth: number;
  memoListVisible: boolean;
  noteNavigationVisible: boolean;
  setBrowserColumnSplitRatio(ratio: number): void;
  setMemoListVisible(visible: boolean): void;
  setNoteNavigationVisible(visible: boolean): void;
}

export function useMainPanelController({
  browserColumnSplitRatio,
  documentPanelMinWidth,
  memoListVisible,
  noteNavigationVisible,
  setBrowserColumnSplitRatio,
  setMemoListVisible,
  setNoteNavigationVisible,
}: MainPanelControllerOptions) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const {
    handleListDividerMouseDown,
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

  const handlePanelSwipe = useCallback((direction: MacosTrackpadSwipeDirection) => {
    const transition = resolvePanelSwipeTransition(
      { memoListVisible, noteNavigationVisible },
      direction,
    );
    if (transition?.memoListVisible !== undefined
      && transition.memoListVisible !== memoListVisible) {
      setMemoListVisible(transition.memoListVisible);
    }
  }, [
    memoListVisible,
    setMemoListVisible,
  ]);
  useMacosTrackpadSwipe({
    onSwipe: handlePanelSwipe,
    isSwipeArea: isPanelSwipeArea,
  });

  const handleToggleNoteNavigation = useCallback(() => {
    setNoteNavigationVisible(!noteNavigationVisible);
  }, [noteNavigationVisible, setNoteNavigationVisible]);
  const collapseMemoList = useCallback(() => {
    setMemoListVisible(false);
  }, [setMemoListVisible]);
  const handleToggleMemoList = useCallback(() => {
    const nextVisible = !memoListVisible;
    setMemoListVisible(nextVisible);
    if (!nextVisible && noteNavigationVisible) setNoteNavigationVisible(false);
  }, [memoListVisible, noteNavigationVisible, setMemoListVisible, setNoteNavigationVisible]);

  return {
    browserColumnLayout,
    browserColumnLayoutKey,
    collapseMemoList,
    handleBrowserColumnResize,
    handleListDividerMouseDown,
    handleToggleMemoList,
    handleToggleNoteNavigation,
    isDraggingListDivider,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
  };
}
