import { useCallback, useEffect, useMemo, useRef, type PointerEvent } from 'react';

/** 同步 thumb 几何 + 显隐状态时的可调选项。
 *  - `reveal`   是否写入 `data-scrolling="true"` 让 thumb 淡入。默认 true。
 *  - `schedule` 是否排定 700ms 后的自动淡出。默认 true。 */
export interface OverlayScrollbarSyncOptions {
  reveal?: boolean;
  schedule?: boolean;
}

export function useOverlayScrollbar() {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    maxScrollTop: number;
    thumbTravel: number;
  } | null>(null);

  const clearHideTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || dragRef.current) return;

    clearHideTimer();
    timerRef.current = window.setTimeout(() => {
      delete frame.dataset.scrolling;
      timerRef.current = null;
    }, 700);
  }, [clearHideTimer]);

  const syncOverlayScrollbar = useCallback((
    scroller: HTMLElement,
    options: OverlayScrollbarSyncOptions = {},
  ) => {
    const frame = frameRef.current;
    if (!frame) return;

    scrollerRef.current = scroller;

    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    const isScrollable = maxScrollTop > 1;

    frame.dataset.scrollable = String(isScrollable);
    if (!isScrollable) {
      frame.style.removeProperty('--overlay-scrollbar-thumb-height');
      frame.style.removeProperty('--overlay-scrollbar-thumb-top');
      return;
    }

    const thumbHeight = Math.max(
      24,
      Math.round((scroller.clientHeight / scroller.scrollHeight) * scroller.clientHeight),
    );
    const thumbTravel = Math.max(0, scroller.clientHeight - thumbHeight);
    const thumbTop = Math.round((scroller.scrollTop / maxScrollTop) * thumbTravel);

    frame.style.setProperty('--overlay-scrollbar-thumb-height', `${thumbHeight}px`);
    frame.style.setProperty('--overlay-scrollbar-thumb-top', `${thumbTop}px`);

    if (options.reveal !== false) {
      frame.dataset.scrolling = 'true';
    }

    if (options.schedule !== false) {
      scheduleHide();
    }
  }, [scheduleHide]);

  const updateOverlayScrollbar = useCallback((
    scroller: HTMLElement,
    options?: OverlayScrollbarSyncOptions,
  ) => {
    syncOverlayScrollbar(scroller, options);
  }, [syncOverlayScrollbar]);

  const finishDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;

    dragRef.current = null;
    delete frameRef.current?.dataset.dragging;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }

    if (scrollerRef.current) {
      syncOverlayScrollbar(scrollerRef.current);
    }
  }, [syncOverlayScrollbar]);

  const overlayScrollbarThumbProps = useMemo(() => ({
    'aria-hidden': true,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      const frame = frameRef.current;
      const scroller = scrollerRef.current;
      if (!frame || !scroller || frame.dataset.scrollable !== 'true') return;

      const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
      const thumbHeight = Math.max(
        24,
        Math.round((scroller.clientHeight / scroller.scrollHeight) * scroller.clientHeight),
      );
      const thumbTravel = Math.max(1, scroller.clientHeight - thumbHeight);

      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      clearHideTimer();

      frame.dataset.dragging = 'true';
      frame.dataset.scrolling = 'true';
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startScrollTop: scroller.scrollTop,
        maxScrollTop,
        thumbTravel,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const scroller = scrollerRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !scroller) return;

      event.preventDefault();
      const scrollDelta = ((event.clientY - drag.startY) / drag.thumbTravel) * drag.maxScrollTop;
      scroller.scrollTop = Math.max(
        0,
        Math.min(drag.startScrollTop + scrollDelta, drag.maxScrollTop),
      );
      syncOverlayScrollbar(scroller, { schedule: false });
    },
    onPointerUp: finishDrag,
    onPointerCancel: finishDrag,
  }), [clearHideTimer, finishDrag, syncOverlayScrollbar]);

  useEffect(() => {
    const handleWindowResize = () => {
      if (scrollerRef.current) {
        syncOverlayScrollbar(scrollerRef.current, { reveal: false, schedule: false });
      }
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [syncOverlayScrollbar]);

  // track / thumb 是 frame 的子节点, scroller 的兄弟节点 ── 滚轮落在它们
  // 上面时, 浏览器找不到 overflow:auto 的祖先, 默认不会滚动内容。
  // 在 frame 上拦截 wheel: target 是 scroller (或其后代) 时放行原生滚动,
  // 其余情况手动转发给 scroller.scrollTop。
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const handleWheel = (event: WheelEvent) => {
      const scroller = scrollerRef.current;
      if (!scroller || event.deltaY === 0) return;

      const target = event.target;
      if (target instanceof Node && (target === scroller || scroller.contains(target))) {
        return;
      }

      event.preventDefault();
      scroller.scrollTop += event.deltaY;
    };

    frame.addEventListener('wheel', handleWheel, { passive: false });
    return () => frame.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    return () => {
      clearHideTimer();
    };
  }, [clearHideTimer]);

  return {
    overlayScrollbarFrameRef: frameRef,
    overlayScrollbarThumbProps,
    updateOverlayScrollbar,
  };
}
