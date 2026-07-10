import type { ScrollSnapshot } from "@features/editor/extensions/agent-thread-card/agent-thread-card-dom";

export function getAgentThreadCardFullscreenContainer(
  dom: HTMLElement,
): HTMLElement | null {
  const container = dom.closest(".document-container");
  return container instanceof HTMLElement ? container : null;
}

export function getAgentThreadCardEditorScrollContainer(
  dom: HTMLElement,
): HTMLElement | null {
  const container = dom.closest(".editor-content");
  return container instanceof HTMLElement ? container : null;
}

export function syncAgentThreadCardFullscreenBounds(options: {
  dom: HTMLElement;
  container: HTMLElement;
  titlebarHeight: number;
}): void {
  const { dom, container, titlebarHeight } = options;
  const rect = container.getBoundingClientRect();
  dom.style.setProperty("--atc-fullscreen-top", `${rect.top}px`);
  dom.style.setProperty("--atc-fullscreen-left", `${rect.left}px`);
  dom.style.setProperty("--atc-fullscreen-width", `${rect.width}px`);
  dom.style.setProperty("--atc-fullscreen-height", `${rect.height}px`);
  dom.style.setProperty("--atc-titlebar-height", `${titlebarHeight}px`);
}

export function clearAgentThreadCardFullscreenBounds(dom: HTMLElement): void {
  dom.style.removeProperty("--atc-fullscreen-top");
  dom.style.removeProperty("--atc-fullscreen-left");
  dom.style.removeProperty("--atc-fullscreen-width");
  dom.style.removeProperty("--atc-fullscreen-height");
  dom.style.removeProperty("--atc-titlebar-height");
}

export function captureAgentThreadCardScrollSnapshot(
  editorScrollContainer: HTMLElement | null,
): ScrollSnapshot {
  return {
    editorScrollContainer,
    editorScrollTop: editorScrollContainer?.scrollTop ?? 0,
    editorScrollLeft: editorScrollContainer?.scrollLeft ?? 0,
    windowScrollX: window.scrollX,
    windowScrollY: window.scrollY,
  };
}

export function restoreAgentThreadCardScrollSnapshot(
  snapshot: ScrollSnapshot,
): void {
  if (snapshot.editorScrollContainer?.isConnected) {
    snapshot.editorScrollContainer.scrollTop = snapshot.editorScrollTop;
    snapshot.editorScrollContainer.scrollLeft = snapshot.editorScrollLeft;
  }
  window.scrollTo(snapshot.windowScrollX, snapshot.windowScrollY);
}

export function restoreAgentThreadCardScrollSnapshotAfterFocusChange(
  snapshot: ScrollSnapshot,
): void {
  restoreAgentThreadCardScrollSnapshot(snapshot);
  window.requestAnimationFrame(() => {
    restoreAgentThreadCardScrollSnapshot(snapshot);
    window.setTimeout(() => restoreAgentThreadCardScrollSnapshot(snapshot), 0);
  });
}

export function adjustEditorScrollToCardTop(options: {
  scrollContainer: HTMLElement;
  currentTopWithinContainer: number;
  targetTopWithinContainer: number;
  epsilonPx: number;
}): void {
  const {
    scrollContainer,
    currentTopWithinContainer,
    targetTopWithinContainer,
    epsilonPx,
  } = options;
  const delta = currentTopWithinContainer - targetTopWithinContainer;

  if (Number.isFinite(delta) && Math.abs(delta) > epsilonPx) {
    scrollContainer.scrollTop += delta;
  }
}

export function getFullscreenExitFallbackTop(options: {
  containerHeight: number;
  minTopPx: number;
  maxTopPx: number;
  topRatio: number;
}): number {
  const { containerHeight, minTopPx, maxTopPx, topRatio } = options;
  return Math.max(minTopPx, Math.min(containerHeight * topRatio, maxTopPx));
}
