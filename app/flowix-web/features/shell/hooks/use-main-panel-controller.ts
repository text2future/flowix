import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { resolveBrowserColumnLayout } from '@features/shell/hooks/browser-column-layout';
import { useMacosTrackpadSwipe, type MacosTrackpadSwipeDirection } from '@features/shell/hooks/use-macos-trackpad-swipe';
import { useResizablePanels } from '@features/shell/hooks/use-resizable-panels';

const NOTE_NAVIGATION_PANEL_DEFAULT_WIDTH = 238;
const NOTE_NAVIGATION_PANEL_MIN_WIDTH = 180;
const NOTE_NAVIGATION_PANEL_MAX_WIDTH = 420;
const PANEL_DIVIDER_WIDTH = 1;

type PanelVisibilityState = {
  memoListVisible: boolean;
  noteNavigationVisible: boolean;
};

type PanelVisibilityTransition = Partial<PanelVisibilityState>;

export function resolvePanelSwipeTransition(
  state: PanelVisibilityState,
  direction: MacosTrackpadSwipeDirection,
): PanelVisibilityTransition | null {
  if (direction === 'left') {
    if (state.noteNavigationVisible) return { noteNavigationVisible: false };
    if (state.memoListVisible) return { memoListVisible: false };
    return null;
  }
  if (!state.memoListVisible) return { memoListVisible: true };
  if (!state.noteNavigationVisible) return { noteNavigationVisible: true };
  return null;
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
  const [noteNavigationPanelWidth, setNoteNavigationPanelWidth] = useState(
    NOTE_NAVIGATION_PANEL_DEFAULT_WIDTH,
  );
  const [isDraggingNoteNavigationDivider, setIsDraggingNoteNavigationDivider] = useState(false);
  const noteNavigationDividerStartRef = useRef({
    x: 0,
    width: NOTE_NAVIGATION_PANEL_DEFAULT_WIDTH,
  });

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const noteNavigationColumnWidth = noteNavigationVisible ? noteNavigationPanelWidth : 0;
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
    noteNavigationWidth: noteNavigationColumnWidth,
  });

  const browserColumnLayout = resolveBrowserColumnLayout({
    viewportWidth,
    noteNavigationWidth: noteNavigationColumnWidth,
    memoListWidth,
    memoListVisible: !isMemoListHidden,
    dividerCount: (noteNavigationVisible ? 1 : 0) + (!isMemoListHidden ? 1 : 0),
    splitRatio: browserColumnSplitRatio,
  });
  const browserColumnLayoutKey = [
    viewportWidth,
    noteNavigationColumnWidth,
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

  const getNoteNavigationPanelMaxWidth = useCallback(() => {
    const visibleDividerWidth =
      (noteNavigationVisible ? PANEL_DIVIDER_WIDTH : 0) +
      (!isMemoListHidden ? PANEL_DIVIDER_WIDTH : 0);
    const availableWidth =
      viewportWidth - memoListWidth - documentPanelMinWidth - visibleDividerWidth;
    return Math.min(
      NOTE_NAVIGATION_PANEL_MAX_WIDTH,
      Math.max(NOTE_NAVIGATION_PANEL_MIN_WIDTH, availableWidth),
    );
  }, [
    documentPanelMinWidth,
    isMemoListHidden,
    memoListWidth,
    noteNavigationVisible,
    viewportWidth,
  ]);

  const handleNoteNavigationDividerMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    setIsDraggingNoteNavigationDivider(true);
    noteNavigationDividerStartRef.current = {
      x: event.clientX,
      width: noteNavigationPanelWidth,
    };
  }, [noteNavigationPanelWidth]);

  useEffect(() => {
    if (!isDraggingNoteNavigationDivider) return;
    const handleMouseMove = (event: MouseEvent) => {
      const diff = event.clientX - noteNavigationDividerStartRef.current.x;
      const nextWidth = noteNavigationDividerStartRef.current.width + diff;
      setNoteNavigationPanelWidth(Math.min(
        getNoteNavigationPanelMaxWidth(),
        Math.max(NOTE_NAVIGATION_PANEL_MIN_WIDTH, nextWidth),
      ));
    };
    const handleMouseUp = () => setIsDraggingNoteNavigationDivider(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [getNoteNavigationPanelMaxWidth, isDraggingNoteNavigationDivider]);

  useEffect(() => {
    if (!noteNavigationVisible || isDraggingNoteNavigationDivider) return;
    setNoteNavigationPanelWidth((width) => Math.min(width, getNoteNavigationPanelMaxWidth()));
  }, [getNoteNavigationPanelMaxWidth, isDraggingNoteNavigationDivider, noteNavigationVisible]);

  const handlePanelSwipe = useCallback((direction: MacosTrackpadSwipeDirection) => {
    const transition = resolvePanelSwipeTransition(
      { memoListVisible, noteNavigationVisible },
      direction,
    );
    if (transition?.memoListVisible !== undefined
      && transition.memoListVisible !== memoListVisible) {
      setMemoListVisible(transition.memoListVisible);
    }
    if (transition?.noteNavigationVisible !== undefined
      && transition.noteNavigationVisible !== noteNavigationVisible) {
      setNoteNavigationVisible(transition.noteNavigationVisible);
    }
  }, [
    memoListVisible,
    noteNavigationVisible,
    setMemoListVisible,
    setNoteNavigationVisible,
  ]);
  useMacosTrackpadSwipe({ onSwipe: handlePanelSwipe });

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
    handleNoteNavigationDividerMouseDown,
    handleToggleMemoList,
    handleToggleNoteNavigation,
    isDraggingListDivider,
    isDraggingNoteNavigationDivider,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
    noteNavigationColumnWidth,
    noteNavigationPanelWidth,
  };
}
