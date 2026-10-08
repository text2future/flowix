import { useCallback, useEffect, useState } from 'react';
import { resolveBrowserColumnLayout } from '@features/shell/hooks/browser-column-layout';
import { useResizablePanels } from '@features/shell/hooks/use-resizable-panels';

export type NoteNavigationDrawerPhase = 'closed' | 'open' | 'closing';

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
  const [noteNavigationPhase, setNoteNavigationPhase] = useState<NoteNavigationDrawerPhase>(
    () => noteNavigationVisible ? 'open' : 'closed',
  );

  // The persisted boolean is the semantic setting. The phase is transient
  // layout state used to synchronize the drawer with the list preview.
  useEffect(() => {
    if (noteNavigationVisible && noteNavigationPhase === 'closed') {
      setNoteNavigationPhase('open');
    } else if (!noteNavigationVisible && noteNavigationPhase === 'open') {
      setNoteNavigationPhase('closed');
    }
  }, [noteNavigationPhase, noteNavigationVisible]);

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

  const openNoteNavigation = useCallback(() => {
    setNoteNavigationPhase('open');
    setNoteNavigationVisible(true);
  }, [setNoteNavigationVisible]);
  const closeNoteNavigation = useCallback(() => {
    if (!noteNavigationVisible || noteNavigationPhase === 'closing') return;
    // Start the drawer and list transitions in the same render.
    setNoteNavigationPhase('closing');
    setNoteNavigationVisible(false);
  }, [noteNavigationPhase, noteNavigationVisible, setNoteNavigationVisible]);
  const completeNoteNavigationClose = useCallback(() => {
    setNoteNavigationPhase('closed');
  }, []);
  const handleToggleNoteNavigation = useCallback(() => {
    if (noteNavigationVisible) closeNoteNavigation();
    else openNoteNavigation();
  }, [closeNoteNavigation, noteNavigationVisible, openNoteNavigation]);
  const collapseMemoList = useCallback(() => {
    setMemoListVisible(false);
  }, [setMemoListVisible]);
  const handleToggleMemoList = useCallback(() => {
    const nextVisible = !memoListVisible;
    setMemoListVisible(nextVisible);
    if (!nextVisible && noteNavigationVisible) closeNoteNavigation();
  }, [closeNoteNavigation, memoListVisible, noteNavigationVisible, setMemoListVisible]);

  return {
    browserColumnLayout,
    browserColumnLayoutKey,
    collapseMemoList,
    handleBrowserColumnResize,
    handleListDividerMouseDown,
    handleToggleMemoList,
    handleToggleNoteNavigation,
    openNoteNavigation,
    closeNoteNavigation,
    completeNoteNavigationClose,
    isDraggingListDivider,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
    noteNavigationPhase,
  };
}
