import { useEffect, useRef, useState } from 'react';

export interface BrowserColumnAnimationState {
  /** True while the grid transition class is mounted and the transition is live. */
  running: boolean;
  /**
   * True only on the render commit that receives a visibility toggle from
   * steady state. The caller pins the pre-toggle template in that same
   * commit; deriving the pinned phase inside an effect instead would paint
   * the end layout for a frame first, which reads as a jitter when expanding.
   */
  pinStart: boolean;
  /** Visibility the running transition is heading towards. */
  target: boolean;
  /** Visibility before the toggle; selects the pinned start template. */
  startVisible: boolean;
}

/** Sync with .document-columns-layout--animating in styles/index.css. */
export const BROWSER_COLUMN_ANIMATION_MS = 200;

/**
 * Tracks browser-column (column-2) visibility toggles driven from the work
 * column header and reports a short animation window per change, mirroring
 * the memo-list animation window in use-main-panel-controller.
 */
export function useBrowserColumnAnimation(
  browserColumnVisible: boolean,
  flushLayout?: () => void,
): BrowserColumnAnimationState {
  const [running, setRunning] = useState(false);
  const prevVisibleRef = useRef(browserColumnVisible);
  const doneTimerRef = useRef<number | null>(null);

  // Derived during render, not in an effect: the commit that receives the
  // toggle must already carry the pinned start template, otherwise one frame
  // flashes the end layout before the transition begins.
  const pinStart = prevVisibleRef.current !== browserColumnVisible && !running;

  useEffect(() => {
    if (prevVisibleRef.current === browserColumnVisible) return;
    prevVisibleRef.current = browserColumnVisible;
    // Flush the pinned start template into computed style so the transition
    // reliably starts from it even if this effect runs before first paint.
    flushLayout?.();
    setRunning(true);
    if (doneTimerRef.current !== null) window.clearTimeout(doneTimerRef.current);
    doneTimerRef.current = window.setTimeout(() => {
      doneTimerRef.current = null;
      setRunning(false);
    }, BROWSER_COLUMN_ANIMATION_MS);
  }, [browserColumnVisible, flushLayout]);

  useEffect(() => () => {
    if (doneTimerRef.current !== null) window.clearTimeout(doneTimerRef.current);
  }, []);

  return {
    running,
    pinStart,
    target: browserColumnVisible,
    startVisible: prevVisibleRef.current,
  };
}
