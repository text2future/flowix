import type { AgentEvent, AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import {
  applyErrorChunk,
  applyReasoningChunk,
  applyTextChunk,
} from "@features/agent/store/message-chunks";
import {
  applyToolCallChunk,
  applyToolResultChunk,
} from "@features/agent/store/tool-chunks";
import {
  applyRunEnded,
  applyRunFailed,
  applyRunStarted,
  applyRunUsage,
  applyRunToolState,
} from "@features/agent/store/run-lifecycle";
import { recordAgentLifecycleEvent } from "@features/agent/diagnostics/agent-run-trace";
import type { LiveMessageState } from "@features/agent/store/chunk-result";
import { createStreamingBuffer } from "@features/agent/store/streaming-buffer";
import {
  closeLoadingToolRows,
  emptyThreadState,
  ensureRunActive,
  isThreadRunActive,
  releaseThreadRuntimeMessages,
  threadRunUpdate,
  type ThreadState,
  type ThreadsMap,
} from "@features/agent/store/thread-runtime-state";
import {
  syncConversationInstanceForEvent,
} from "@features/agent/store/conversation-run-sync";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { applyExternalSessionResolved } from "@features/agent/store/external-session";

type AgentTypeMap<T> = Partial<Record<AgentTypeKey, T>>;

export interface DispatcherChatSlice {
  threadStates: ThreadsMap;
  threadTypes: Record<string, AgentTypeKey>;
  activeAgentTypeKey: AgentTypeKey;
  externalSessionResolutions: Record<string, string>;
  activeThreadIds: AgentTypeMap<string | undefined>;
}

export interface StreamEventDispatcherHost {
  /** 读出 chat-store 的 dispatcher 关心的子集。 */
  getChatSlice: () => DispatcherChatSlice;
  /** 把 dispatcher 计算出的 patch 写回 chat-store。 */
  applyPatch: (patch: Partial<DispatcherChatSlice>) => void;
}

/**
 * 同步 conversation.messageStates[threadId] 的 live state (messages +
 * pending ids) 到当前 chat-store 算出的结果。 复用阶段 4 的 helper。
 */
function syncLiveMessageState(
  agentType: AgentTypeKey,
  threadId: string,
  liveState: LiveMessageState,
): void {
  useAgentConversationStore
    .getState()
    .syncLiveMessageState(agentType, threadId, liveState);
}

/**
 * 把 chat-store 的 ThreadState 还原成 LiveMessageState (chat-store 现在只
 * 保留运行时 metadata, 不再持有 live messages 真源; live messages 在
 * conversation store). 这里仅作为兜底 fallback ── dispatch 时如果
 * conversation 还没有 entry, 用 chat-store 的 thread state 作为初始值。
 */
function getConversationLiveMessageState(
  threadId: string,
  fallback: LiveMessageState,
): LiveMessageState {
  const current =
    useAgentConversationStore.getState().messageStates[threadId];
  if (!current) return fallback;
  return {
    messages: current.messages,
    pendingAssistantId: current.pendingAssistantId,
    pendingReasoningId: current.pendingReasoningId,
  };
}

function activeThreadUpdate(
  slice: DispatcherChatSlice,
  type: AgentTypeKey,
  threadId: string | undefined,
): Partial<DispatcherChatSlice> {
  return {
    activeThreadIds: {
      ...slice.activeThreadIds,
      [type]: threadId,
    },
  };
}

/**
 * 计算一条 AgentEvent 应当对 chat slice 产生的 patch。 仅处理需要同步
 * 落盘的 event ── 高频 text / reasoning 通过 rAF buffer 异步走, 不进这里。
 *
 * `session_resolved` 同时会主动改 activeAgentTypeKey (跨 runtime 入口) ──
 * 修复 #12: activeThreadUpdate 不再带这个副作用, 所以这里显式补。
 */
function applyEventToChatSlice(
  slice: DispatcherChatSlice,
  event: AgentEvent,
): Partial<DispatcherChatSlice> | null {
  const tid = event.threadId;
  const st = ensureRunActive(slice.threadStates[tid] ?? emptyThreadState(), event);
  switch (event.kind) {
    case "session_resolved": {
      if (!event.sessionId || event.sessionId === tid) return null;
      const resolved = applyExternalSessionResolved(
        {
          threadStates: slice.threadStates,
          threadTypes: slice.threadTypes,
          externalSessionResolutions: slice.externalSessionResolutions,
        },
        tid,
        event.sessionId,
        event.agentType,
      );
      return {
        ...activeThreadUpdate(slice, event.agentType, event.sessionId),
        activeAgentTypeKey: event.agentType,
        threadTypes: resolved.threadTypes,
        externalSessionResolutions: resolved.externalSessionResolutions,
        threadStates: resolved.threadStates,
      };
    }
    case "stream_start": {
      const nextThreadState = applyRunStarted(st, event, {
        model: event.model,
        modelId: event.model,
        lastRunAt: event.timestamp,
        reasoningEffort: event.reasoningEffort,
      });
      const nextThreadTypes = {
        ...slice.threadTypes,
        [tid]: event.agentType,
      };
      return {
        threadTypes: nextThreadTypes,
        threadStates: threadRunUpdate(
          slice.threadStates,
          tid,
          nextThreadState,
        ),
      };
    }
    case "stream_end": {
      const ended = applyRunEnded(st, event);
      // run 结束时把仍 loading 的 tool 行(被中断 / result 未到达)收尾,避免
      // 永久转圈。仅 thread 不再 loading 时收尾,避免误关并发 run 的工具行。
      const nextThreadState = ended.isLoading
        ? ended
        : { ...ended, messages: closeLoadingToolRows(ended.messages) };
      syncLiveMessageState(event.agentType, tid, nextThreadState);
      const runtimeThreadState = nextThreadState.isLoading
        ? nextThreadState
        : releaseThreadRuntimeMessages(nextThreadState);
      return {
        threadStates: threadRunUpdate(slice.threadStates, tid, runtimeThreadState),
      };
    }
    case "usage": {
      const nextThreadState = applyRunUsage(st, event);
      return {
        threadStates: threadRunUpdate(slice.threadStates, tid, nextThreadState),
      };
    }
    case "final_message": {
      const liveState = getConversationLiveMessageState(tid, st);
      const next = applyTextChunk(liveState, event.text);
      const nextThreadState: ThreadState = {
        ...applyRunToolState(st, event, null),
        messages: next.messages,
        pendingAssistantId: next.pendingAssistantId,
        pendingReasoningId: null,
      };
      syncLiveMessageState(event.agentType, tid, nextThreadState);
      return {
        threadStates: threadRunUpdate(slice.threadStates, tid, nextThreadState),
      };
    }
    case "tool_call": {
      const liveState = getConversationLiveMessageState(tid, st);
      const next = applyToolCallChunk(
        liveState,
        event.toolCallId,
        event.name,
        event.input,
        event.agentType,
        event.display,
      );
      const nextThreadState: ThreadState = {
        ...applyRunToolState(st, event, event.name),
        messages: next.messages,
        pendingAssistantId: null,
      };
      syncLiveMessageState(event.agentType, tid, nextThreadState);
      return {
        threadStates: threadRunUpdate(slice.threadStates, tid, nextThreadState),
      };
    }
    case "tool_result": {
      const liveState = getConversationLiveMessageState(tid, st);
      const next = applyToolResultChunk(
        liveState,
        event.toolCallId,
        event.name,
        event.result,
        event.agentType,
      );
      const nextThreadState: ThreadState = {
        ...applyRunToolState(st, event, null),
        messages: next.messages,
      };
      syncLiveMessageState(event.agentType, tid, nextThreadState);
      return {
        threadStates: threadRunUpdate(slice.threadStates, tid, nextThreadState),
      };
    }
    case "error": {
      const liveState = getConversationLiveMessageState(tid, st);
      const next = applyErrorChunk(liveState, event.message);
      const nextThreadState: ThreadState = {
        ...applyRunFailed(st, event, event.message),
        messages: next.messages,
      };
      syncLiveMessageState(event.agentType, tid, nextThreadState);
      const runtimeThreadState = nextThreadState.isLoading
        ? nextThreadState
        : releaseThreadRuntimeMessages(nextThreadState);
      return {
        threadStates: threadRunUpdate(slice.threadStates, tid, runtimeThreadState),
      };
    }
    default:
      return null;
  }
}

export interface StreamEventDispatcher {
  /**
   * 派发一个 AgentEvent。 text / reasoning 走 rAF 缓冲, 其它事件同步 flush
   * 后再走 reducer。 session_resolved 还会清空 streamingBuffer 以避免悬空
   * 缓冲写错 thread id。
   */
  dispatch(event: AgentEvent): void;
  /** 同步 flush 当前 buffered text/reasoning chunk ── 给 stopThreadRun 用。 */
  flushBuffer(): void;
}

export function createStreamEventDispatcher(
  host: StreamEventDispatcherHost,
): StreamEventDispatcher {
  const streamingBuffer = createStreamingBuffer(
    (textSnapshot, reasoningSnapshot) => {
      const bufferedLiveStates = new Map<string, LiveMessageState>();
      const syncedThreads = new Map<
        string,
        { threadId: string; agentType: AgentTypeKey; liveState: LiveMessageState }
      >();
      const readLiveState = (
        threadId: string,
        fallback: LiveMessageState,
      ): LiveMessageState =>
        bufferedLiveStates.get(threadId) ??
        getConversationLiveMessageState(threadId, fallback);

      const slice = host.getChatSlice();
      const threadStates: ThreadsMap = { ...slice.threadStates };

      // reasoning 先 apply ── 与旧 store 时序一致 (reasoning chunk 先于
      // text 出现; text chunk 落地时会 close reasoning 行). 但 rAF 内两者
      // 可能同帧到达, 用 reasoning-first 顺序保证 close 语义正确。
      for (const [tid, text] of reasoningSnapshot) {
        const st = threadStates[tid];
        // thread 已被清掉 (切换 / 删除) ── 直接丢弃缓冲, 与 "chunk 到达时
        // thread 已无对应 state" 行为一致。
        if (!st) continue;
        const liveState = readLiveState(tid, st);
        const next = applyReasoningChunk(liveState, text);
        threadStates[tid] = {
          ...st,
          messages: next.messages,
          pendingAssistantId: next.pendingAssistantId,
          pendingReasoningId: next.pendingReasoningId,
        };
        bufferedLiveStates.set(tid, threadStates[tid]);
        syncedThreads.set(tid, {
          threadId: tid,
          agentType: getAgentType(
            slice.threadTypes[tid] ?? slice.activeAgentTypeKey,
          ).key,
          liveState: threadStates[tid],
        });
      }
      for (const [tid, text] of textSnapshot) {
        const st = threadStates[tid];
        if (!st) continue;
        const liveState = readLiveState(tid, st);
        const next = applyTextChunk(liveState, text);
        threadStates[tid] = {
          ...st,
          messages: next.messages,
          pendingAssistantId: next.pendingAssistantId,
          pendingReasoningId: null, // text 落地后 reasoning 行 closed
        };
        bufferedLiveStates.set(tid, threadStates[tid]);
        syncedThreads.set(tid, {
          threadId: tid,
          agentType: getAgentType(
            slice.threadTypes[tid] ?? slice.activeAgentTypeKey,
          ).key,
          liveState: threadStates[tid],
        });
      }
      host.applyPatch({ threadStates });
      for (const { agentType, threadId, liveState } of syncedThreads.values()) {
        syncLiveMessageState(agentType, threadId, liveState);
      }
    },
  );

  function dispatch(event: AgentEvent): void {
    const tid = event.threadId;
    const slice = host.getChatSlice();
    const currentThreadState = slice.threadStates[tid] ?? emptyThreadState();
    recordAgentLifecycleEvent(event, {
      activeRunId: currentThreadState.activeRunId,
      isLoading: currentThreadState.isLoading,
    });

    // Layer 2: text / reasoning 走 rAF 节流; 其它 chunk 进入前先同步
    // flush 缓冲, 保证后端发出的顺序 (text → tool_call → text →
    // tool_result → text) 在 UI 上呈现的顺序与时序一致。
    switch (event.kind) {
      case "text_delta": {
        if (!event.text || !event.text.trim()) return;
        if (!isThreadRunActive(currentThreadState)) {
          const ensured = ensureRunActive(currentThreadState, event);
          host.applyPatch({
            threadStates: threadRunUpdate(slice.threadStates, tid, ensured),
          });
        }
        streamingBuffer.appendText(tid, event.text);
        return;
      }
      case "reasoning_delta": {
        if (!isThreadRunActive(currentThreadState)) {
          const ensured = ensureRunActive(currentThreadState, event);
          host.applyPatch({
            threadStates: threadRunUpdate(slice.threadStates, tid, ensured),
          });
        }
        streamingBuffer.appendReasoning(tid, event.text);
        return;
      }
      case "final_message":
      case "tool_call":
      case "tool_result":
      case "error":
      case "stream_end":
      case "session_resolved":
        // 这些 chunk 频率低且必须立刻可见, 不走节流; 但必须先 flush 缓冲,
        // 否则文本顺序错乱 ── 例: 一段 assistant 文本被 tool_call 切走
        // 时, 缓冲里残留的文字应该先落到 pending assistant, 再让 tool_call
        // 走 close 逻辑。
        streamingBuffer.flushSync();
        break;
      case "stream_start":
      case "usage":
        // stream_start / usage 无需 flush, 不影响消息缓冲。
        break;
    }

    if (event.kind !== "usage") {
      syncConversationInstanceForEvent(event);
    }

    const nextPatch = applyEventToChatSlice(host.getChatSlice(), event);
    if (nextPatch) host.applyPatch(nextPatch);
  }

  return {
    dispatch,
    flushBuffer: () => streamingBuffer.flushSync(),
  };
}
