import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type MutableRefObject,
  type RefCallback,
  type MouseEventHandler,
  type UIEventHandler,
  type WheelEventHandler,
} from 'react';
import { cn } from '@/lib/utils';
import { useOverlayScrollbar, type OverlayScrollbarSyncOptions } from '@shared/hooks';

export interface OverlayScrollbarHandle {
  update: (options?: OverlayScrollbarSyncOptions) => void;
  getScroller: () => HTMLDivElement | null;
}

interface OverlayScrollbarProps {
  children: ReactNode;
  className?: string;
  /** Render a matching custom horizontal scrollbar when the scroller overflows on x. */
  horizontalScrollbar?: boolean;
  /** Use the shared overlay scrollbar on macOS. Defaults to true; opt out for native scrolling. */
  customOnMac?: boolean;
  /** Recalculate the thumb when content is changed outside React. */
  observeContent?: boolean;
  scrollerClassName?: string;
  scrollerRef?: MutableRefObject<HTMLDivElement | null> | RefCallback<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  onWheel?: WheelEventHandler<HTMLDivElement>;
}

export const OverlayScrollbar = forwardRef<OverlayScrollbarHandle, OverlayScrollbarProps>(
  function OverlayScrollbar(
    {
      children,
      className,
      horizontalScrollbar = false,
      customOnMac = true,
      observeContent = false,
      scrollerClassName,
      scrollerRef,
      onScroll,
      onMouseDown,
      onWheel,
    },
    ref,
  ) {
    const internalScrollerRef = useRef<HTMLDivElement | null>(null);
    const {
      overlayScrollbarFrameRef,
      overlayScrollbarThumbProps,
      overlayHorizontalScrollbarThumbProps,
      updateOverlayScrollbar,
      scheduleOverlayScrollbar,
      hasUserScrollIntent,
    } = useOverlayScrollbar();

    const setScrollerRef = useCallback((node: HTMLDivElement | null) => {
      internalScrollerRef.current = node;

      if (typeof scrollerRef === 'function') {
        scrollerRef(node);
      } else if (scrollerRef) {
        scrollerRef.current = node;
      }
    }, [scrollerRef]);

    const update = useCallback((options?: OverlayScrollbarSyncOptions) => {
      if (!internalScrollerRef.current) return;
      updateOverlayScrollbar(internalScrollerRef.current, options);
    }, [updateOverlayScrollbar]);

    useImperativeHandle(ref, () => ({
      update,
      getScroller: () => internalScrollerRef.current,
    }), [update]);

    useLayoutEffect(() => {
      // 渲染期同步几何 (thumb 高度 / 位置 / 可滚动状态), 不触发 fade-in:
      // 数据集属性写回淡出完全交给「用户主动滚动」这条路径。
      if (internalScrollerRef.current) {
        scheduleOverlayScrollbar(internalScrollerRef.current, { reveal: false, schedule: false });
      }
    });

    useLayoutEffect(() => {
      const scroller = internalScrollerRef.current;
      if (!observeContent || !scroller) return;
      const sync = () => scheduleOverlayScrollbar(scroller, { reveal: false, schedule: false });
      const contentObserver = new MutationObserver(sync);
      contentObserver.observe(scroller, { childList: true, characterData: true, subtree: true });
      const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
      resizeObserver?.observe(scroller);
      return () => {
        contentObserver.disconnect();
        resizeObserver?.disconnect();
      };
    }, [observeContent, scheduleOverlayScrollbar]);

    const handleScroll: UIEventHandler<HTMLDivElement> = useCallback((event) => {
      const userInitiated = hasUserScrollIntent();
      scheduleOverlayScrollbar(event.currentTarget, {
        reveal: userInitiated,
        schedule: userInitiated,
      });
      onScroll?.(event);
    }, [hasUserScrollIntent, onScroll, scheduleOverlayScrollbar]);

    return (
      <div
        ref={overlayScrollbarFrameRef}
        data-horizontal-scrollbar={String(horizontalScrollbar)}
        data-horizontal-scrollable="false"
        className={cn('overlay-scrollbar-frame', customOnMac && 'overlay-scrollbar-frame--custom-mac', className)}
      >
        <div
          ref={setScrollerRef}
          className={cn('overlay-scrollbar', scrollerClassName)}
          onScroll={handleScroll}
          onMouseDown={onMouseDown}
          onWheel={onWheel}
        >
          {children}
        </div>
        <div className="overlay-scrollbar-track overlay-scrollbar-track--vertical" aria-hidden="true" />
        <div className="overlay-scrollbar-thumb overlay-scrollbar-thumb--vertical" {...overlayScrollbarThumbProps} />
        <div className="overlay-scrollbar-track overlay-scrollbar-track--horizontal" aria-hidden="true" />
        <div className="overlay-scrollbar-thumb overlay-scrollbar-thumb--horizontal" {...overlayHorizontalScrollbarThumbProps} />
      </div>
    );
  },
);
