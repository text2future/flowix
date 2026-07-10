const MIN_THUMB_HEIGHT_PX = 24;

export function attachAccessPopoverScrollbar(
  scroller: HTMLElement,
): () => void {
  const frame = scroller.parentElement;
  if (!frame || !frame.classList.contains("overlay-scrollbar-frame")) {
    return () => {};
  }
  const thumb = frame.querySelector<HTMLDivElement>(
    ".overlay-scrollbar-thumb",
  );
  if (!thumb) return () => {};

  let hideTimer: number | null = null;
  let dragState: {
    pointerId: number;
    startY: number;
    startScrollTop: number;
    maxScrollTop: number;
    thumbTravel: number;
  } | null = null;

  const clearHideTimer = (): void => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const scheduleHide = (): void => {
    clearHideTimer();
    hideTimer = window.setTimeout(() => {
      delete frame.dataset.scrolling;
      hideTimer = null;
    }, 600);
  };

  const sync = (reveal: boolean): void => {
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    const isScrollable = maxScrollTop > 1;
    frame.dataset.scrollable = String(isScrollable);
    if (!isScrollable) {
      frame.style.removeProperty("--overlay-scrollbar-thumb-height");
      frame.style.removeProperty("--overlay-scrollbar-thumb-top");
      return;
    }
    const thumbHeight = Math.max(
      MIN_THUMB_HEIGHT_PX,
      Math.round(
        (scroller.clientHeight / scroller.scrollHeight) *
          scroller.clientHeight,
      ),
    );
    const thumbTravel = Math.max(0, scroller.clientHeight - thumbHeight);
    const thumbTop =
      thumbTravel > 0
        ? Math.round((scroller.scrollTop / maxScrollTop) * thumbTravel)
        : 0;
    frame.style.setProperty(
      "--overlay-scrollbar-thumb-height",
      `${thumbHeight}px`,
    );
    frame.style.setProperty("--overlay-scrollbar-thumb-top", `${thumbTop}px`);
    if (reveal) {
      frame.dataset.scrolling = "true";
    }
    scheduleHide();
  };

  const handleScroll = (): void => {
    sync(true);
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (frame.dataset.scrollable !== "true") return;
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    const thumbHeight = Math.max(
      MIN_THUMB_HEIGHT_PX,
      Math.round(
        (scroller.clientHeight / scroller.scrollHeight) *
          scroller.clientHeight,
      ),
    );
    const thumbTravel = Math.max(1, scroller.clientHeight - thumbHeight);
    event.preventDefault();
    event.stopPropagation();
    thumb.setPointerCapture(event.pointerId);
    clearHideTimer();
    frame.dataset.dragging = "true";
    frame.dataset.scrolling = "true";
    dragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scroller.scrollTop,
      maxScrollTop,
      thumbTravel,
    };
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const scrollDelta =
      ((event.clientY - dragState.startY) / dragState.thumbTravel) *
      dragState.maxScrollTop;
    scroller.scrollTop = Math.max(
      0,
      Math.min(dragState.startScrollTop + scrollDelta, dragState.maxScrollTop),
    );
    sync(true);
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    dragState = null;
    delete frame.dataset.dragging;
    try {
      thumb.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
    sync(true);
  };

  const handleWindowResize = (): void => {
    sync(false);
  };

  scroller.addEventListener("scroll", handleScroll, { passive: true });
  thumb.addEventListener("pointerdown", handlePointerDown);
  thumb.addEventListener("pointermove", handlePointerMove);
  thumb.addEventListener("pointerup", handlePointerUp);
  thumb.addEventListener("pointercancel", handlePointerUp);
  window.addEventListener("resize", handleWindowResize);

  requestAnimationFrame(() => {
    if (!frame.isConnected) return;
    sync(true);
  });

  return (): void => {
    scroller.removeEventListener("scroll", handleScroll);
    thumb.removeEventListener("pointerdown", handlePointerDown);
    thumb.removeEventListener("pointermove", handlePointerMove);
    thumb.removeEventListener("pointerup", handlePointerUp);
    thumb.removeEventListener("pointercancel", handlePointerUp);
    window.removeEventListener("resize", handleWindowResize);
    clearHideTimer();
    dragState = null;
  };
}
