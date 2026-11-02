export interface OverlayScrollbarDomController {
  frame: HTMLDivElement;
  scroller: HTMLDivElement;
  update: (options?: { reveal?: boolean; schedule?: boolean }) => void;
  destroy: () => void;
}

interface OverlayScrollbarDomOptions {
  frameClassName?: string;
  scrollerClassName?: string;
  observeContent?: boolean;
}

export function createOverlayScrollbarDom(
  ownerDocument: Document,
  options: OverlayScrollbarDomOptions = {},
): OverlayScrollbarDomController {
  const frame = ownerDocument.createElement('div');
  frame.className = ['overlay-scrollbar-frame', options.frameClassName]
    .filter(Boolean)
    .join(' ');

  const scroller = ownerDocument.createElement('div');
  scroller.className = ['overlay-scrollbar', options.scrollerClassName]
    .filter(Boolean)
    .join(' ');

  const track = ownerDocument.createElement('div');
  track.className = 'overlay-scrollbar-track overlay-scrollbar-track--vertical';
  track.setAttribute('aria-hidden', 'true');

  const thumb = ownerDocument.createElement('div');
  thumb.className = 'overlay-scrollbar-thumb overlay-scrollbar-thumb--vertical';
  thumb.setAttribute('aria-hidden', 'true');

  frame.append(scroller, track, thumb);
  frame.dataset.horizontalScrollbar = 'false';
  frame.dataset.horizontalScrollable = 'false';

  const ownerWindow = ownerDocument.defaultView;
  let hideTimer: number | null = null;
  let updateFrame: number | null = null;
  let userScrollIntentUntil = 0;
  let drag: {
    pointerId: number;
    startY: number;
    startScrollTop: number;
    maxScrollTop: number;
    thumbTravel: number;
  } | null = null;

  const clearHideTimer = () => {
    if (hideTimer === null || !ownerWindow) return;
    ownerWindow.clearTimeout(hideTimer);
    hideTimer = null;
  };

  const scheduleHide = () => {
    if (!ownerWindow || drag) return;
    clearHideTimer();
    hideTimer = ownerWindow.setTimeout(() => {
      delete frame.dataset.scrolling;
      hideTimer = null;
    }, 700);
  };

  const update = (syncOptions: { reveal?: boolean; schedule?: boolean } = {}) => {
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

    if (syncOptions.reveal !== false) frame.dataset.scrolling = 'true';
    if (syncOptions.schedule !== false) scheduleHide();
  };

  const markUserScrollIntent = () => {
    userScrollIntentUntil = Date.now() + 200;
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      markUserScrollIntent();
    }
  };

  const finishDrag = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    delete frame.dataset.dragging;
    try {
      thumb.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already have been released.
    }
    update();
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (frame.dataset.scrollable !== 'true') return;
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    const thumbHeight = Math.max(
      24,
      Math.round((scroller.clientHeight / scroller.scrollHeight) * scroller.clientHeight),
    );
    const thumbTravel = Math.max(1, scroller.clientHeight - thumbHeight);

    event.preventDefault();
    event.stopPropagation();
    thumb.setPointerCapture(event.pointerId);
    clearHideTimer();
    frame.dataset.dragging = 'true';
    frame.dataset.scrolling = 'true';
    drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scroller.scrollTop,
      maxScrollTop,
      thumbTravel,
    };
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const scrollDelta = ((event.clientY - drag.startY) / drag.thumbTravel) * drag.maxScrollTop;
    scroller.scrollTop = Math.max(
      0,
      Math.min(drag.startScrollTop + scrollDelta, drag.maxScrollTop),
    );
    update({ schedule: false });
  };

  const handleWheel = (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    const target = event.target;
    const NodeConstructor = ownerWindow?.Node;
    if (
      NodeConstructor
      && target instanceof NodeConstructor
      && (target === scroller || scroller.contains(target))
    ) {
      return;
    }
    event.preventDefault();
    markUserScrollIntent();
    scroller.scrollTop += event.deltaY;
    update();
  };

  const handleScroll = () => {
    const userInitiated = Date.now() <= userScrollIntentUntil;
    update({ reveal: userInitiated, schedule: userInitiated });
  };
  const handleResize = () => update({ reveal: false, schedule: false });
  const handleTrackPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
      frame.dataset.trackHover = 'true';
    }
  };
  const clearTrackHover = () => { delete frame.dataset.trackHover; };
  const handleTrackPointerLeave = (event: PointerEvent) => {
    if (event.relatedTarget !== track && event.relatedTarget !== thumb) clearTrackHover();
  };
  const handleAncestorScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && target !== scroller && target.contains(frame)) {
      clearTrackHover();
    }
  };

  const scheduleQuietUpdate = () => {
    if (!ownerWindow || updateFrame !== null) return;
    updateFrame = ownerWindow.requestAnimationFrame(() => {
      updateFrame = null;
      update({ reveal: false, schedule: false });
    });
  };
  const contentObserver = options.observeContent && typeof MutationObserver !== 'undefined'
    ? new MutationObserver(scheduleQuietUpdate)
    : null;
  contentObserver?.observe(scroller, { childList: true, characterData: true, subtree: true });
  const resizeObserver = options.observeContent && typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(scheduleQuietUpdate)
    : null;
  resizeObserver?.observe(scroller);
  if (options.observeContent) scheduleQuietUpdate();

  scroller.addEventListener('scroll', handleScroll);
  scroller.addEventListener('wheel', markUserScrollIntent, { passive: true });
  scroller.addEventListener('touchmove', markUserScrollIntent, { passive: true });
  scroller.addEventListener('keydown', handleKeyDown);
  frame.addEventListener('wheel', handleWheel, { passive: false });
  thumb.addEventListener('pointerdown', handlePointerDown);
  thumb.addEventListener('pointermove', handlePointerMove);
  thumb.addEventListener('pointerup', finishDrag);
  thumb.addEventListener('pointercancel', finishDrag);
  track.addEventListener('pointermove', handleTrackPointerMove);
  thumb.addEventListener('pointermove', handleTrackPointerMove);
  track.addEventListener('pointerleave', handleTrackPointerLeave);
  thumb.addEventListener('pointerleave', handleTrackPointerLeave);
  frame.addEventListener('pointerleave', clearTrackHover);
  ownerDocument.addEventListener('scroll', handleAncestorScroll, true);
  ownerWindow?.addEventListener('resize', handleResize);

  return {
    frame,
    scroller,
    update,
    destroy: () => {
      clearHideTimer();
      if (updateFrame !== null) ownerWindow?.cancelAnimationFrame(updateFrame);
      contentObserver?.disconnect();
      resizeObserver?.disconnect();
      scroller.removeEventListener('scroll', handleScroll);
      scroller.removeEventListener('wheel', markUserScrollIntent);
      scroller.removeEventListener('touchmove', markUserScrollIntent);
      scroller.removeEventListener('keydown', handleKeyDown);
      frame.removeEventListener('wheel', handleWheel);
      thumb.removeEventListener('pointerdown', handlePointerDown);
      thumb.removeEventListener('pointermove', handlePointerMove);
      thumb.removeEventListener('pointerup', finishDrag);
      thumb.removeEventListener('pointercancel', finishDrag);
      track.removeEventListener('pointermove', handleTrackPointerMove);
      thumb.removeEventListener('pointermove', handleTrackPointerMove);
      track.removeEventListener('pointerleave', handleTrackPointerLeave);
      thumb.removeEventListener('pointerleave', handleTrackPointerLeave);
      frame.removeEventListener('pointerleave', clearTrackHover);
      ownerDocument.removeEventListener('scroll', handleAncestorScroll, true);
      ownerWindow?.removeEventListener('resize', handleResize);
    },
  };
}
