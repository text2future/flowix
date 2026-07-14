export interface AnchoredPopoverControllerOptions {
  isOpen: () => boolean;
  isDestroyed: () => boolean;
  isHidden: () => boolean;
  position: () => void;
  observe?: () => Array<Element | null | undefined>;
}

export interface AnchoredPopoverController {
  start(): void;
  stop(): void;
  schedule(): void;
  dispose(): void;
}

export function createAnchoredPopoverController(
  options: AnchoredPopoverControllerOptions
): AnchoredPopoverController {
  let resizeObserver: ResizeObserver | null = null;
  let frame: number | null = null;

  const schedule = (): void => {
    if (!options.isOpen() || options.isHidden() || options.isDestroyed()) return;
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      options.position();
    });
  };

  const handleViewportChange = (): void => {
    schedule();
  };

  const stop = (): void => {
    window.removeEventListener('resize', handleViewportChange);
    window.removeEventListener('scroll', handleViewportChange, true);
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
  };

  const start = (): void => {
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    if ('ResizeObserver' in window) {
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => schedule());
      for (const element of options.observe?.() ?? []) {
        if (element) resizeObserver.observe(element);
      }
    }
  };

  return {
    start,
    stop,
    schedule,
    dispose: stop,
  };
}
