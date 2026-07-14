import type {
  AgentEvent,
  AgentTypeKey,
} from "@/types/agent";
import type {
  AgentConversationInstance,
  AgentConversationRun,
} from "@features/agent/store/agent-conversation-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";

type ConversationRunPatch = Partial<
  Omit<AgentConversationRun, "runId" | "startedAt">
>;

/**
 * 把 threadStates 里最新一次 run 的 usage / statusInfo / modelId / lastRunAt
 * 投影成 conversation.run 的增量 patch ── 让 conversation store 知道本轮
 * run 已经累计到哪个 token 数。 Nested usage 对象保持原样透传 (不再 flatten)。
 */
export function conversationUsagePatchFromState(
  st: ThreadState,
  runId: string,
): ConversationRunPatch | null {
  const run =
    st.runs[runId] ?? (st.lastRun?.runId === runId ? st.lastRun : undefined);
  if (
    !run?.usage &&
    !run?.statusInfo &&
    run?.modelId == null &&
    run?.lastRunAt == null
  ) {
    return null;
  }

  return {
    usage: run.usage,
    statusInfo: run.statusInfo,
    modelId: run.modelId,
    lastRunAt: run.lastRunAt,
  };
}

/**
 * 把一次 AgentEvent 同步到 conversation store (instance + run). 这是
 * conversation 的 "被动的写入" 入口 ── chat-store 是真源, conversation
 * 只做镜像; 反向 (conversation → chat) 由组件 selector 走, 不走这里。
 *
 * 行为:
 * - session_resolved: 通过 resolveSessionByThreadId 让 conversation 自己迁
 *   移 messageStates, instance 走 updateThread.
 * - stream_start: markRunStarted.
 * - stream_end: markRunEnded, 同时落 lastRunAt.
 * - tool_call / tool_result: updateRun(currentTool).
 * - error: markRunEnded(failed) + lastRunAt.
 * - usage: updateRun(usage / statusInfo).
 *
 * chat-store.threadStates 还没算完 (即 st 是空壳) 时不调用 markRunStarted ──
 * caller 应当确保 st 已经经过 ensureRunActive 补丁过。
 */
export function syncConversationInstanceForEvent(
  event: AgentEvent,
  st: ThreadState,
): void {
  const instanceStore = useAgentConversationStore.getState();
  const eventInstance =
    instanceStore.findByRunId(event.runId) ??
    instanceStore.findByThreadId(event.threadId);

  if (event.kind === "session_resolved" && event.sessionId) {
    instanceStore.resolveSessionByThreadId(
      event.threadId,
      event.sessionId,
      event.agentType,
    );
    return;
  }

  if (!eventInstance) return;

  switch (event.kind) {
    case "stream_start":
      instanceStore.markRunStarted(eventInstance.instanceId, {
        runId: event.runId,
        startedAt: event.timestamp,
        model: event.model,
        modelId: event.model,
        lastRunAt: event.timestamp,
        reasoningEffort: event.reasoningEffort,
      });
      break;
    case "stream_end":
      {
        const status =
          eventInstance.run?.status === "cancelled"
            ? "cancelled"
            : event.reason
              ? "failed"
              : "completed";
        const reason =
          status === "cancelled"
            ? event.reason ?? eventInstance.run?.reason ?? "cancelled"
            : event.reason;
        instanceStore.markRunEnded(
          eventInstance.instanceId,
          status,
          event.timestamp,
          reason,
        );
        instanceStore.updateRun(eventInstance.instanceId, {
          lastRunAt: event.timestamp,
        });
        break;
      }
    case "tool_call":
      instanceStore.updateRun(eventInstance.instanceId, {
        currentTool: event.name,
      });
      break;
    case "tool_result":
      instanceStore.updateRun(eventInstance.instanceId, {
        currentTool: null,
      });
      break;
    case "error":
      instanceStore.markRunEnded(
        eventInstance.instanceId,
        "failed",
        event.timestamp,
        event.message,
      );
      instanceStore.updateRun(eventInstance.instanceId, {
        lastRunAt: event.timestamp,
      });
      break;
    case "usage": {
      const patch = conversationUsagePatchFromState(st, event.runId);
      if (patch) instanceStore.updateRun(eventInstance.instanceId, patch);
      break;
    }
  }
}

/**
 * Ensure a conversation instance exists for `threadId`; return its id.
 *
 * When an instance for `threadId` already exists, the patch updates
 * agentType / title / threadId in place. Otherwise a new one is
 * created with `source: { kind: "thread-card" }` - `thread-card` is the
 * only remaining source discriminator (see `AgentConversationSource`).
 *
 * Used by `reconcileRunningRunsFromSnapshot` to backfill the status-bar
 * Agent runtime list from the backend running-threads snapshot.
 */
export function ensureConversationInstanceForThread(
  threadId: string,
  type: AgentTypeKey,
  title: string,
  runId?: string | null,
  options?: {
    /**
     * 标题保留判断用 ── 当 external agent 的当前 instance title 已是
     * 它的 "default title" (即传入的 title 也等于 default) 时, 不覆盖
     * instance 的 title。 调用方应传入 i18n'd default title。
     */
    defaultTitle?: string;
  },
): AgentConversationInstance {
  const instanceStore = useAgentConversationStore.getState();
  const existing =
    (runId ? instanceStore.findByRunId(runId) : null) ??
    instanceStore.findByThreadId(threadId);
  if (existing) {
    const shouldUpdateTitle =
      title &&
      (!isExternalAgentType(type) ||
        !options?.defaultTitle ||
        title !== options.defaultTitle);
    return instanceStore.upsertInstance(existing.instanceId, {
      agentType: type,
      ...(shouldUpdateTitle ? { title } : {}),
      threadId,
    });
  }
  return instanceStore.createInstance({
    agentType: type,
    title,
    threadId,
    source: { kind: "thread-card" },
    // reconcileRunningRunsFromSnapshot 走的是 "后端 running 列表 → 前端 instance"
    // 这条路径, 启动 race 时这条会先跑, 此时若不写 runtimeConfig, 后续
    // cwd 兜底链在 selectedNotebook 还没 hydrate 时全断. 同其它三处一致.
    runtimeConfig: buildInitialInstanceRuntimeConfig(type),
  });
}

function isExternalAgentType(type: AgentTypeKey): boolean {
  return type !== "flowix";
}
