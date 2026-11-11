import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  defaultRangeExtractor,
  observeElementRect,
  useVirtualizer,
  type Range,
  type Rect,
  type Virtualizer,
} from '@tanstack/react-virtual';

const DEFAULT_OVERSCAN = 8;
const MIN_ITEM_SIZE = 1;

interface DynamicVirtualItem<T> {
  key: string;
  index: number;
  item: T;
  start: number;
  size: number;
}

interface DynamicVirtualListOptions<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  estimateSize: (item: T, index: number) => number;
  scrollerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  /** Track fresh, stable geometry across hidden-to-visible transitions. */
  trackViewportReadiness?: boolean;
  /** Whether the viewport is currently visible and can be measured. */
  viewportActive?: boolean;
  /** Reset scroll position and measurements when the query changes. */
  resetKey?: string;
  overscan?: number;
  /** Bound fallback rows before the first usable viewport measurement. */
  unmeasuredItemLimit?: number;
  keepAliveKeys?: readonly string[];
  /** Height of non-virtual content before this list in the same scroller. */
  scrollMargin?: number;
  /** Retain visible item positions when paging or metadata changes reorder rows. */
  preserveScrollAnchor?: boolean;
}

function observeUsableRect(
  lastUsableRect: { current: Rect | null },
  trackViewportReadiness: { current: boolean },
  viewportActive: { current: boolean },
  viewportReady: { current: boolean },
  setViewportReady: (ready: boolean) => void,
) {
  return (
    instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
    onChange: (rect: Rect) => void,
  ) => {
    let frame: number | null = null;
    let previousFrameRect: Rect | null = null;
    let stableFrames = 0;

    const updateViewportReady = (ready: boolean) => {
      if (viewportReady.current === ready) return;
      viewportReady.current = ready;
      setViewportReady(ready);
    };

    const cancelPendingMeasure = () => {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
    };

    const checkViewportStability = () => {
      frame = null;
      if (!trackViewportReadiness.current || !viewportActive.current) {
        updateViewportReady(false);
        previousFrameRect = null;
        stableFrames = 0;
        return;
      }

      const element = instance.scrollElement;
      const bounds = element?.getBoundingClientRect();
      const rect = {
        width: bounds?.width ?? 0,
        height: bounds?.height ?? 0,
      };
      if (rect.width <= 0 || rect.height <= 0) {
        updateViewportReady(false);
        previousFrameRect = null;
        stableFrames = 0;
        return;
      }

      lastUsableRect.current = rect;
      onChange(rect);
      if (previousFrameRect
        && Math.abs(previousFrameRect.width - rect.width) < 0.5
        && Math.abs(previousFrameRect.height - rect.height) < 0.5) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
      previousFrameRect = rect;

      // After a hidden-to-visible transition, wait for the opening width
      // animation to settle before exposing dynamically measured rows.
      if (stableFrames >= 1) {
        updateViewportReady(true);
        return;
      }
      frame = requestAnimationFrame(checkViewportStability);
    };

    const scheduleStabilityCheck = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(checkViewportStability);
    };

    const stopObserving = observeElementRect(instance, (observedRect) => {
      const element = instance.scrollElement;
      const rect = {
        width: observedRect.width || element?.clientWidth || 0,
        height: observedRect.height || element?.clientHeight || 0,
      };
      if (rect.width > 0 && rect.height > 0) {
        lastUsableRect.current = rect;
        onChange(rect);
        if (trackViewportReadiness.current && viewportActive.current && !viewportReady.current) {
          scheduleStabilityCheck();
        }
        return;
      }

      if (trackViewportReadiness.current) {
        updateViewportReady(false);
      }
      previousFrameRect = null;
      stableFrames = 0;
      cancelPendingMeasure();
      // Hidden workspace columns temporarily report zero geometry. Keep the
      // last usable viewport so the list stays virtualized while hidden.
      if (!lastUsableRect.current) onChange(rect);
    });

    return () => {
      cancelPendingMeasure();
      stopObserving?.();
    };
  };
}

/** Shared TanStack Virtual adapter for memo cards and notebook tree rows. */
export function useDynamicVirtualList<T>({
  items,
  getKey,
  estimateSize,
  scrollerRef,
  enabled,
  trackViewportReadiness = false,
  viewportActive = true,
  resetKey,
  overscan = DEFAULT_OVERSCAN,
  unmeasuredItemLimit = items.length,
  keepAliveKeys = [],
  scrollMargin = 0,
  preserveScrollAnchor = false,
}: DynamicVirtualListOptions<T>) {
  const lastUsableRectRef = useRef<Rect | null>(null);
  const trackViewportReadinessRef = useRef(trackViewportReadiness);
  trackViewportReadinessRef.current = trackViewportReadiness;
  const viewportActiveRef = useRef(viewportActive);
  viewportActiveRef.current = viewportActive;
  const viewportReadyRef = useRef(false);
  const [viewportReadyState, setViewportReadyState] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const itemIndexesRef = useRef(new Map<string, number>());
  const measureRefCacheRef = useRef(
    new Map<string, (element: HTMLDivElement | null) => void>(),
  );

  const keys = useMemo(() => items.map(getKey), [getKey, items]);
  const itemIndexes = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  itemIndexesRef.current = itemIndexes;

  const getScrollElement = useCallback(() => scrollerRef.current, [scrollerRef]);
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys]);
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range));
    for (const key of keepAliveKeys) {
      const index = itemIndexesRef.current.get(key);
      if (index !== undefined) indexes.add(index);
    }
    return [...indexes].sort((a, b) => a - b);
  }, [keepAliveKeys]);
  const getEstimatedSize = useCallback(
    (index: number) => Math.max(MIN_ITEM_SIZE, estimateSize(items[index], index)),
    [estimateSize, items],
  );
  const measureElement = useCallback((
    element: HTMLDivElement,
    _entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
  ) => {
    const height = element.getBoundingClientRect().height;
    const viewport = instance.scrollElement?.getBoundingClientRect();
    if (height <= 0 || !viewport || viewport.width <= 0 || viewport.height <= 0) {
      // Hidden panes must not replace usable row heights with zero-height measurements.
      const index = Number(element.dataset.index);
      return instance.getVirtualItems().find((item) => item.index === index)?.size
        ?? getEstimatedSize(index);
    }
    return Math.max(MIN_ITEM_SIZE, Math.ceil(height));
  }, [getEstimatedSize]);
  const observeRect = useMemo(
    () => observeUsableRect(
      lastUsableRectRef,
      trackViewportReadinessRef,
      viewportActiveRef,
      viewportReadyRef,
      setViewportReadyState,
    ),
    [setViewportReadyState],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement,
    getItemKey,
    estimateSize: getEstimatedSize,
    measureElement,
    observeElementRect: observeRect,
    rangeExtractor,
    overscan: Math.max(0, Math.floor(overscan)),
    scrollMargin,
    initialRect: { width: 0, height: 0 },
    enabled,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const lastResetKeyRef = useRef(resetKey);
  useLayoutEffect(() => {
    if (trackViewportReadiness && !viewportActive) {
      viewportReadyRef.current = false;
      setViewportReadyState(false);
    }
  }, [setViewportReadyState, trackViewportReadiness, viewportActive]);

  useLayoutEffect(() => {
    if (lastResetKeyRef.current === resetKey) return;
    lastResetKeyRef.current = resetKey;
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    virtualizer.measure();
  }, [resetKey, scrollerRef, virtualizer]);

  const previousWidthRef = useRef(0);
  const viewportWidth = virtualizer.scrollRect?.width ?? 0;
  useLayoutEffect(() => {
    if (!enabled || viewportWidth <= 0) return;
    const previousWidth = previousWidthRef.current;
    previousWidthRef.current = viewportWidth;
    if (previousWidth === 0 || previousWidth === viewportWidth) return;

    // Width changes can alter the height of mounted rows. Remeasure those
    // rows synchronously, while retaining cached sizes for offscreen rows;
    // clearing the whole cache on every drag frame replaces them with
    // estimates and creates visible gaps between cards.
    scrollerRef.current?.querySelectorAll<HTMLDivElement>('[data-index]').forEach((element) => {
      virtualizer.measureElement(element);
    });
  }, [enabled, scrollerRef, viewportWidth, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !scroller) return;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (scroller.scrollTop > maxScrollTop) virtualizer.scrollToOffset(maxScrollTop);
  }, [enabled, scrollerRef, totalSize, virtualizer]);

  const getMeasureRef = useCallback((key: string) => {
    const cached = measureRefCacheRef.current.get(key);
    if (cached) return cached;

    const ref = (element: HTMLDivElement | null) => {
      if (element) {
        const index = itemIndexesRef.current.get(key);
        if (index !== undefined) element.dataset.index = String(index);
      }
      if (enabledRef.current) virtualizerRef.current.measureElement(element);
      if (!element) measureRefCacheRef.current.delete(key);
    };

    measureRefCacheRef.current.set(key, ref);
    return ref;
  }, []);

  const measuredItems = virtualizer.getVirtualItems();
  const virtualItems = useMemo<DynamicVirtualItem<T>[]>(() => {
    if (!enabled) return [];
    if (!lastUsableRectRef.current) {
      let start = 0;
      const fallbackItems: DynamicVirtualItem<T>[] = [];
      const fallbackCount = Math.min(items.length, Math.max(0, Math.floor(unmeasuredItemLimit)));
      for (let index = 0; index < fallbackCount; index += 1) {
        const item = items[index];
        const size = Math.max(MIN_ITEM_SIZE, estimateSize(item, index));
        const virtualItem = { key: keys[index], index, item, start, size };
        fallbackItems.push(virtualItem);
        start += size;
      }
      return fallbackItems;
    }

    return measuredItems.map((virtualItem) => ({
      key: String(virtualItem.key),
      index: virtualItem.index,
      item: items[virtualItem.index],
      start: virtualItem.start - scrollMargin,
      size: virtualItem.size,
    }));
  }, [enabled, estimateSize, items, keys, measuredItems, scrollMargin, unmeasuredItemLimit]);

  const anchorSnapshot = useRef<{
    keys: readonly string[];
    resetKey: string | undefined;
    anchors: { key: string; offset: number }[];
  } | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !preserveScrollAnchor || !scroller || !lastUsableRectRef.current) return;
    const previous = anchorSnapshot.current;
    if (previous && previous.keys !== keys && previous.resetKey === resetKey) {
      for (const anchor of previous.anchors) {
        const index = itemIndexesRef.current.get(anchor.key);
        if (index === undefined) continue;
        const measured = virtualizer.getVirtualItems().find((item) => String(item.key) === anchor.key);
        const start = measured?.start ?? virtualizer.getOffsetForIndex(index, 'start')?.[0];
        if (start !== undefined && Math.abs(start + anchor.offset - scroller.scrollTop) > 0.5) {
          virtualizer.scrollToOffset(Math.max(0, start + anchor.offset));
        }
        break;
      }
    }
    const firstVisible = virtualizer.getVirtualItemForOffset(scroller.scrollTop);
    anchorSnapshot.current = {
      keys, resetKey,
      anchors: virtualizer.getVirtualItems()
        .filter((item) => firstVisible && item.index >= firstVisible.index)
        .slice(0, 3)
        .map((item) => ({ key: String(item.key), offset: scroller.scrollTop - item.start })),
    };
  });

  const scrollToIndex = useCallback((index: number) => {
    virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' });
  }, [virtualizer]);

  return {
    totalSize: enabled ? totalSize : 0,
    virtualItems,
    isVirtualizationReady: enabled && lastUsableRectRef.current !== null,
    isViewportReady: trackViewportReadiness
      && enabled
      && viewportActive
      && viewportReadyState,
    getMeasureRef,
    scrollToIndex,
  };
}
