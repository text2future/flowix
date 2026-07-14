import type { AgentTypeKey } from "@/types/agent";
import { loadAgentThreadCardCache } from "@features/editor/extensions/agent-thread-card/agent-thread-card-cache";

export interface ThreadCacheControllerOptions {
  element: HTMLElement;
  isDestroyed: () => boolean;
  getThreadId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  getMessageCount: () => number;
  shouldLoad: () => boolean;
  render: () => void;
  applyResolvedSession: (
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ) => void;
}

export class ThreadCacheController {
  private readonly element: HTMLElement;
  private readonly isDestroyed: () => boolean;
  private readonly getThreadId: () => string | null;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly getMessageCount: () => number;
  private readonly shouldLoad: () => boolean;
  private readonly render: () => void;
  private readonly applyResolvedSession: (
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ) => void;

  private loading = false;
  private loadedFor: string | null = null;
  private loadingFor: string | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private idleId: number | null = null;
  private settling = false;
  private revealFrame: number | null = null;
  private visibilityObserver: IntersectionObserver | null = null;
  private viewportReady =
    typeof window === "undefined" || !("IntersectionObserver" in window);

  constructor(options: ThreadCacheControllerOptions) {
    this.element = options.element;
    this.isDestroyed = options.isDestroyed;
    this.getThreadId = options.getThreadId;
    this.getTypeKey = options.getTypeKey;
    this.getMessageCount = options.getMessageCount;
    this.shouldLoad = options.shouldLoad;
    this.render = options.render;
    this.applyResolvedSession = options.applyResolvedSession;
  }

  get isLoading(): boolean {
    return this.loading;
  }

  isPresentationHidden(): boolean {
    return (
      !!this.getThreadId() &&
      this.getMessageCount() === 0 &&
      (this.loading || this.settling)
    );
  }

  requestIfNeeded(): void {
    if (this.shouldLoad()) {
      this.scheduleLoad();
      return;
    }
    this.cancelScheduledLoad();
  }

  observeVisibility(): void {
    if (
      this.viewportReady ||
      this.visibilityObserver ||
      typeof window === "undefined" ||
      !("IntersectionObserver" in window)
    ) {
      return;
    }

    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        if (this.isDestroyed() || !entries.some((entry) => entry.isIntersecting)) {
          return;
        }

        this.viewportReady = true;
        this.visibilityObserver?.disconnect();
        this.visibilityObserver = null;
        this.requestIfNeeded();
      },
      { root: null, rootMargin: "600px 0px", threshold: 0 },
    );
    this.visibilityObserver.observe(this.element);
  }

  canLoadForViewport(isFullscreen: boolean): boolean {
    return this.viewportReady || isFullscreen;
  }

  dispose(): void {
    this.cancelScheduledLoad();
    this.cancelRevealFrame();
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
  }

  private scheduleLoad(): void {
    const threadId = this.getThreadId();
    if (!threadId || this.isDestroyed() || !this.shouldLoad()) return;
    if (this.loadedFor === threadId || this.loadingFor === threadId) return;

    this.loadingFor = threadId;
    this.loading = true;
    this.settling = false;
    this.cancelRevealFrame();
    this.render();

    const run = async (): Promise<void> => {
      try {
        if (!this.isDestroyed() && this.getThreadId() === threadId) {
          const typeKey = this.getTypeKey();
          const result = await loadAgentThreadCardCache({ threadId, typeKey });
          if (result.resolvedSessionId) {
            this.applyResolvedSession(threadId, result.resolvedSessionId, typeKey);
            return;
          }
          this.loadedFor = threadId;
        }
      } finally {
        if (this.loadingFor === threadId) {
          this.loadingFor = null;
          this.loading = false;
        }
        if (!this.isDestroyed() && this.getThreadId() === threadId) {
          const hasLoadedMessages = this.getMessageCount() > 0;
          if (!hasLoadedMessages) {
            this.settling = false;
            this.render();
            return;
          }
          this.settling = true;
          this.render();
          this.cancelRevealFrame();
          this.revealFrame = window.requestAnimationFrame(() => {
            this.revealFrame = null;
            if (this.isDestroyed() || this.getThreadId() !== threadId) return;
            this.settling = false;
            this.render();
          });
        }
      }
    };

    if ("requestIdleCallback" in window) {
      this.idleId = window.requestIdleCallback(
        () => {
          this.idleId = null;
          void run();
        },
        { timeout: 1200 },
      );
    } else {
      this.timeoutId = globalThis.setTimeout(() => {
        this.timeoutId = null;
        void run();
      }, 300);
    }
  }

  private cancelScheduledLoad(): void {
    const hadScheduledLoad = this.timeoutId !== null || this.idleId !== null;
    if (this.timeoutId !== null) {
      globalThis.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.idleId !== null && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(this.idleId);
      this.idleId = null;
    }
    if (hadScheduledLoad && this.loadingFor) {
      this.loadingFor = null;
      this.loading = false;
      this.settling = false;
      this.render();
    }
  }

  private cancelRevealFrame(): void {
    if (this.revealFrame === null) return;
    window.cancelAnimationFrame(this.revealFrame);
    this.revealFrame = null;
  }
}
