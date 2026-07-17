import type { AgentTypeKey } from "@/types/agent";
import type { AppLanguage, I18nKey } from "@features/i18n";
import type { ThreadState } from "@features/agent/store/chat-store";
import {
  MessageViewportController,
  type ConversationMessageStateSnapshot,
} from "@features/editor/extensions/agent-thread-card/messages/message-viewport-controller";
import { ThreadMessageRenderController } from "@features/editor/extensions/agent-thread-card/messages/thread-message-render-controller";
import { ThreadCacheController } from "@features/editor/extensions/agent-thread-card/messages/thread-cache-controller";

export interface AgentThreadCardMessagesControllerOptions {
  dom: HTMLElement;
  body: HTMLElement;
  loadingIndicator: HTMLDivElement;
  bottomFollowThresholdPx: number;
  topHistoryLoadThresholdPx: number;
  scrollDeltaEpsilonPx: number;
  isDestroyed: () => boolean;
  isCollapsed: () => boolean;
  isFullscreen: () => boolean;
  getThreadId: () => string | null;
  getRuntimeThreadId: () => string | null;
  getConversationMessageState: () => ConversationMessageStateSnapshot | null;
  loadMoreMessages: (threadId: string) => void;
  getLanguage: () => AppLanguage;
  getTypeKey: () => AgentTypeKey;
  getMessageCount: () => number;
  shouldLoadThreadMessages: () => boolean;
  renderThreadState: () => void;
  applyResolvedSession: (
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ) => void;
  t: (key: I18nKey) => string;
  createThreadCacheSkeleton: () => HTMLDivElement;
  createExternalAgentEmptySettings: () => HTMLElement;
}

export interface AgentThreadCardMessagesRenderInput {
  messages: ThreadState["messages"];
  isLoading: boolean;
  shouldRenderMessages: boolean;
}

export class AgentThreadCardMessagesController {
  private readonly viewport: MessageViewportController;
  private readonly renderer: ThreadMessageRenderController;
  private readonly cache: ThreadCacheController;

  constructor(options: AgentThreadCardMessagesControllerOptions) {
    this.viewport = new MessageViewportController({
      body: options.body,
      bottomFollowThresholdPx: options.bottomFollowThresholdPx,
      topHistoryLoadThresholdPx: options.topHistoryLoadThresholdPx,
      scrollDeltaEpsilonPx: options.scrollDeltaEpsilonPx,
      isCollapsed: options.isCollapsed,
      isFullscreen: options.isFullscreen,
      getRuntimeThreadId: options.getRuntimeThreadId,
      getConversationMessageState: options.getConversationMessageState,
      loadMoreMessages: options.loadMoreMessages,
    });
    this.renderer = new ThreadMessageRenderController({
      body: options.body,
      loadingIndicator: options.loadingIndicator,
      messageViewport: this.viewport,
      getLanguage: options.getLanguage,
      getTypeKey: options.getTypeKey,
      t: options.t,
      createThreadCacheSkeleton: options.createThreadCacheSkeleton,
      createExternalAgentEmptySettings: options.createExternalAgentEmptySettings,
    });
    this.cache = new ThreadCacheController({
      element: options.dom,
      isDestroyed: options.isDestroyed,
      getThreadId: options.getThreadId,
      getTypeKey: options.getTypeKey,
      getMessageCount: options.getMessageCount,
      shouldLoad: options.shouldLoadThreadMessages,
      render: options.renderThreadState,
      applyResolvedSession: options.applyResolvedSession,
    });
  }

  get isCacheLoading(): boolean {
    return this.cache.isLoading;
  }

  isCachePresentationHidden(): boolean {
    return this.cache.isPresentationHidden();
  }

  handleScroll(): void {
    this.viewport.handleScroll();
  }

  scrollToBottom(): void {
    this.viewport.scrollToBottom();
  }

  render(input: AgentThreadCardMessagesRenderInput): void {
    this.renderer.render({
      ...input,
      isThreadCachePresentationHidden: this.cache.isPresentationHidden(),
      isThreadCacheLoading: this.cache.isLoading,
    });
  }

  canLoadForViewport(isFullscreen: boolean): boolean {
    return this.cache.canLoadForViewport(isFullscreen);
  }

  requestIfNeeded(): void {
    this.cache.requestIfNeeded();
  }

  observeVisibility(): void {
    this.cache.observeVisibility();
  }

  dispose(): void {
    this.cache.dispose();
  }
}
