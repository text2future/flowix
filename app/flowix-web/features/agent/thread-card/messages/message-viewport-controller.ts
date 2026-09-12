export interface ConversationMessageStateSnapshot {
  loadingMore: boolean;
  hasMoreHistory: boolean;
  oldestSequence: number | null;
}

export interface MessageViewportControllerOptions {
  body: HTMLElement;
  bottomFollowThresholdPx: number;
  topHistoryLoadThresholdPx: number;
  scrollDeltaEpsilonPx: number;
  isCollapsed: () => boolean;
  isFullscreen: () => boolean;
  getRuntimeThreadId: () => string | null;
  getConversationMessageState: () => ConversationMessageStateSnapshot | null;
  loadMoreMessages: (threadId: string) => void;
}

export interface MessageRenderScrollState {
  previousScrollTop: number;
  shouldFollowStreaming: boolean;
}

export interface MessageRenderScrollOptions extends MessageRenderScrollState {
  isLoading: boolean;
}

export class MessageViewportController {
  private readonly body: HTMLElement;
  private readonly bottomFollowThresholdPx: number;
  private readonly topHistoryLoadThresholdPx: number;
  private readonly scrollDeltaEpsilonPx: number;
  private readonly isCollapsed: () => boolean;
  private readonly isFullscreen: () => boolean;
  private readonly getRuntimeThreadId: () => string | null;
  private readonly getConversationMessageState: () => ConversationMessageStateSnapshot | null;
  private readonly loadMoreMessages: (threadId: string) => void;

  private prevCollapsed = false;
  private shouldFollowBottom = true;
  private userDetachedFromBottom = false;
  private pendingHistoryScrollRestore: {
    threadId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null = null;

  constructor(options: MessageViewportControllerOptions) {
    this.body = options.body;
    this.bottomFollowThresholdPx = options.bottomFollowThresholdPx;
    this.topHistoryLoadThresholdPx = options.topHistoryLoadThresholdPx;
    this.scrollDeltaEpsilonPx = options.scrollDeltaEpsilonPx;
    this.isCollapsed = options.isCollapsed;
    this.isFullscreen = options.isFullscreen;
    this.getRuntimeThreadId = options.getRuntimeThreadId;
    this.getConversationMessageState = options.getConversationMessageState;
    this.loadMoreMessages = options.loadMoreMessages;
  }

  handleScroll(): void {
    if (this.userDetachedFromBottom) {
      // Keep an explicit upward gesture detached even if the first scroll
      // event arrives before scrollTop has moved outside the follow margin.
      // Only reaching the actual bottom re-arms automatic following.
      if (this.getBottomDistance() <= this.scrollDeltaEpsilonPx) {
        this.userDetachedFromBottom = false;
        this.shouldFollowBottom = true;
      } else {
        this.shouldFollowBottom = false;
      }
    } else {
      this.shouldFollowBottom = this.isNearBottom();
    }
    this.requestMoreHistoryIfNeeded();
  }

  /**
   * Records explicit upward scrolling before the browser dispatches the
   * resulting scroll event. This is intentionally separate from
   * handleScroll(): scroll events can be caused by our own scrollTop writes,
   * while a wheel-up event is unambiguously user intent.
   */
  handleUserScrollIntent(deltaY: number): void {
    if (deltaY < 0) {
      this.userDetachedFromBottom = true;
      this.shouldFollowBottom = false;
    }
  }

  captureRenderScrollState(): MessageRenderScrollState {
    // 流式跟随态(shouldFollowBottom=true)下 previousScrollTop 与
    // wasNearBottom 都不会被消费 ── applyAfterRender 走 scrollToBottom 而非
    // preserveScrollTop。跳过这两次 layout 读取, 避免流式期间每帧触发同步
    // reflow(body.scrollTop / scrollHeight 读取会强制全 body layout)。
    if (this.shouldFollowBottom) {
      return { previousScrollTop: 0, shouldFollowStreaming: true };
    }
    return {
      previousScrollTop: this.body.scrollTop,
      // This is the latched follow decision, not a fresh distance check.
      // A user gesture may have detached us while the viewport is still
      // inside the bottom margin.
      shouldFollowStreaming: this.shouldFollowBottom,
    };
  }

  resetForHiddenMessages(): void {
    this.userDetachedFromBottom = false;
    this.shouldFollowBottom = true;
  }

  resetForEmptyMessages(): void {
    this.userDetachedFromBottom = false;
    this.shouldFollowBottom = true;
  }

  applyAfterRender(options: MessageRenderScrollOptions): void {
    if (this.restoreAfterHistoryPrepend()) return;

    if (this.isCollapsed()) {
      this.prevCollapsed = this.isCollapsed();
      return;
    }

    if (options.isLoading) {
      if (options.shouldFollowStreaming) {
        this.scrollToBottom();
      } else {
        this.preserveScrollTop(options.previousScrollTop);
      }
    } else if (this.prevCollapsed) {
      this.body.scrollTop = 0;
      this.shouldFollowBottom = this.isNearBottom();
    } else if (options.shouldFollowStreaming) {
      // Keep following only when the user was already following the bottom.
      // If they scrolled up while the response was streaming, preserve that
      // reading position when the run-end render finalizes the last message.
      this.scrollToBottom();
    } else {
      this.preserveScrollTop(options.previousScrollTop);
    }

    this.prevCollapsed = this.isCollapsed();
  }

  scrollToBottom(forceFollow = true): void {
    // 写 scrollHeight(浏览器 clamp 到 scrollHeight - clientHeight = 底部)。
    // 注意: 不能用 Number.MAX_SAFE_INTEGER 依赖浏览器 clamp ── WebKit 的
    // 滚动内部精度(LayoutUnit)无法表示 2^53 那么大的值, 大概率被截断成 0,
    // 反而把列表留在顶部(每次 DOM 重建后 scrollTop 被重置为 0, scrollToBottom
    // 又没真正生效)。读 scrollHeight 确实触发一次 layout, 但这一帧本来就要
    // 因 innerHTML 写入而 layout, 不额外增加 thrashing; 真正的 reflow 收益在
    // captureRenderScrollState 跟随态跳过两次 layout 读取。
    this.body.scrollTop = this.body.scrollHeight;
    if (forceFollow) {
      this.userDetachedFromBottom = false;
      this.shouldFollowBottom = true;
    }
  }

  private getBottomDistance(): number {
    return Math.max(
      0,
      this.body.scrollHeight - this.body.clientHeight - this.body.scrollTop,
    );
  }

  private isNearBottom(): boolean {
    return this.getBottomDistance() <= this.bottomFollowThresholdPx;
  }

  private preserveScrollTop(scrollTop: number): void {
    this.body.scrollTop = scrollTop;
    this.shouldFollowBottom = this.userDetachedFromBottom
      ? false
      : this.isNearBottom();
  }

  private requestMoreHistoryIfNeeded(): void {
    if (this.isCollapsed() && !this.isFullscreen()) return;
    if (this.body.scrollTop > this.topHistoryLoadThresholdPx) return;

    const threadId = this.getRuntimeThreadId();
    if (!threadId) return;

    const state = this.getConversationMessageState();
    if (
      !state ||
      state.loadingMore ||
      !state.hasMoreHistory ||
      state.oldestSequence === null
    ) {
      return;
    }

    this.pendingHistoryScrollRestore = {
      threadId,
      scrollHeight: this.body.scrollHeight,
      scrollTop: this.body.scrollTop,
    };
    this.loadMoreMessages(threadId);
  }

  private restoreAfterHistoryPrepend(): boolean {
    const snapshot = this.pendingHistoryScrollRestore;
    if (!snapshot) {
      return false;
    }
    if (snapshot.threadId !== this.getRuntimeThreadId()) {
      this.pendingHistoryScrollRestore = null;
      return false;
    }

    const nextScrollHeight = this.body.scrollHeight;
    const delta = nextScrollHeight - snapshot.scrollHeight;
    if (delta > this.scrollDeltaEpsilonPx) {
      this.body.scrollTop = snapshot.scrollTop + delta;
      this.shouldFollowBottom = false;
      this.pendingHistoryScrollRestore = null;
      return true;
    }

    this.body.scrollTop = snapshot.scrollTop;
    this.shouldFollowBottom = false;
    if (!this.getConversationMessageState()?.loadingMore) {
      this.pendingHistoryScrollRestore = null;
    }
    return true;
  }
}
