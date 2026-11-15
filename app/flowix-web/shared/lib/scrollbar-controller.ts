import { SCROLLBAR_HIDE_DELAY_MS, SCROLLBAR_INTENT_WINDOW_MS, SCROLLBAR_MIN_THUMB_SIZE } from './scrollbar-config';

export interface OverlayScrollbarSyncOptions {
  reveal?: boolean;
  schedule?: boolean;
}

export interface ScrollbarController {
  update: (options?: OverlayScrollbarSyncOptions) => void;
  schedule: (options?: OverlayScrollbarSyncOptions) => void;
  destroy: () => void;
}

type Axis = 'vertical' | 'horizontal';
const AXES = {
  vertical: {
    client: 'clientHeight', extent: 'scrollHeight', offset: 'scrollTop', pointer: 'clientY',
    size: '--overlay-scrollbar-thumb-height', position: '--overlay-scrollbar-thumb-top',
    overflow: 'overflowY', scrollable: 'scrollable', dragging: 'dragging', hover: 'trackHover',
  },
  horizontal: {
    client: 'clientWidth', extent: 'scrollWidth', offset: 'scrollLeft', pointer: 'clientX',
    size: '--overlay-scrollbar-thumb-width', position: '--overlay-scrollbar-thumb-left',
    overflow: 'overflowX', scrollable: 'horizontalScrollable', dragging: 'horizontalDragging', hover: 'horizontalTrackHover',
  },
} as const;

/** One lifecycle for React and DOM-owned scrollbars. Never moves content nodes.
 * Call destroy before replacing the frame/viewport; all listeners, observers,
 * pending measurements and drag state belong to this controller.
 */
export function bindScrollbarController(
  frame: HTMLDivElement,
  scroller: HTMLElement,
  { observeContent = false }: { observeContent?: boolean } = {},
): ScrollbarController {
  const doc = frame.ownerDocument;
  const win = doc.defaultView!;
  const axes = (Object.keys(AXES) as Axis[]).flatMap((axis) => {
    const track = frame.querySelector<HTMLElement>(`:scope > .overlay-scrollbar-track--${axis}`);
    const thumb = frame.querySelector<HTMLElement>(`:scope > .overlay-scrollbar-thumb--${axis}`);
    return track && thumb ? [{ axis, track, thumb, spec: AXES[axis] }] : [];
  });
  type AxisElements = typeof axes[number];
  let disposed = false;
  let hideTimer: number | null = null;
  let measurement: number | null = null;
  let pendingReveal = false;
  let userIntentUntil = Number.NEGATIVE_INFINITY;
  let drag: { elements: AxisElements; pointerId: number; pointer: number; scroll: number; max: number; travel: number } | null = null;
  const removers: Array<() => void> = [];
  const listen = (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions | boolean) => {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };
  const enabled = ({ axis }: AxisElements) => axis === 'vertical' || frame.dataset.horizontalScrollbar !== 'false';
  const hasOverflow = () => axes.some((elements) => enabled(elements) && frame.dataset[elements.spec.scrollable] === 'true');
  const geometry = ({ track, spec }: AxisElements) => {
    const max = Math.max(0, scroller[spec.extent] - scroller[spec.client]);
    const trackSize = track[spec.client] || scroller[spec.client];
    const size = Math.min(trackSize, Math.max(SCROLLBAR_MIN_THUMB_SIZE, Math.round(scroller[spec.client] / Math.max(1, scroller[spec.extent]) * trackSize)));
    const travel = Math.max(0, trackSize - size);
    // WebKit rubber-band scrolling can report offsets outside the content range.
    const position = max ? Math.round(Math.max(0, Math.min(max, scroller[spec.offset])) / max * travel) : 0;
    return { max, size, travel, position };
  };
  const clearHide = () => {
    if (hideTimer !== null) win.clearTimeout(hideTimer);
    hideTimer = null;
  };
  const scheduleHide = () => {
    clearHide();
    if (drag) return;
    hideTimer = win.setTimeout(() => { delete frame.dataset.scrolling; hideTimer = null; }, SCROLLBAR_HIDE_DELAY_MS);
  };
  const reveal = (options: OverlayScrollbarSyncOptions) => {
    if (!hasOverflow()) {
      clearHide();
      delete frame.dataset.scrolling;
      return;
    }
    if (options.reveal !== false) frame.dataset.scrolling = 'true';
    if (options.schedule !== false) scheduleHide();
  };
  const update = (options: OverlayScrollbarSyncOptions = {}) => {
    if (disposed) return;
    for (const elements of axes) {
      const { max, size, position } = geometry(elements);
      const scrollable = enabled(elements) && max > 1;
      frame.dataset[elements.spec.scrollable] = String(scrollable);
      if (scrollable) {
        frame.style.setProperty(elements.spec.size, `${size}px`);
        frame.style.setProperty(elements.spec.position, `${position}px`);
      } else {
        frame.style.removeProperty(elements.spec.size);
        frame.style.removeProperty(elements.spec.position);
      }
    }
    reveal(options);
  };
  const schedule = (options: OverlayScrollbarSyncOptions = {}) => {
    if (disposed) return;
    pendingReveal ||= options.reveal !== false;
    // A user can scroll newly loaded content before ResizeObserver/RAF runs.
    if (options.reveal !== false && !hasOverflow()) update({ reveal: false, schedule: false });
    // Start/reset the idle delay on input, not on the next layout frame.
    reveal(options);
    if (measurement !== null) return;
    measurement = win.requestAnimationFrame(() => {
      measurement = null;
      const shouldReveal = pendingReveal;
      pendingReveal = false;
      update({ reveal: shouldReveal, schedule: false });
    });
  };
  const quietUpdate = () => schedule({ reveal: false, schedule: false });
  const markIntent = () => { userIntentUntil = Date.now() + SCROLLBAR_INTENT_WINDOW_MS; };
  const clearHover = () => {
    for (const { spec } of axes) delete frame.dataset[spec.hover];
  };
  const finishDrag = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { elements, pointerId } = drag;
    drag = null;
    delete frame.dataset[elements.spec.dragging];
    try { elements.thumb.releasePointerCapture(pointerId); } catch { /* Capture may already be lost. */ }
    update();
  };

  for (const elements of axes) {
    const { track, thumb, spec } = elements;
    const hover = ((event: PointerEvent) => {
      if (event.pointerType === 'mouse' || event.pointerType === 'pen') frame.dataset[spec.hover] = 'true';
    }) as EventListener;
    const leave = ((event: PointerEvent) => {
      if (event.relatedTarget !== track && event.relatedTarget !== thumb) delete frame.dataset[spec.hover];
    }) as EventListener;
    listen(track, 'pointermove', hover);
    listen(thumb, 'pointermove', hover);
    listen(track, 'pointerleave', leave);
    listen(thumb, 'pointerleave', leave);
    listen(thumb, 'pointerdown', ((event: PointerEvent) => {
      if (event.button !== 0 || !enabled(elements) || frame.dataset[spec.scrollable] !== 'true') return;
      const { max, travel } = geometry(elements);
      event.preventDefault();
      event.stopPropagation();
      thumb.setPointerCapture(event.pointerId);
      clearHide();
      frame.dataset[spec.dragging] = 'true';
      frame.dataset.scrolling = 'true';
      drag = { elements, pointerId: event.pointerId, pointer: event[spec.pointer], scroll: scroller[spec.offset], max, travel: Math.max(1, travel) };
    }) as EventListener);
    listen(thumb, 'pointermove', ((event: PointerEvent) => {
      if (!drag || drag.elements !== elements || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      scroller[spec.offset] = Math.max(0, Math.min(drag.max, drag.scroll + (event[spec.pointer] - drag.pointer) / drag.travel * drag.max));
      update({ schedule: false });
    }) as EventListener);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(thumb, type, finishDrag as EventListener);
  }
  listen(scroller, 'scroll', () => {
    const userInitiated = Date.now() <= userIntentUntil;
    schedule({ reveal: userInitiated, schedule: userInitiated });
  });
  listen(scroller, 'wheel', markIntent, { passive: true });
  listen(scroller, 'touchmove', markIntent, { passive: true });
  listen(scroller, 'keydown', ((event: KeyboardEvent) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markIntent();
  }) as EventListener);
  listen(frame, 'pointerleave', clearHover);
  listen(doc, 'scroll', ((event: Event) => {
    const target = event.target;
    if (target instanceof win.Node && target !== scroller && target.contains(frame)) clearHover();
  }), true);
  listen(win, 'resize', quietUpdate);
  listen(frame, 'wheel', ((event: WheelEvent) => {
    if (event.target instanceof win.Node && scroller.contains(event.target)) return;
    const styles = win.getComputedStyle(scroller);
    const shiftToHorizontal = event.shiftKey && !event.deltaX
      && axes.some(({ axis }) => axis === 'horizontal')
      && styles.overflowX !== 'hidden' && styles.overflowX !== 'clip';
    let forwarded = false;
    for (const elements of axes) {
      const { axis, spec } = elements;
      if (styles[spec.overflow] === 'hidden' || styles[spec.overflow] === 'clip') continue;
      const delta = axis === 'vertical' ? (shiftToHorizontal ? 0 : event.deltaY) : event.deltaX || (shiftToHorizontal ? event.deltaY : 0);
      if (!delta) continue;
      const unit = event.deltaMode === 1 ? Number.parseFloat(styles.lineHeight) || 16 : event.deltaMode === 2 ? scroller[spec.client] : 1;
      scroller[spec.offset] += delta * unit;
      forwarded = true;
    }
    if (!forwarded) return;
    event.preventDefault();
    markIntent();
    schedule();
  }) as EventListener, { passive: false });

  const resizeObserver = observeContent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(quietUpdate) : null;
  const observed = new Set<Element>();
  const observeSizes = () => {
    if (!resizeObserver) return;
    const next = new Set<Element>([scroller, ...scroller.children]);
    for (const element of observed) {
      if (!next.has(element)) { resizeObserver.unobserve(element); observed.delete(element); }
    }
    for (const element of next) {
      if (!observed.has(element)) { resizeObserver.observe(element); observed.add(element); }
    }
  };
  const mutationObserver = observeContent && typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => { observeSizes(); quietUpdate(); }) : null;
  mutationObserver?.observe(scroller, { childList: true, characterData: true, subtree: true });
  if (observeContent) {
    observeSizes();
    listen(scroller, 'load', quietUpdate, true);
  }
  update({ reveal: false, schedule: false });

  return {
    update,
    schedule,
    destroy: () => {
      if (disposed) return;
      disposed = true;
      clearHide();
      if (measurement !== null) win.cancelAnimationFrame(measurement);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      removers.forEach((remove) => remove());
      if (drag) {
        const { elements, pointerId } = drag;
        drag = null;
        try { elements.thumb.releasePointerCapture(pointerId); } catch { /* Detached thumb. */ }
      }
      clearHover();
      delete frame.dataset.scrolling;
      delete frame.dataset.dragging;
      delete frame.dataset.horizontalDragging;
    },
  };
}
