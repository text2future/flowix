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
    this.shouldFollowBottom = this.isNearBottom();
    this.requestMoreHistoryIfNeeded();
  }

  captureRenderScrollState(): MessageRenderScrollState {
    const previousScrollTop = this.body.scrollTop;
    const wasNearBottom = this.isNearBottom();
    return {
      previousScrollTop,
      shouldFollowStreaming: this.shouldFollowBottom || wasNearBottom,
    };
  }

  resetForHiddenMessages(): void {
    this.shouldFollowBottom = true;
  }

  resetForEmptyMessages(): void {
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
    } else {
      this.scrollToBottom();
    }

    this.prevCollapsed = this.isCollapsed();
  }

  scrollToBottom(forceFollow = true): void {
    this.body.scrollTop = this.body.scrollHeight;
    if (forceFollow) {
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
    this.shouldFollowBottom = this.isNearBottom();
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
    if (!snapshot || snapshot.threadId !== this.getRuntimeThreadId()) {
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
