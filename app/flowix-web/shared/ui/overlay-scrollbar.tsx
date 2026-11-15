import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type HTMLAttributes,
  type ComponentPropsWithRef,
  type Ref,
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

export interface OverlayScrollbarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onScroll' | 'onMouseDown' | 'onWheel'> {
  children: ReactNode;
  className?: string;
  /** Render a matching custom horizontal scrollbar when the scroller overflows on x. */
  horizontalScrollbar?: boolean;
  /** Use the shared overlay scrollbar on macOS. Defaults to true; opt out for native scrolling. */
  customOnMac?: boolean;
  /** Recalculate the thumb when content is changed outside React. */
  observeContent?: boolean;
  /** DOM attributes belong to the actual scrolling viewport (e.g. listbox semantics). */
  scrollerProps?: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className' | 'onScroll' | 'onMouseDown' | 'onWheel'>;
  frameRef?: Ref<HTMLDivElement>;
  renderScroller?: (props: ComponentPropsWithRef<'div'>) => ReactNode;
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
      renderScroller,
      scrollerProps,
      frameRef,
      scrollerClassName,
      scrollerRef,
      onScroll,
      onMouseDown,
      onWheel,
      ...frameProps
    },
    ref,
  ) {
    const internalScrollerRef = useRef<HTMLDivElement | null>(null);
    const {
      overlayScrollbarFrameRef,
      updateOverlayScrollbar,
      scheduleOverlayScrollbar,
    } = useOverlayScrollbar(observeContent);

    const setFrameRef = useCallback((node: HTMLDivElement | null) => {
      overlayScrollbarFrameRef.current = node;
      if (typeof frameRef === 'function') frameRef(node);
      else if (frameRef) frameRef.current = node;
    }, [frameRef, overlayScrollbarFrameRef]);

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

    const viewportProps: ComponentPropsWithRef<'div'> = {
      ...scrollerProps,
      ref: setScrollerRef,
      className: cn('overlay-scrollbar', scrollerClassName),
      onScroll,
      onMouseDown,
      onWheel,
      children,
    };

    return (
      <div
        {...frameProps}
        ref={setFrameRef}
        data-scrollable="false"
        data-horizontal-scrollbar={String(horizontalScrollbar)}
        data-horizontal-scrollable="false"
        className={cn('overlay-scrollbar-frame', customOnMac && 'overlay-scrollbar-frame--custom-mac', className)}
      >
        {renderScroller ? renderScroller(viewportProps) : <div {...viewportProps} />}
        <div className="overlay-scrollbar-track overlay-scrollbar-track--vertical" aria-hidden="true" />
        <div className="overlay-scrollbar-thumb overlay-scrollbar-thumb--vertical" aria-hidden="true" />
        <div className="overlay-scrollbar-track overlay-scrollbar-track--horizontal" aria-hidden="true" />
        <div className="overlay-scrollbar-thumb overlay-scrollbar-thumb--horizontal" aria-hidden="true" />
      </div>
    );
  },
);
