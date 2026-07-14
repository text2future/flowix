import type { AgentTypeKey } from "@/types/agent";
import { ThreadSessionController } from "@features/editor/extensions/agent-thread-card/runtime/thread-session-controller";
import { AgentThreadCardSubscriptionsController } from "@features/editor/extensions/agent-thread-card/runtime/thread-card-subscriptions-controller";

export interface AgentThreadCardRuntimeControllerOptions {
  getCurrentThreadId: () => string | null;
  getStoredThreadId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  getInstanceId: () => string | null;
  isDestroyed: () => boolean;
  updateConversationThread: (
    instanceId: string,
    update: { agentType: AgentTypeKey; threadId: string },
  ) => void;
  updateAttrs: (attrs: Record<string, unknown>) => void;
  renderThreadState: () => void;
  refreshAttrs: () => void;
  refreshExternalAgentEmptySettings: () => void;
  isExternalSettingsOpen: () => boolean;
  renderCodexSettingsPopover: () => void;
  isAccessPopoverOpen: () => boolean;
  renderAccessPopover: () => void;
  syncRuntimeBadge: () => void;
}

export class AgentThreadCardRuntimeController {
  private readonly session = new ThreadSessionController();
  private readonly subscriptions: AgentThreadCardSubscriptionsController;
  private readonly options: AgentThreadCardRuntimeControllerOptions;

  constructor(options: AgentThreadCardRuntimeControllerOptions) {
    this.options = options;
    this.subscriptions = new AgentThreadCardSubscriptionsController({
      getRuntimeThreadId: () => this.runtimeThreadId,
      getRenderThreadId: () => this.renderThreadId,
      getStoredThreadId: options.getStoredThreadId,
      getTypeKey: options.getTypeKey,
      getInstanceId: options.getInstanceId,
      getResolvedSessionId: (threadId) =>
        this.session.getResolvedSessionId(threadId),
      renderThreadState: options.renderThreadState,
      refreshAttrs: options.refreshAttrs,
      refreshExternalAgentEmptySettings:
        options.refreshExternalAgentEmptySettings,
      isExternalSettingsOpen: options.isExternalSettingsOpen,
      renderCodexSettingsPopover: options.renderCodexSettingsPopover,
      applyResolvedExternalSessionId: (threadId, sessionId, typeKey) => {
        this.applyResolvedSession(threadId, sessionId, typeKey);
      },
      isAccessPopoverOpen: options.isAccessPopoverOpen,
      renderAccessPopover: options.renderAccessPopover,
      syncRuntimeBadge: options.syncRuntimeBadge,
    });
  }

  get runtimeHandleId(): string {
    return this.session.runtimeHandleId;
  }

  get runtimeThreadId(): string | null {
    return this.session.getRuntimeThreadId(this.options.getCurrentThreadId());
  }

  get renderThreadId(): string | null {
    return this.session.getRenderThreadId(this.options.getCurrentThreadId());
  }

  subscribe(): void {
    this.subscriptions.subscribe();
  }

  applyResolvedSession(
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ): void {
    this.session.applyResolvedSession({
      threadId,
      sessionId,
      typeKey,
      currentThreadId: this.options.getCurrentThreadId(),
      storedThreadId: this.options.getStoredThreadId(),
      isDestroyed: this.options.isDestroyed(),
      instanceId: this.options.getInstanceId(),
      updateConversationThread: this.options.updateConversationThread,
      updateAttrs: this.options.updateAttrs,
    });
  }

  dispose(): void {
    this.subscriptions.dispose();
  }
}
