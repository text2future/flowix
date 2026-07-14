import type { AgentTypeKey } from "@/types/agent";
import { useChatStore, type ThreadState } from "@features/agent/store/chat-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { useMemoStore } from "@features/memo";
import {
  isLocalExternalThreadId,
  resolveExternalSessionId,
} from "@features/agent/services/external-agent-runtime-service";

export interface AgentThreadCardSubscriptionsControllerOptions {
  getRuntimeThreadId: () => string | null;
  getRenderThreadId: () => string | null;
  getStoredThreadId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  getInstanceId: () => string | null;
  getResolvedSessionId: (threadId: string | null) => string | null | undefined;
  renderThreadState: () => void;
  refreshAttrs: () => void;
  refreshExternalAgentEmptySettings: () => void;
  isExternalSettingsOpen: () => boolean;
  renderCodexSettingsPopover: () => void;
  applyResolvedExternalSessionId: (
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ) => void;
  isAccessPopoverOpen: () => boolean;
  renderAccessPopover: () => void;
  syncRuntimeBadge: () => void;
}

type Unsubscribe = () => void;

export class AgentThreadCardSubscriptionsController {
  private readonly options: AgentThreadCardSubscriptionsControllerOptions;
  private unsubscribes: Unsubscribe[] = [];

  constructor(options: AgentThreadCardSubscriptionsControllerOptions) {
    this.options = options;
  }

  subscribe(): void {
    this.dispose();
    this.unsubscribes = [
      this.subscribeThreadState(),
      this.subscribeSettings(),
      this.subscribeConversation(),
      this.subscribeAccess(),
      this.subscribeRuntime(),
      this.subscribeNotebooks(),
    ];
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes = [];
  }

  private subscribeThreadState(): Unsubscribe {
    const options = this.options;
    return useChatStore.subscribe(
      (state) => {
        const threadId = options.getRuntimeThreadId();
        const renderThreadId = options.getRenderThreadId();
        const storedThreadId = options.getStoredThreadId();
        const resolvedSessionId =
          options.getResolvedSessionId(threadId) ??
          options.getResolvedSessionId(storedThreadId);
        const typeKey = options.getTypeKey();
        const localThreadId =
          threadId && isLocalExternalThreadId(threadId, typeKey)
            ? threadId
            : storedThreadId && isLocalExternalThreadId(storedThreadId, typeKey)
              ? storedThreadId
              : null;
        return {
          threadId,
          renderThreadId,
          nextThreadState: renderThreadId
            ? state.threadStates[renderThreadId]
            : undefined,
          resolvedSessionId,
          localThreadId,
        };
      },
      (next) => this.handleThreadStateChange(next),
      {
        equalityFn: (a, b) =>
          a.threadId === b.threadId &&
          a.renderThreadId === b.renderThreadId &&
          a.nextThreadState === b.nextThreadState &&
          a.resolvedSessionId === b.resolvedSessionId &&
          a.localThreadId === b.localThreadId,
      },
    );
  }

  private handleThreadStateChange(next: {
    threadId: string | null;
    nextThreadState: ThreadState | undefined;
    resolvedSessionId: string | null | undefined;
    localThreadId: string | null;
  }): void {
    const options = this.options;
    const typeKey = options.getTypeKey();
    options.renderThreadState();
    if (
      (typeKey === "codex" || typeKey === "claude") &&
      next.localThreadId &&
      next.resolvedSessionId
    ) {
      options.applyResolvedExternalSessionId(
        next.localThreadId,
        next.resolvedSessionId,
        typeKey,
      );
    } else if (
      (typeKey === "codex" || typeKey === "claude") &&
      next.threadId &&
      isLocalExternalThreadId(next.threadId, typeKey) &&
      next.nextThreadState &&
      !next.nextThreadState.isLoading &&
      !next.nextThreadState.activeRunId
    ) {
      const localThreadId = next.threadId;
      void resolveExternalSessionId(localThreadId, typeKey).then(
        (sessionId) => {
          if (sessionId && sessionId !== localThreadId) {
            options.applyResolvedExternalSessionId(
              localThreadId,
              sessionId,
              typeKey,
            );
          }
        },
      );
    }
  }

  private subscribeSettings(): Unsubscribe {
    const options = this.options;
    return useChatStore.subscribe(
      (state) => ({
        agentPermissionMode: state.agentPermissionMode,
        agentCodexModel: state.agentCodexModel,
        agentCodexReasoningEffort: state.agentCodexReasoningEffort,
      }),
      () => {
        options.refreshExternalAgentEmptySettings();
        if (options.isExternalSettingsOpen()) {
          options.renderCodexSettingsPopover();
        }
        if (options.isAccessPopoverOpen()) {
          options.renderAccessPopover();
        }
      },
      {
        equalityFn: (a, b) =>
          a.agentPermissionMode === b.agentPermissionMode &&
          a.agentCodexModel === b.agentCodexModel &&
          a.agentCodexReasoningEffort === b.agentCodexReasoningEffort,
      },
    );
  }

  private subscribeConversation(): Unsubscribe {
    const options = this.options;
    return useAgentConversationStore.subscribe(
      (state) => {
        const instanceId = options.getInstanceId();
        const threadId = options.getRenderThreadId();
        return {
          instance: instanceId ? state.instances[instanceId] : undefined,
          messageState: threadId ? state.messageStates[threadId] : undefined,
        };
      },
      (next, previous) => {
        if (next.instance !== previous.instance) {
          options.refreshAttrs();
          options.refreshExternalAgentEmptySettings();
          if (options.isExternalSettingsOpen()) {
            options.renderCodexSettingsPopover();
          }
          if (options.isAccessPopoverOpen()) {
            options.renderAccessPopover();
          }
        }
        options.renderThreadState();
      },
      {
        equalityFn: (a, b) =>
          a.instance === b.instance && a.messageState === b.messageState,
      },
    );
  }

  private subscribeAccess(): Unsubscribe {
    // 注意 ── 弹窗自身的重渲由 AccessPopoverController 在构造时订阅
    // useAgentAccessStore 完成 (见 access/access-popover-controller.ts),
    // 这里不再转发 renderAccessPopover, 避免双重 render。 这里只保留
    // 对外 (空 settings 区域) 的刷新, 那条仍然依赖外部 options 转发。
    return useAgentAccessStore.subscribe(() => {
      this.options.refreshExternalAgentEmptySettings();
    });
  }

  private subscribeRuntime(): Unsubscribe {
    return useAgentRuntimeStore.subscribe(() => {
      this.options.syncRuntimeBadge();
    });
  }

  private subscribeNotebooks(): Unsubscribe {
    const options = this.options;
    return useMemoStore.subscribe(() => {
      if (options.isAccessPopoverOpen()) options.renderAccessPopover();
    });
  }
}
