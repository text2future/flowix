import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

type UseResizablePanelsOptions = {
  documentPanelMinWidth: number;
  memoListVisible: boolean;
  noteNavigationWidth: number;
};

const MEMO_LIST_DEFAULT_WIDTH = 320;
const MEMO_LIST_MIN_WIDTH = 255;
const MEMO_LIST_MAX_WIDTH = 500;
const PANEL_DIVIDER_WIDTH = 1;

export function useResizablePanels({
  documentPanelMinWidth,
  memoListVisible,
  noteNavigationWidth,
}: UseResizablePanelsOptions) {
  const [memoColWidth, setMemoColWidth] = useState(MEMO_LIST_DEFAULT_WIDTH);
  const [isDraggingListDivider, setIsDraggingListDivider] = useState(false);
  const [layoutWidth, setLayoutWidth] = useState(() => window.innerWidth);

  const listDividerStartRef = useRef({ x: 0, width: 0 });

  const isMemoListHidden = !memoListVisible;
  const memoListWidth = isMemoListHidden ? 0 : memoColWidth;

  const visibleDividerWidth =
    (noteNavigationWidth > 0 ? PANEL_DIVIDER_WIDTH : 0) +
    (!isMemoListHidden ? PANEL_DIVIDER_WIDTH : 0);
  const sidePanelsAvailableWidth = Math.max(
    0,
    layoutWidth - noteNavigationWidth - documentPanelMinWidth - visibleDividerWidth,
  );

  const getMemoListMaxWidth = useCallback(() => (
    Math.min(
      MEMO_LIST_MAX_WIDTH,
      Math.max(MEMO_LIST_MIN_WIDTH, sidePanelsAvailableWidth),
    )
  ), [sidePanelsAvailableWidth]);

  const clampMemoListWidth = useCallback((width: number) => (
    Math.min(getMemoListMaxWidth(), Math.max(MEMO_LIST_MIN_WIDTH, width))
  ), [getMemoListMaxWidth]);

  useEffect(() => {
    const handleResize = () => setLayoutWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    setMemoColWidth((width) => clampMemoListWidth(width));
  }, [clampMemoListWidth]);

  const handleListDividerMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    setIsDraggingListDivider(true);
    listDividerStartRef.current = { x: event.clientX, width: memoColWidth };
  }, [memoColWidth]);

  useEffect(() => {
    if (!isDraggingListDivider) return;

    const handleMouseMove = (event: MouseEvent) => {
      const diff = event.clientX - listDividerStartRef.current.x;
      const nextWidth = listDividerStartRef.current.width + diff;
      setMemoColWidth(clampMemoListWidth(nextWidth));
    };

    const handleMouseUp = () => {
      setIsDraggingListDivider(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [clampMemoListWidth, isDraggingListDivider]);

  return {
    handleListDividerMouseDown,
    isDraggingListDivider,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
  };
}
