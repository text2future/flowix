import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import type { AppLanguage, I18nKey } from "@/lib/i18n";
import type { AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { supportsAgentEmptySettings } from "@features/agent/runtime/agent-runtime-spec";
import {
  appendRenderedAgentMessagesToTail,
  createRenderedAgentMessageList,
  getRenderedAgentItems,
  isLastMessageInTurnAndAssistant,
  patchLastRenderedAgentMessage,
  shouldShowMessageActions,
  updateRenderedAgentToolGroups,
  type AgentThreadCardMessageRenderContext,
} from "@features/agent/thread-card/messages/message-list-renderer";
import {
  areAgentRenderItemsEqual,
  type AgentRenderItem,
} from "@features/agent/thread-card/messages/tool-grouping";
import { createAgentThreadCardMessageElement } from "@features/agent/thread-card/messages/message-item-renderer";
import { recordMessageRenderPlan } from "@features/agent/thread-card/messages/message-render-plan";
import { MIN_TRANSIENT_DISPLAY_DURATION_MS } from "@features/agent/thread-card/messages/transient-display";
import {
  MessageViewportController,
  type MessageRenderScrollOptions,
  type MessageRenderScrollState,
} from "@features/agent/thread-card/messages/message-viewport-controller";

type AgentMessage = ThreadState["messages"][number];

const PROGRESSIVE_RENDER_MESSAGE_THRESHOLD = 30;
const PROGRESSIVE_RENDER_CHUNK_SIZE = 8;

export interface ThreadMessageRenderControllerOptions {
  body: HTMLElement;
  loadingIndicator: HTMLDivElement;
  messageViewport: MessageViewportController;
  getLanguage: () => AppLanguage;
  getTypeKey: () => AgentTypeKey;
  t: (key: I18nKey) => string;
  createThreadCacheSkeleton: () => HTMLDivElement;
  createExternalAgentEmptySettings: () => HTMLElement;
  onForkMessage?: (message: AgentMessage) => void | Promise<void>;
}

export interface ThreadMessageRenderInput {
  messages: ThreadState["messages"];
  isLoading: boolean;
  shouldRenderMessages: boolean;
  isInitialHistoryLoading?: boolean;
  isThreadCachePresentationHidden: boolean;
  isThreadCacheLoading: boolean;
}

export class ThreadMessageRenderController {
  private readonly body: HTMLElement;
  private readonly loadingIndicator: HTMLDivElement;
  private readonly messageViewport: MessageViewportController;
  private readonly getLanguage: () => AppLanguage;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly t: (key: I18nKey) => string;
  private readonly createThreadCacheSkeleton: () => HTMLDivElement;
  private readonly createExternalAgentEmptySettings: () => HTMLElement;
  private readonly onForkMessage?: (message: AgentMessage) => void | Promise<void>;
  private renderedMessagesList: HTMLDivElement | null = null;
  private renderedEmptyState: HTMLElement | null = null;
  private renderedMessageRefs: AgentRenderItem[] = [];
  private reasoningCollapsedOverrides = new Map<string, boolean>();
  private displayExpandedOverrides = new Map<string, boolean>();
  private toolGroupExpandedOverrides = new Map<string, boolean>();
  private renderRafId: number | null = null;
  private pendingRenderInput: ThreadMessageRenderInput | null = null;
  private progressiveRenderRafId: number | null = null;
  private progressiveRenderMessages: ThreadState["messages"] | null = null;
  private previousIsLoading = false;
  private loadingIndicatorShownAt: number | null = null;
  private loadingIndicatorHideTimer: number | null = null;
  private loadingIndicatorShouldShow = false;

  constructor(options: ThreadMessageRenderControllerOptions) {
    this.body = options.body;
    this.loadingIndicator = options.loadingIndicator;
    this.messageViewport = options.messageViewport;
    this.getLanguage = options.getLanguage;
    this.getTypeKey = options.getTypeKey;
    this.t = options.t;
    this.createThreadCacheSkeleton = options.createThreadCacheSkeleton;
    this.createExternalAgentEmptySettings =
      options.createExternalAgentEmptySettings;
    this.onForkMessage = options.onForkMessage;
  }

  render(input: ThreadMessageRenderInput): void {
    // 非流式态(空态/隐藏/完成)立即渲染, 不节流 ── 保证最终状态及时生效
    if (!input.isLoading || !input.shouldRenderMessages) {
      this.cancelPendingRender();
      this.renderNow(input);
      return;
    }
    // 流式中: rAF 合并(trailing edge)。claude text_delta 带 messageId 走
    // flushSync 绕过 streaming-buffer, 每个 Tauri 事件(已按字节 batch 的
    // token 组)都更新 canonical projection; 高 token 率下一帧多事件 -> 多次 patch-last DOM
    // 重建。rAF 合并把同帧内所有 render 调用收拢为帧末一次(渲染最新 input),
    // 降到每帧最多 1 次。
    // 延迟代价: 内容渲染推迟到下一帧(~16ms, 流式下不可察)。非流式态已走上面
    // 立即路径, 不受影响。不用时间阈值 ── jsdom 的 performance.now 不随 rAF
    // 前进, 时间阈值会让测试永远等不到渲染。
    this.pendingRenderInput = input;
    if (this.renderRafId != null) return;
    this.renderRafId = requestAnimationFrame(this.flushPendingRender);
  }

  private readonly flushPendingRender = (): void => {
    this.renderRafId = null;
    const next = this.pendingRenderInput;
    this.pendingRenderInput = null;
    if (next) this.renderNow(next);
  };

  private cancelPendingRender(): void {
    if (this.renderRafId != null) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }
    this.pendingRenderInput = null;
  }

  dispose(): void {
    this.cancelPendingRender();
    this.cancelProgressiveRender();
    // The standalone conversation detail can recreate this controller while
    // React reuses the same body element (for example during StrictMode
    // effect replay). Do not leave an owned placeholder behind for the next
    // controller instance, whose renderedEmptyState reference starts empty.
    this.removeRenderedEmptyState();
    if (this.loadingIndicatorHideTimer !== null) {
      window.clearTimeout(this.loadingIndicatorHideTimer);
      this.loadingIndicatorHideTimer = null;
    }
  }

  private renderNow(input: ThreadMessageRenderInput): void {
    const scrollState = this.messageViewport.captureRenderScrollState();
    const loadingJustEnded = this.previousIsLoading && !input.isLoading;
    this.previousIsLoading = input.isLoading;
    // 流式 Markdown 使用块级增量解析，空行等边界在流式期间可能被暂时
    // 切成多个 block。run 结束时只强制重解析末条消息的 content，既收敛
    // 到最终 Markdown 结构，又保留 message row、滚动位置和交互状态。
    this.renderLoadingIndicator(input.isLoading);

    if (this.shouldRenderProgressively(input)) {
      this.startProgressiveRender(input, scrollState);
      return;
    }
    this.cancelProgressiveRender();

    if (!input.shouldRenderMessages) {
      recordMessageRenderPlan("hidden", input.messages.length);
      this.body.replaceChildren();
      /*
       * body.replaceChildren() 会把 loadingIndicator 一起擦掉。下次切回可见
       * (shouldRenderMessages=true) 时, 第一次 render 走 insertBefore(list,
       * loadingIndicator) 要求 indicator 仍挂在 body 末尾, 否则 insertBefore
       * 会抛 NotFoundError。 在 hidden 期间把 indicator 重新挂回 (断开重连
       * 不可避免 — 这是一次状态切换, 视觉上用户刚展开卡片, 动画重新计时也合理)。
       */
      if (this.loadingIndicator.parentNode !== this.body) {
        this.body.appendChild(this.loadingIndicator);
      }
      this.renderedEmptyState = null;
      this.resetRenderedMessageCache();
      this.messageViewport.resetForHiddenMessages();
      return;
    }

    if (input.messages.length > 0) {
      this.removeRenderedEmptyState();
    }

    this.pruneReasoningCollapsedOverrides(input.messages);
    this.pruneDisplayExpandedOverrides(input.messages);
    this.pruneToolGroupExpandedOverrides(input.messages);

    if (this.canReuseRenderedMessages(input.messages, input.isLoading)) {
      if (loadingJustEnded) {
        const finalized = this.tryPatchLastRenderedMessage(
          input.messages,
          { isLoading: input.isLoading, ...scrollState },
          true,
        );
        recordMessageRenderPlan(
          finalized ? "patch-last" : "noop",
          input.messages.length,
        );
        return;
      }
      recordMessageRenderPlan("noop", input.messages.length);
      return;
    }

    if (
      this.tryUpdateRenderedToolGroups(input.messages, {
        isLoading: input.isLoading,
        ...scrollState,
      })
    ) {
      recordMessageRenderPlan("patch-last", input.messages.length);
      return;
    }

    if (
      this.tryPatchLastRenderedMessage(input.messages, {
        isLoading: input.isLoading,
        ...scrollState,
      })
    ) {
      recordMessageRenderPlan("patch-last", input.messages.length);
      return;
    }

    if (
      this.tryAppendMessagesToTail(input.messages, {
        isLoading: input.isLoading,
        ...scrollState,
      })
    ) {
      recordMessageRenderPlan("append-tail", input.messages.length);
      return;
    }

    if (input.messages.length === 0) {
      /*
       * 不调用 body.replaceChildren() — loadingIndicator 由 factory 持久挂
       * 在 body 末尾, replaceChildren 会把它也擦掉, 下次 render 还要重新挂,
       * WebKit 重连节点会重启 @keyframes 计时。 这里只移除旧 list (若有),
       * 走 renderEmptyState 用 insertBefore 放 empty 元素到 indicator 之前。
       */
      const prevList = this.renderedMessagesList;
      if (prevList && prevList.parentNode === this.body) {
        this.body.removeChild(prevList);
      }
      this.renderEmptyState(input);
      return;
    }

    recordMessageRenderPlan("replace-all", input.messages.length);
    const { list } = createRenderedAgentMessageList(
      input.messages,
      this.createMessageRenderContext(input.messages, input.isLoading),
    );

    /*
     * loadingIndicator 由 factory 一次性 append 到 body 末尾, 此后保持连接。
     * 这里仅 removeChild 旧 list 并 insertBefore 新 list —— 不把 indicator
     * 作为 replaceChildren / append 的参数, 避免 WebKit 重连节点导致
     * @keyframes 计时回到 t=0 (关键帧 0%/100% 是底色, 高频 streaming 下亮峰
     * 永远到不了)。
     */
    const prevList = this.renderedMessagesList;
    if (prevList && prevList.parentNode === this.body) {
      this.body.removeChild(prevList);
    }
    this.body.insertBefore(list, this.loadingIndicator);
    this.rememberRenderedMessages(
      list,
      getRenderedAgentItems(input.messages, input.isLoading),
    );
    this.applyBodyScrollAfterRender({
      isLoading: input.isLoading,
      ...scrollState,
    });
  }

  private shouldRenderProgressively(input: ThreadMessageRenderInput): boolean {
    if (input.isLoading || !input.shouldRenderMessages) return false;
    if (input.messages.length === 0) return false;
    if (this.canReuseRenderedMessages(input.messages, input.isLoading)) return false;
    // Progressive rendering is an initial-history optimization. Once a
    // message list is on screen, a completed turn or history reconcile must
    // keep that list mounted; removing it to show the skeleton causes a
    // one-frame flash after longer conversations.
    if (this.renderedMessagesList) return false;
    // The progressive path renders one top-level node per item. A tool group
    // owns several nested rows and must be built atomically by the full list
    // renderer to keep the cache's top-level indexes aligned.
    if (getRenderedAgentItems(input.messages, input.isLoading).some((item) => item.kind === "tool-group")) {
      return false;
    }
    return input.messages.length >= PROGRESSIVE_RENDER_MESSAGE_THRESHOLD;
  }

  private startProgressiveRender(
    input: ThreadMessageRenderInput,
    scrollState: MessageRenderScrollState,
  ): void {
    if (this.progressiveRenderMessages === input.messages) return;
    this.cancelProgressiveRender();
    this.progressiveRenderMessages = input.messages;

    const previousList = this.renderedMessagesList;
    if (previousList?.parentNode === this.body) previousList.remove();
    this.renderedMessagesList = null;
    this.renderedMessageRefs = [];
    this.removeRenderedEmptyState();

    const skeleton = this.createThreadCacheSkeleton();
    this.renderedEmptyState = skeleton;
    this.body.insertBefore(skeleton, this.loadingIndicator);
    this.messageViewport.resetForEmptyMessages();

    const renderedItems = getRenderedAgentItems(
      input.messages,
      input.isLoading,
    );
    const list = document.createElement("div");
    list.className = "agent-thread-card__messages";
    const context = this.createMessageRenderContext(input.messages, input.isLoading);
    let index = 0;

    const renderChunk = () => {
      this.progressiveRenderRafId = null;
      if (this.progressiveRenderMessages !== input.messages) return;

      const end = Math.min(index + PROGRESSIVE_RENDER_CHUNK_SIZE, renderedItems.length);
      for (; index < end; index += 1) {
        const renderItem = renderedItems[index];
        // A long historical list is normally static; groups are rendered by
        // the regular path so their nested DOM is created as one unit.
        if (renderItem.kind === "tool-group") continue;
        const message = renderItem.message;
        const rendered = createAgentThreadCardMessageElement({
          message,
          language: context.language,
          getReasoningCollapsed: context.getReasoningCollapsed,
          setReasoningCollapsed: context.setReasoningCollapsed,
          getDisplayExpanded: context.getDisplayExpanded,
          setDisplayExpanded: context.setDisplayExpanded,
          isStreaming: context.isStreaming(message),
          showActions: shouldShowMessageActions(
            message,
            input.messages,
            input.isLoading,
          ),
          canFork: isLastMessageInTurnAndAssistant(
            input.messages,
            input.messages.indexOf(message),
          ),
          onForkMessage: this.onForkMessage,
        });
        if (!rendered) continue;
        list.append(rendered.element);
      }

      if (index < renderedItems.length) {
        this.progressiveRenderRafId = requestAnimationFrame(renderChunk);
        return;
      }

      this.progressiveRenderMessages = null;
      this.removeRenderedEmptyState();
      this.body.insertBefore(list, this.loadingIndicator);
      this.rememberRenderedMessages(list, renderedItems);
      this.applyBodyScrollAfterRender({
        ...scrollState,
        isLoading: input.isLoading,
      });
    };

    // Always yield once so the selected item and skeleton can paint before
    // Markdown parsing and tool-row construction begin.
    this.progressiveRenderRafId = requestAnimationFrame(renderChunk);
  }

  private cancelProgressiveRender(): void {
    if (this.progressiveRenderRafId !== null) {
      cancelAnimationFrame(this.progressiveRenderRafId);
      this.progressiveRenderRafId = null;
    }
    this.progressiveRenderMessages = null;
  }

  private renderEmptyState(input: ThreadMessageRenderInput): void {
    recordMessageRenderPlan("replace-empty", input.messages.length);
    this.removeRenderedEmptyState();
    this.resetRenderedMessageCache();

    if (
      input.isInitialHistoryLoading ||
      input.isThreadCachePresentationHidden
    ) {
      const skeleton = this.createThreadCacheSkeleton();
      this.renderedEmptyState = skeleton;
      this.body.insertBefore(skeleton, this.loadingIndicator);
      this.messageViewport.resetForEmptyMessages();
      return;
    }

    const typeKey = this.getTypeKey();
    const empty =
      supportsAgentEmptySettings(typeKey) && !input.isThreadCacheLoading
        ? this.createExternalAgentEmptySettings()
        : document.createElement("div");
    if (!empty.classList.contains("agent-thread-card__empty")) {
      empty.className = "agent-thread-card__empty";
      empty.textContent = input.isThreadCacheLoading
        ? this.t("editor.threadCard.loadingThreadCache")
        : this.t("editor.threadCard.empty");
    }
    this.renderedEmptyState = empty;
    this.body.insertBefore(empty, this.loadingIndicator);
    this.messageViewport.resetForEmptyMessages();
  }

  private renderLoadingIndicator(isLoading: boolean): void {
    this.loadingIndicatorShouldShow = isLoading;
    if (isLoading) {
      if (this.loadingIndicatorHideTimer !== null) {
        window.clearTimeout(this.loadingIndicatorHideTimer);
        this.loadingIndicatorHideTimer = null;
      }
      this.loadingIndicatorShownAt ??= Date.now();
    }

    const loadingText = this.loadingIndicator.querySelector<HTMLSpanElement>(
      ".agent-thread-card__loading-text",
    );
    const loadingCells = this.loadingIndicator.querySelector<HTMLSpanElement>(
      ".agent-thread-card__loading-cells",
    );
    const setVisibility = (visible: boolean) => {
      if (loadingText) loadingText.hidden = !visible;
      if (loadingCells) loadingCells.hidden = !visible;
    };

    if (isLoading) {
      setVisibility(true);
      if (loadingText) {
        loadingText.textContent = getAgentType(this.getTypeKey()).capabilities
          .supportsTextStreaming
          ? this.t("editor.threadCard.thinking")
          : this.t("editor.threadCard.running");
      }
      return;
    }

    if (this.loadingIndicatorShownAt === null) {
      setVisibility(false);
      return;
    }

    const remaining = Math.max(
      0,
      MIN_TRANSIENT_DISPLAY_DURATION_MS -
        (Date.now() - this.loadingIndicatorShownAt),
    );
    if (remaining > 0) {
      setVisibility(true);
      if (this.loadingIndicatorHideTimer !== null) {
        window.clearTimeout(this.loadingIndicatorHideTimer);
      }
      this.loadingIndicatorHideTimer = window.setTimeout(() => {
        this.loadingIndicatorHideTimer = null;
        if (this.loadingIndicatorShouldShow) return;
        this.loadingIndicatorShownAt = null;
        setVisibility(false);
      }, remaining);
      return;
    }

    this.loadingIndicatorShownAt = null;
    setVisibility(false);
  }

  private removeRenderedEmptyState(): void {
    const emptyState = this.renderedEmptyState;
    this.renderedEmptyState = null;

    // Usually the reference above is enough. A controller can be recreated
    // against the same body, though, so also remove orphaned placeholders
    // from the previous controller. Keep the loading indicator and message
    // list untouched; both are owned by the current render path.
    for (const child of Array.from(this.body.children)) {
      if (!(child instanceof HTMLElement) || child === this.loadingIndicator) {
        continue;
      }
      if (
        child === emptyState ||
        child.classList.contains("agent-thread-card__empty") ||
        child.classList.contains("agent-thread-card__skeleton")
      ) {
        child.remove();
      }
    }
  }

  private resetRenderedMessageCache(): void {
    this.renderedMessagesList = null;
    this.renderedMessageRefs = [];
  }

  private rememberRenderedMessages(
    list: HTMLDivElement,
    messages: AgentRenderItem[],
  ): void {
    this.renderedMessagesList = list;
    this.renderedMessageRefs = messages;
  }

  private pruneToolGroupExpandedOverrides(
    messages: ThreadState["messages"],
  ): void {
    if (this.toolGroupExpandedOverrides.size === 0) return;
    const ids = new Set(
      getRenderedAgentItems(messages)
        .filter((item) => item.kind === "tool-group")
        .map((item) => item.id),
    );
    for (const id of this.toolGroupExpandedOverrides.keys()) {
      if (!ids.has(id)) this.toolGroupExpandedOverrides.delete(id);
    }
  }

  private pruneReasoningCollapsedOverrides(
    messages: ThreadState["messages"],
  ): void {
    if (this.reasoningCollapsedOverrides.size === 0) return;

    const visibleReasoningIds = new Set(
      messages
        .filter((message) => message.role === "reasoning")
        .map((message) => message.id),
    );

    for (const id of this.reasoningCollapsedOverrides.keys()) {
      if (!visibleReasoningIds.has(id)) {
        this.reasoningCollapsedOverrides.delete(id);
      }
    }
  }

  private pruneDisplayExpandedOverrides(
    messages: ThreadState["messages"],
  ): void {
    if (this.displayExpandedOverrides.size === 0) return;

    const visibleIds = new Set(messages.map((message) => message.id));

    for (const id of this.displayExpandedOverrides.keys()) {
      if (!visibleIds.has(id)) {
        this.displayExpandedOverrides.delete(id);
      }
    }
  }

  private getReasoningCollapsed(message: AgentMessage): boolean {
    return (
      this.reasoningCollapsedOverrides.get(message.id) ?? !!message.isCompleted
    );
  }

  private getDisplayExpanded(message: AgentMessage): boolean {
    return this.displayExpandedOverrides.get(message.id) ?? false;
  }

  private createMessageRenderContext(
    messages: ThreadState["messages"],
    isLoading: boolean,
  ): AgentThreadCardMessageRenderContext {
    // 流式态下只有末条消息在增长; 末条且未完成(isCompleted)的才走块级增量,
    // 其余(历史 / 已完成 / run 结束)走全量 re-parse 修正块切分。引用比较
    // message === lastMessage 依赖 store 侧保持非末条消息引用稳定。
    const lastMessage = messages[messages.length - 1];
    return {
      language: this.getLanguage(),
      isLoading,
      getReasoningCollapsed: (message) => this.getReasoningCollapsed(message),
      setReasoningCollapsed: (messageId, collapsed) => {
        this.reasoningCollapsedOverrides.set(messageId, collapsed);
      },
      getDisplayExpanded: (message) => this.getDisplayExpanded(message),
      setDisplayExpanded: (messageId, expanded) => {
        if (expanded) this.displayExpandedOverrides.set(messageId, true);
        else this.displayExpandedOverrides.delete(messageId);
      },
      getToolGroupExpanded: (groupId) =>
        this.toolGroupExpandedOverrides.get(groupId) ?? false,
      setToolGroupExpanded: (groupId, expanded) => {
        if (expanded) this.toolGroupExpandedOverrides.set(groupId, true);
        else this.toolGroupExpandedOverrides.delete(groupId);
      },
      isStreaming: (message) =>
        isLoading && message === lastMessage && !message.isCompleted,
      onForkMessage: this.onForkMessage,
    };
  }

  private canReuseRenderedMessages(
    messages: ThreadState["messages"],
    isLoading: boolean,
  ): boolean {
    const list = this.renderedMessagesList;
    if (!list || !this.body.contains(list)) return false;
    const renderedItems = getRenderedAgentItems(messages, isLoading);
    if (
      renderedItems.length !== this.renderedMessageRefs.length ||
      list.children.length !== renderedItems.length
    ) {
      return false;
    }
    for (let i = 0; i < renderedItems.length; i += 1) {
      if (!areAgentRenderItemsEqual(renderedItems[i], this.renderedMessageRefs[i])) {
        return false;
      }
    }
    return true;
  }

  private tryPatchLastRenderedMessage(
    messages: ThreadState["messages"],
    options: MessageRenderScrollOptions,
    force = false,
  ): boolean {
    const nextRefs = patchLastRenderedAgentMessage(messages, {
      body: this.body,
      cache: {
        list: this.renderedMessagesList,
        refs: this.renderedMessageRefs,
      },
      context: this.createMessageRenderContext(messages, options.isLoading),
      afterRender: () => this.applyBodyScrollAfterRender(options),
      force,
    });
    if (!nextRefs) return false;
    this.renderedMessageRefs = nextRefs;
    return true;
  }

  private tryUpdateRenderedToolGroups(
    messages: ThreadState["messages"],
    options: MessageRenderScrollOptions,
  ): boolean {
    const nextRefs = updateRenderedAgentToolGroups(messages, {
      body: this.body,
      cache: {
        list: this.renderedMessagesList,
        refs: this.renderedMessageRefs,
      },
      context: this.createMessageRenderContext(messages, options.isLoading),
      afterRender: () => this.applyBodyScrollAfterRender(options),
    });
    if (!nextRefs) return false;
    this.renderedMessageRefs = nextRefs;
    return true;
  }

  private tryAppendMessagesToTail(
    messages: ThreadState["messages"],
    options: MessageRenderScrollOptions,
  ): boolean {
    const nextRefs = appendRenderedAgentMessagesToTail(messages, {
      body: this.body,
      cache: {
        list: this.renderedMessagesList,
        refs: this.renderedMessageRefs,
      },
      context: this.createMessageRenderContext(messages, options.isLoading),
      afterRender: () => this.applyBodyScrollAfterRender(options),
    });
    if (!nextRefs) return false;
    this.renderedMessageRefs = nextRefs;
    return true;
  }

  private applyBodyScrollAfterRender(options: MessageRenderScrollOptions): void {
    this.messageViewport.applyAfterRender(options);
  }
}
