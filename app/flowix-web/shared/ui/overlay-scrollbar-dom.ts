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
  /** Render a horizontal-only overlay, using the shared product scrollbar styles. */
  horizontal?: boolean;
}

export function createOverlayScrollbarDom(
  ownerDocument: Document,
  options: OverlayScrollbarDomOptions = {},
): OverlayScrollbarDomController {
  const horizontal = options.horizontal === true;
  const axis = horizontal ? 'horizontal' : 'vertical';
  const scrollSize = horizontal ? 'scrollWidth' : 'scrollHeight';
  const clientSize = horizontal ? 'clientWidth' : 'clientHeight';
  const scrollPosition = horizontal ? 'scrollLeft' : 'scrollTop';
  const thumbSizeProperty = horizontal ? '--overlay-scrollbar-thumb-width' : '--overlay-scrollbar-thumb-height';
  const thumbPositionProperty = horizontal ? '--overlay-scrollbar-thumb-left' : '--overlay-scrollbar-thumb-top';
  const frame = ownerDocument.createElement('div');
  frame.className = ['overlay-scrollbar-frame', options.frameClassName]
    .filter(Boolean)
    .join(' ');

  const scroller = ownerDocument.createElement('div');
  scroller.className = ['overlay-scrollbar', options.scrollerClassName]
    .filter(Boolean)
    .join(' ');

  const track = ownerDocument.createElement('div');
  track.className = `overlay-scrollbar-track overlay-scrollbar-track--${axis}`;
  track.setAttribute('aria-hidden', 'true');

  const thumb = ownerDocument.createElement('div');
  thumb.className = `overlay-scrollbar-thumb overlay-scrollbar-thumb--${axis}`;
  thumb.setAttribute('aria-hidden', 'true');

  frame.append(scroller, track, thumb);
  frame.dataset.horizontalScrollbar = String(horizontal);
  frame.dataset.horizontalScrollable = 'false';

  const ownerWindow = ownerDocument.defaultView;
  let hideTimer: number | null = null;
  let updateFrame: number | null = null;
  let userScrollIntentUntil = 0;
  let drag: {
    pointerId: number;
    startPointer: number;
    startScroll: number;
    maxScroll: number;
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
    const maxScroll = scroller[scrollSize] - scroller[clientSize];
    const isScrollable = maxScroll > 1;
    frame.dataset[horizontal ? 'horizontalScrollable' : 'scrollable'] = String(isScrollable);

    if (!isScrollable) {
      frame.style.removeProperty(thumbSizeProperty);
      frame.style.removeProperty(thumbPositionProperty);
      return;
    }

    const thumbSize = Math.max(
      24,
      Math.round((scroller[clientSize] / scroller[scrollSize]) * scroller[clientSize]),
    );
    const thumbTravel = Math.max(0, scroller[clientSize] - thumbSize);
    const thumbOffset = Math.round((scroller[scrollPosition] / maxScroll) * thumbTravel);
    frame.style.setProperty(thumbSizeProperty, `${thumbSize}px`);
    frame.style.setProperty(thumbPositionProperty, `${thumbOffset}px`);

    if (syncOptions.reveal !== false) frame.dataset.scrolling = 'true';
    if (syncOptions.schedule !== false) scheduleHide();
  };

  const markUserScrollIntent = () => {
    userScrollIntentUntil = Date.now() + 200;
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      markUserScrollIntent();
    }
  };

  const finishDrag = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    delete frame.dataset[horizontal ? 'horizontalDragging' : 'dragging'];
    try {
      thumb.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already have been released.
    }
    update();
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || frame.dataset[horizontal ? 'horizontalScrollable' : 'scrollable'] !== 'true') return;
    const maxScroll = scroller[scrollSize] - scroller[clientSize];
    const thumbSize = Math.max(
      24,
      Math.round((scroller[clientSize] / scroller[scrollSize]) * scroller[clientSize]),
    );
    const thumbTravel = Math.max(1, scroller[clientSize] - thumbSize);

    event.preventDefault();
    event.stopPropagation();
    thumb.setPointerCapture(event.pointerId);
    clearHideTimer();
    frame.dataset[horizontal ? 'horizontalDragging' : 'dragging'] = 'true';
    frame.dataset.scrolling = 'true';
    drag = {
      pointerId: event.pointerId,
      startPointer: (horizontal ? event.clientX : event.clientY),
      startScroll: scroller[scrollPosition],
      maxScroll,
      thumbTravel,
    };
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const scrollDelta = (((horizontal ? event.clientX : event.clientY) - drag.startPointer) / drag.thumbTravel) * drag.maxScroll;
    scroller[scrollPosition] = Math.max(
      0,
      Math.min(drag.startScroll + scrollDelta, drag.maxScroll),
    );
    update({ schedule: false });
  };

  const handleWheel = (event: WheelEvent) => {
    const delta = horizontal ? event.deltaX || (event.shiftKey ? event.deltaY : 0) : event.deltaY;
    if (delta === 0) return;
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
    scroller[scrollPosition] += delta;
    update();
  };

  const handleScroll = () => {
    const userInitiated = Date.now() <= userScrollIntentUntil;
    update({ reveal: userInitiated, schedule: userInitiated });
  };
  const handleResize = () => update({ reveal: false, schedule: false });
  const handleTrackPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
      frame.dataset[horizontal ? 'horizontalTrackHover' : 'trackHover'] = 'true';
    }
  };
  const clearTrackHover = () => { delete frame.dataset[horizontal ? 'horizontalTrackHover' : 'trackHover']; };
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
  thumb.addEventListener('lostpointercapture', finishDrag);
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
      thumb.removeEventListener('lostpointercapture', finishDrag);
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
