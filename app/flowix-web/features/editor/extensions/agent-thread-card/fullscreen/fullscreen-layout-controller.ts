import type { ScrollSnapshot } from "@features/editor/extensions/agent-thread-card/agent-thread-card-dom";
import {
  adjustEditorScrollToCardTop,
  captureAgentThreadCardScrollSnapshot,
  clearAgentThreadCardFullscreenBounds,
  getAgentThreadCardEditorScrollContainer,
  getAgentThreadCardFullscreenContainer,
  getFullscreenExitFallbackTop,
  restoreAgentThreadCardScrollSnapshotAfterFocusChange,
  syncAgentThreadCardFullscreenBounds,
} from "@features/editor/extensions/agent-thread-card/fullscreen/fullscreen-scroll";

export interface FullscreenLayoutControllerOptions {
  dom: HTMLElement;
  isFullscreen: () => boolean;
  isDestroyed: () => boolean;
  getTitlebarHeight: () => number;
  minExitTopPx: number;
  maxExitTopPx: number;
  exitTopRatio: number;
  scrollDeltaEpsilonPx: number;
}

export class FullscreenLayoutController {
  private readonly dom: HTMLElement;
  private readonly isFullscreen: () => boolean;
  private readonly isDestroyed: () => boolean;
  private readonly getTitlebarHeight: () => number;
  private readonly minExitTopPx: number;
  private readonly maxExitTopPx: number;
  private readonly exitTopRatio: number;
  private readonly scrollDeltaEpsilonPx: number;

  private container: HTMLElement | null = null;
  private returnAnchor: {
    scrollContainer: HTMLElement;
    topWithinContainer: number;
  } | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: FullscreenLayoutControllerOptions) {
    this.dom = options.dom;
    this.isFullscreen = options.isFullscreen;
    this.isDestroyed = options.isDestroyed;
    this.getTitlebarHeight = options.getTitlebarHeight;
    this.minExitTopPx = options.minExitTopPx;
    this.maxExitTopPx = options.maxExitTopPx;
    this.exitTopRatio = options.exitTopRatio;
    this.scrollDeltaEpsilonPx = options.scrollDeltaEpsilonPx;
  }

  enter(): void {
    this.container = this.getFullscreenContainer();
    this.syncBounds();
    this.observeContainer();
    window.addEventListener("resize", this.boundSyncBounds);
    window.requestAnimationFrame(() => this.syncBounds());
  }

  exit(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.container = null;
    window.removeEventListener("resize", this.boundSyncBounds);
    this.clearBounds();
    this.restoreReturnAnchor();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.boundSyncBounds);
    this.clearBounds();
    this.returnAnchor = null;
    this.container = null;
  }

  captureReturnAnchor(): void {
    const scrollContainer = this.getEditorScrollContainer();
    if (!scrollContainer) {
      this.returnAnchor = null;
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const cardRect = this.dom.getBoundingClientRect();
    this.returnAnchor = {
      scrollContainer,
      topWithinContainer: cardRect.top - containerRect.top,
    };
  }

  captureScrollSnapshot(): ScrollSnapshot {
    return captureAgentThreadCardScrollSnapshot(this.getEditorScrollContainer());
  }

  restoreScrollSnapshotAfterFocusChange(snapshot: ScrollSnapshot): void {
    restoreAgentThreadCardScrollSnapshotAfterFocusChange(snapshot);
  }

  getEditorScrollContainer(): HTMLElement | null {
    return getAgentThreadCardEditorScrollContainer(this.dom);
  }

  syncBounds(): void {
    if (!this.isFullscreen()) return;
    const container = this.container ?? this.getFullscreenContainer();
    if (!container) return;
    this.container = container;
    syncAgentThreadCardFullscreenBounds({
      dom: this.dom,
      container,
      titlebarHeight: this.getTitlebarHeight(),
    });
  }

  private readonly boundSyncBounds = (): void => {
    this.syncBounds();
  };

  private getFullscreenContainer(): HTMLElement | null {
    return getAgentThreadCardFullscreenContainer(this.dom);
  }

  private observeContainer(): void {
    this.resizeObserver?.disconnect();
    if (!this.container || !("ResizeObserver" in window)) return;

    this.resizeObserver = new ResizeObserver(() => {
      this.syncBounds();
    });
    this.resizeObserver.observe(this.container);
  }

  private clearBounds(): void {
    clearAgentThreadCardFullscreenBounds(this.dom);
  }

  private restoreReturnAnchor(): void {
    const anchor = this.returnAnchor;
    this.returnAnchor = null;

    window.requestAnimationFrame(() => {
      if (this.isDestroyed() || this.isFullscreen()) return;
      if (!anchor || !anchor.scrollContainer.isConnected || !this.dom.isConnected) {
        this.scrollCardToExitFallbackPosition();
        return;
      }

      const scrollContainer = anchor.scrollContainer;

      const containerRect = scrollContainer.getBoundingClientRect();
      const cardRect = this.dom.getBoundingClientRect();
      this.adjustEditorScrollToCardTop(
        scrollContainer,
        cardRect.top - containerRect.top,
        anchor.topWithinContainer,
      );
    });
  }

  private scrollCardToExitFallbackPosition(): void {
    const scrollContainer = this.getEditorScrollContainer();
    if (!scrollContainer || !scrollContainer.isConnected || !this.dom.isConnected)
      return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const cardRect = this.dom.getBoundingClientRect();
    const targetTop = getFullscreenExitFallbackTop({
      containerHeight: containerRect.height,
      minTopPx: this.minExitTopPx,
      maxTopPx: this.maxExitTopPx,
      topRatio: this.exitTopRatio,
    });
    this.adjustEditorScrollToCardTop(
      scrollContainer,
      cardRect.top - containerRect.top,
      targetTop,
    );
  }

  private adjustEditorScrollToCardTop(
    scrollContainer: HTMLElement,
    currentTopWithinContainer: number,
    targetTopWithinContainer: number,
  ): void {
    adjustEditorScrollToCardTop({
      scrollContainer,
      currentTopWithinContainer,
      targetTopWithinContainer,
      epsilonPx: this.scrollDeltaEpsilonPx,
    });
  }
}
