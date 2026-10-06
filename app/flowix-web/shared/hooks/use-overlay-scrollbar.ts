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
  const userScrollIntentUntilRef = useRef(0);
  const syncFrameRef = useRef<number | null>(null);
  const pendingSyncRef = useRef<{
    scroller: HTMLElement;
    options: OverlayScrollbarSyncOptions;
  } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    maxScrollTop: number;
    thumbTravel: number;
  } | null>(null);
  const horizontalDragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    maxScrollLeft: number;
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
    if (!frame || dragRef.current || horizontalDragRef.current) return;

    clearHideTimer();
    timerRef.current = window.setTimeout(() => {
      delete frame.dataset.scrolling;
      timerRef.current = null;
    }, 700);
  }, [clearHideTimer]);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + 200;
  }, []);
  const hasUserScrollIntent = useCallback(
    () => Date.now() <= userScrollIntentUntilRef.current,
    [],
  );

  const syncOverlayScrollbar = useCallback((
    scroller: HTMLElement,
    options: OverlayScrollbarSyncOptions = {},
  ) => {
    const frame = frameRef.current;
    if (!frame) return;

    scrollerRef.current = scroller;

    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    const isScrollable = maxScrollTop > 1;
    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
    const isHorizontallyScrollable = maxScrollLeft > 1;

    frame.dataset.scrollable = String(isScrollable);
    frame.dataset.horizontalScrollable = String(isHorizontallyScrollable);
    if (!isScrollable) {
      frame.style.removeProperty('--overlay-scrollbar-thumb-height');
      frame.style.removeProperty('--overlay-scrollbar-thumb-top');
    } else {
      const trackHeight = frame.querySelector(':scope > .overlay-scrollbar-track--vertical')?.clientHeight || scroller.clientHeight;
      const thumbHeight = Math.min(trackHeight, Math.max(
        24,
        Math.round((scroller.clientHeight / scroller.scrollHeight) * trackHeight),
      ));
      const thumbTravel = Math.max(0, trackHeight - thumbHeight);
      const thumbTop = Math.round((scroller.scrollTop / maxScrollTop) * thumbTravel);

      frame.style.setProperty('--overlay-scrollbar-thumb-height', `${thumbHeight}px`);
      frame.style.setProperty('--overlay-scrollbar-thumb-top', `${thumbTop}px`);
    }

    if (!isHorizontallyScrollable) {
      frame.style.removeProperty('--overlay-scrollbar-thumb-width');
      frame.style.removeProperty('--overlay-scrollbar-thumb-left');
    } else {
      const trackWidth = frame.querySelector(':scope > .overlay-scrollbar-track--horizontal')?.clientWidth || scroller.clientWidth;
      const thumbWidth = Math.min(trackWidth, Math.max(
        24,
        Math.round((scroller.clientWidth / scroller.scrollWidth) * trackWidth),
      ));
      const thumbTravel = Math.max(0, trackWidth - thumbWidth);
      const thumbLeft = Math.round((scroller.scrollLeft / maxScrollLeft) * thumbTravel);

      frame.style.setProperty('--overlay-scrollbar-thumb-width', `${thumbWidth}px`);
      frame.style.setProperty('--overlay-scrollbar-thumb-left', `${thumbLeft}px`);
    }

    if ((isScrollable || isHorizontallyScrollable) && options.reveal !== false) {
      frame.dataset.scrolling = 'true';
    }

    if ((isScrollable || isHorizontallyScrollable) && options.schedule !== false) {
      scheduleHide();
    }
  }, [scheduleHide]);

  const updateOverlayScrollbar = useCallback((
    scroller: HTMLElement,
    options?: OverlayScrollbarSyncOptions,
  ) => {
    syncOverlayScrollbar(scroller, options);
  }, [syncOverlayScrollbar]);

  // Scroll events can arrive faster than layout can be measured. Keep only
  // the latest geometry request and perform the synchronous DOM reads/writes
  // once per animation frame.
  const scheduleOverlayScrollbar = useCallback((
    scroller: HTMLElement,
    options: OverlayScrollbarSyncOptions = {},
  ) => {
    // Effects bind wheel/touch/key listeners before the queued animation frame runs.
    scrollerRef.current = scroller;
    const previous = pendingSyncRef.current;
    pendingSyncRef.current = {
      scroller,
      options: {
        reveal: (previous?.options.reveal ?? false) || (options.reveal ?? true),
        schedule: (previous?.options.schedule ?? false) || (options.schedule ?? true),
      },
    };
    if (options.reveal !== false) frameRef.current?.setAttribute('data-scrolling', 'true');
    if (syncFrameRef.current !== null) return;

    const flush = () => {
      syncFrameRef.current = null;
      const pending = pendingSyncRef.current;
      pendingSyncRef.current = null;
      if (pending) syncOverlayScrollbar(pending.scroller, pending.options);
    };
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      flush();
      return;
    }
    syncFrameRef.current = window.requestAnimationFrame(flush);
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

  const finishHorizontalDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!horizontalDragRef.current || horizontalDragRef.current.pointerId !== event.pointerId) return;

    horizontalDragRef.current = null;
    delete frameRef.current?.dataset.horizontalDragging;

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
      const trackHeight = frame.querySelector(':scope > .overlay-scrollbar-track--vertical')?.clientHeight || scroller.clientHeight;
      const thumbHeight = Math.min(trackHeight, Math.max(
        24,
        Math.round((scroller.clientHeight / scroller.scrollHeight) * trackHeight),
      ));
      const thumbTravel = Math.max(1, trackHeight - thumbHeight);

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

  const overlayHorizontalScrollbarThumbProps = useMemo(() => ({
    'aria-hidden': true,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      const frame = frameRef.current;
      const scroller = scrollerRef.current;
      if (!frame || !scroller || frame.dataset.horizontalScrollable !== 'true') return;

      const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
      const trackWidth = frame.querySelector(':scope > .overlay-scrollbar-track--horizontal')?.clientWidth || scroller.clientWidth;
      const thumbWidth = Math.min(trackWidth, Math.max(
        24,
        Math.round((scroller.clientWidth / scroller.scrollWidth) * trackWidth),
      ));
      const thumbTravel = Math.max(1, trackWidth - thumbWidth);

      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      clearHideTimer();

      frame.dataset.horizontalDragging = 'true';
      frame.dataset.scrolling = 'true';
      horizontalDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startScrollLeft: scroller.scrollLeft,
        maxScrollLeft,
        thumbTravel,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const drag = horizontalDragRef.current;
      const scroller = scrollerRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !scroller) return;

      event.preventDefault();
      const scrollDelta = ((event.clientX - drag.startX) / drag.thumbTravel) * drag.maxScrollLeft;
      scroller.scrollLeft = Math.max(
        0,
        Math.min(drag.startScrollLeft + scrollDelta, drag.maxScrollLeft),
      );
      syncOverlayScrollbar(scroller, { schedule: false });
    },
    onPointerUp: finishHorizontalDrag,
    onPointerCancel: finishHorizontalDrag,
  }), [clearHideTimer, finishHorizontalDrag, syncOverlayScrollbar]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const handleWindowResize = () => {
      if (scrollerRef.current) {
        syncOverlayScrollbar(scrollerRef.current, { reveal: false, schedule: false });
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        markUserScrollIntent();
      }
    };

    window.addEventListener('resize', handleWindowResize);
    scroller?.addEventListener('wheel', markUserScrollIntent, { passive: true });
    scroller?.addEventListener('touchmove', markUserScrollIntent, { passive: true });
    scroller?.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
      scroller?.removeEventListener('wheel', markUserScrollIntent);
      scroller?.removeEventListener('touchmove', markUserScrollIntent);
      scroller?.removeEventListener('keydown', handleKeyDown);
    };
  }, [markUserScrollIntent, syncOverlayScrollbar]);

  // track / thumb 是 frame 的子节点, scroller 的兄弟节点 ── 滚轮落在它们
  // 上面时, 浏览器找不到 overflow:auto 的祖先, 默认不会滚动内容。
  // 在 frame 上拦截 wheel: target 是 scroller (或其后代) 时放行原生滚动,
  // 其余情况手动转发给 scroller 对应的滚动轴。
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const track = frame.querySelector(':scope > .overlay-scrollbar-track--vertical');
    const thumb = frame.querySelector(':scope > .overlay-scrollbar-thumb--vertical');
    const horizontalTrack = frame.querySelector(':scope > .overlay-scrollbar-track--horizontal');
    const horizontalThumb = frame.querySelector(':scope > .overlay-scrollbar-thumb--horizontal');
    const ownerDocument = frame.ownerDocument;
    const handleTrackPointerMove = (event: Event) => {
      const pointer = event as globalThis.PointerEvent;
      if (pointer.pointerType === 'mouse' || pointer.pointerType === 'pen') {
        frame.dataset.trackHover = 'true';
      }
    };
    const clearTrackHover = () => { delete frame.dataset.trackHover; };
    const handleHorizontalTrackPointerMove = (event: Event) => {
      const pointer = event as globalThis.PointerEvent;
      if (pointer.pointerType === 'mouse' || pointer.pointerType === 'pen') {
        frame.dataset.horizontalTrackHover = 'true';
      }
    };
    const clearHorizontalTrackHover = () => { delete frame.dataset.horizontalTrackHover; };
    const handleTrackPointerLeave = (event: Event) => {
      const next = (event as globalThis.PointerEvent).relatedTarget;
      if (next !== track && next !== thumb) clearTrackHover();
    };
    const handleHorizontalTrackPointerLeave = (event: Event) => {
      const next = (event as globalThis.PointerEvent).relatedTarget;
      if (next !== horizontalTrack && next !== horizontalThumb) clearHorizontalTrackHover();
    };
    const handleFramePointerLeave = () => {
      clearTrackHover();
      clearHorizontalTrackHover();
    };
    const handleAncestorScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && target !== scrollerRef.current && target.contains(frame)) {
        clearTrackHover();
        clearHorizontalTrackHover();
      }
    };
    track?.addEventListener('pointermove', handleTrackPointerMove);
    thumb?.addEventListener('pointermove', handleTrackPointerMove);
    horizontalTrack?.addEventListener('pointermove', handleHorizontalTrackPointerMove);
    horizontalThumb?.addEventListener('pointermove', handleHorizontalTrackPointerMove);
    track?.addEventListener('pointerleave', handleTrackPointerLeave);
    thumb?.addEventListener('pointerleave', handleTrackPointerLeave);
    horizontalTrack?.addEventListener('pointerleave', handleHorizontalTrackPointerLeave);
    horizontalThumb?.addEventListener('pointerleave', handleHorizontalTrackPointerLeave);
    frame.addEventListener('pointerleave', handleFramePointerLeave);
    ownerDocument.addEventListener('scroll', handleAncestorScroll, true);

    const handleWheel = (event: WheelEvent) => {
      const scroller = scrollerRef.current;
      if (!scroller || (event.deltaY === 0 && event.deltaX === 0)) return;

      const target = event.target;
      if (target instanceof Node && (target === scroller || scroller.contains(target))) {
        return;
      }

      event.preventDefault();
      markUserScrollIntent();
      scroller.scrollTop += event.deltaY;
      scroller.scrollLeft += event.deltaX;
      scheduleOverlayScrollbar(scroller);
    };

    frame.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      frame.removeEventListener('wheel', handleWheel);
      track?.removeEventListener('pointermove', handleTrackPointerMove);
      thumb?.removeEventListener('pointermove', handleTrackPointerMove);
      horizontalTrack?.removeEventListener('pointermove', handleHorizontalTrackPointerMove);
      horizontalThumb?.removeEventListener('pointermove', handleHorizontalTrackPointerMove);
      track?.removeEventListener('pointerleave', handleTrackPointerLeave);
      thumb?.removeEventListener('pointerleave', handleTrackPointerLeave);
      horizontalTrack?.removeEventListener('pointerleave', handleHorizontalTrackPointerLeave);
      horizontalThumb?.removeEventListener('pointerleave', handleHorizontalTrackPointerLeave);
      frame.removeEventListener('pointerleave', handleFramePointerLeave);
      ownerDocument.removeEventListener('scroll', handleAncestorScroll, true);
    };
  }, [markUserScrollIntent, scheduleOverlayScrollbar]);

  useEffect(() => {
    return () => {
      clearHideTimer();
      pendingSyncRef.current = null;
      if (syncFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(syncFrameRef.current);
        syncFrameRef.current = null;
      }
    };
  }, [clearHideTimer]);

  return {
    overlayScrollbarFrameRef: frameRef,
    overlayScrollbarThumbProps,
    overlayHorizontalScrollbarThumbProps,
    updateOverlayScrollbar,
    scheduleOverlayScrollbar,
    hasUserScrollIntent,
  };
}
