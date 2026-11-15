import { useCallback, useLayoutEffect, useRef } from 'react';
import { bindScrollbarController, type OverlayScrollbarSyncOptions, type ScrollbarController } from '@shared/lib/scrollbar-controller';

export type { OverlayScrollbarSyncOptions } from '@shared/lib/scrollbar-controller';

/** React owns the nodes; the shared controller owns input, observation and cleanup. */
export function useOverlayScrollbar(observeContent = false) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<{
    frame: HTMLDivElement;
    scroller: HTMLElement;
    observeContent: boolean;
    controller: ScrollbarController;
  } | null>(null);
  const controllerFor = useCallback((scroller: HTMLElement) => {
    const frame = frameRef.current;
    if (!frame) return null;
    const previous = bindingRef.current;
    if (!previous || previous.frame !== frame || previous.scroller !== scroller || previous.observeContent !== observeContent) {
      previous?.controller.destroy();
      bindingRef.current = { frame, scroller, observeContent, controller: bindScrollbarController(frame, scroller, { observeContent }) };
    }
    return bindingRef.current!.controller;
  }, [observeContent]);
  const updateOverlayScrollbar = useCallback((scroller: HTMLElement, options?: OverlayScrollbarSyncOptions) => {
    controllerFor(scroller)?.update(options);
  }, [controllerFor]);
  const scheduleOverlayScrollbar = useCallback((scroller: HTMLElement, options?: OverlayScrollbarSyncOptions) => {
    controllerFor(scroller)?.schedule(options);
  }, [controllerFor]);
  useLayoutEffect(() => () => {
    bindingRef.current?.controller.destroy();
    bindingRef.current = null;
  }, []);
  return { overlayScrollbarFrameRef: frameRef, updateOverlayScrollbar, scheduleOverlayScrollbar };
}
