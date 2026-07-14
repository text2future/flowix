import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type MutableRefObject,
  type RefCallback,
  type UIEventHandler,
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
  scrollerClassName?: string;
  scrollerRef?: MutableRefObject<HTMLDivElement | null> | RefCallback<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}

export const OverlayScrollbar = forwardRef<OverlayScrollbarHandle, OverlayScrollbarProps>(
  function OverlayScrollbar(
    {
      children,
      className,
      scrollerClassName,
      scrollerRef,
      onScroll,
    },
    ref,
  ) {
    const internalScrollerRef = useRef<HTMLDivElement | null>(null);
    const {
      overlayScrollbarFrameRef,
      overlayScrollbarThumbProps,
      updateOverlayScrollbar,
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
      update({ reveal: false, schedule: false });
    });

    const handleScroll: UIEventHandler<HTMLDivElement> = useCallback((event) => {
      updateOverlayScrollbar(event.currentTarget);
      onScroll?.(event);
    }, [onScroll, updateOverlayScrollbar]);

    return (
      <div
        ref={overlayScrollbarFrameRef}
        className={cn('overlay-scrollbar-frame', className)}
      >
        <div
          ref={setScrollerRef}
          className={cn('overlay-scrollbar', scrollerClassName)}
          onScroll={handleScroll}
        >
          {children}
        </div>
        <div className="overlay-scrollbar-track" aria-hidden="true" />
        <div className="overlay-scrollbar-thumb" {...overlayScrollbarThumbProps} />
      </div>
    );
  },
);
