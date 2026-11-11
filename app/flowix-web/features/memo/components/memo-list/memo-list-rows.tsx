import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { noteListItemKey, type NoteListItem } from '@/types/note-item';
import { useDynamicVirtualList } from '../../hooks/use-dynamic-virtual-list';

export type MemoRowKeepAliveChange = (item: NoteListItem, active: boolean) => void;

interface MemoListRowsProps {
  enabled: boolean;
  items: readonly NoteListItem[];
  scrollElement: HTMLDivElement | null;
  queryKey: string;
  revealKey?: string | null;
  onRevealed?: () => void;
  renderRow: (item: NoteListItem, onKeepAliveChange: MemoRowKeepAliveChange) => ReactNode;
}

const ESTIMATED_ROW_HEIGHT = 112;
const estimateRowSize = () => ESTIMATED_ROW_HEIGHT;
const INITIAL_ROW_COUNT = 16;

/** Paging owns data; this component owns only row geometry and mounted rows. */
export function MemoListRows({ enabled, items, scrollElement, queryKey, revealKey, onRevealed, renderRow }: MemoListRowsProps) {
  const scrollerRef = useMemo(() => ({ current: scrollElement }), [scrollElement]);
  const [keptAliveKeys, setKeptAliveKeys] = useState<readonly string[]>([]);
  const lastContentHeightRef = useRef(0);
  const onKeepAliveChange = useCallback<MemoRowKeepAliveChange>((item, active) => {
    const key = noteListItemKey(item);
    setKeptAliveKeys((current) => {
      if (current.includes(key) === active) return current;
      return active ? [...current, key] : current.filter((candidate) => candidate !== key);
    });
  }, []);
  const rowsEnabled = enabled || keptAliveKeys.length > 0;
  const { virtualItems, totalSize, getMeasureRef, isVirtualizationReady, scrollToIndex } = useDynamicVirtualList({
    items,
    getKey: noteListItemKey,
    estimateSize: estimateRowSize,
    scrollerRef,
    resetKey: queryKey,
    enabled: rowsEnabled,
    keepAliveKeys: keptAliveKeys,
    preserveScrollAnchor: true,
    scrollMargin: 8, // The scroller's py-2 precedes this list.
  });
  useLayoutEffect(() => {
    if (!revealKey || !isVirtualizationReady || !scrollElement?.clientHeight) return;
    const index = items.findIndex((item) => noteListItemKey(item) === revealKey);
    if (index < 0) return;
    scrollToIndex(index);
    onRevealed?.();
  }, [items, revealKey, isVirtualizationReady, scrollElement, scrollToIndex, onRevealed]);
  const estimatedContentHeight = items.length * ESTIMATED_ROW_HEIGHT;
  const visibleContentHeight = isVirtualizationReady ? totalSize : estimatedContentHeight;
  useLayoutEffect(() => {
    if (rowsEnabled) lastContentHeightRef.current = visibleContentHeight;
  }, [rowsEnabled, visibleContentHeight]);
  // Keep a spacer for inactive tabs so the shared scroller retains its offset.
  const mountedRows = isVirtualizationReady ? virtualItems : virtualItems.slice(0, INITIAL_ROW_COUNT);
  return <div className="relative min-w-0 w-full" style={{
    height: enabled
      ? visibleContentHeight
      : Math.max(lastContentHeightRef.current, estimatedContentHeight),
    overflowAnchor: 'none',
  }}>
    {mountedRows.map(({ key, index, item, start }) => <div
      key={key}
      ref={getMeasureRef(key)}
      data-index={index}
      className={isVirtualizationReady ? "absolute left-0 top-0 min-w-0 w-full" : "relative min-w-0 w-full"}
      style={isVirtualizationReady ? { transform: `translateY(${start}px)` } : undefined}
    >{renderRow(item, onKeepAliveChange)}</div>)}
  </div>;
}
