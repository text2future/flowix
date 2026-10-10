import type { MessageProjection } from "@features/agent/store/session-reducer/types";
import type { ChatMessage } from "@/types";
import type {
  AgentErrorDetails,
  AgentMessageAttachment,
  AgentMessageType,
} from "@/types/agent";
import { insertAgentMessageBySourceOrder, orderPiMessageBlocks } from "@features/agent/store/message-order";

export interface MessageChunkMetadata {
  id?: string;
  nativeMessageId?: string;
  draftScope?: string;
  blockIndex?: number;
  messageType?: AgentMessageType;
  notice?: "deepseek-harness-reconnect-failed";
  phase?: "started" | "updated" | "completed";
  contentMode?: "delta" | "snapshot";
  sourceTimestamp?: number;
  sourceSequence?: number;
  sourceSubsequence?: number;
  parentMessageId?: string;
  /** Provider lifecycle guarantees that the completed snapshot owns the pending draft. */
  adoptPendingId?: boolean;
  errorDetails?: AgentErrorDetails;
  codexTurnId?: string;
  attachments?: AgentMessageAttachment[];
  /**
   * Run-scoped id of the optimistic user row. When a provider user item
   * arrives with its own id (Codex item/completed), the optimistic row is
   * adopted in place instead of growing a duplicate.
   */
  optimisticId?: string;
}

let generatedAssistantMessageSequence = 0;

function isGoalControlMessageType(
  value: AgentMessageType | undefined,
): value is Extract<AgentMessageType, `goal-${string}`> {
  return (
    value === "goal-round" ||
    value === "goal-complete" ||
    value === "goal-blocked"
  );
}

function generatedAssistantMessageId(scope?: string, role = "assistant"): string {
  generatedAssistantMessageSequence += 1;
  return scope
    ? `draft:${scope}:${role}:${generatedAssistantMessageSequence}`
    : `assistant-${Date.now()}-${generatedAssistantMessageSequence}`;
}

export function applyUserMessageChunk(
  st: MessageProjection,
  text: string,
  metadata: MessageChunkMetadata & { id: string },
): MessageProjection {
  // DSH goal rounds and terminal wrap-up prompts are provider-owned control
  // messages. Keep them in the timeline as compact system rows, never as a
  // human turn and never allow them to adopt/replace the optimistic user row.
  if (isGoalControlMessageType(metadata.messageType)) {
    const existingIndex = st.messages.findIndex(
      (message) => message.id === metadata.id,
    );
    const message: ChatMessage = {
      id: metadata.id,
      role: "system",
      content: text,
      messageType: metadata.messageType,
      timestamp: messageTimestamp(metadata.sourceTimestamp),
      sourceTimestamp: metadata.sourceTimestamp,
      sourceSequence: metadata.sourceSequence,
      sourceSubsequence: metadata.sourceSubsequence,
      codexTurnId: metadata.codexTurnId,
      attachments: metadata.attachments,
      isCompleted: true,
    };
    const messages = [...st.messages];
    if (existingIndex >= 0) messages[existingIndex] = message;
    else messages.push(message);
    return {
      messages,
      pending: { assistantId: null, reasoningId: null },
    };
  }

  // Providers may relay their native user message id after the optimistic row
  // is already visible. Adopt it in place instead of appending a second row.
  if (
    metadata.optimisticId &&
    metadata.id !== metadata.optimisticId
  ) {
    const optimisticIndex = st.messages.findIndex(
      (message) =>
        message.role === "user" &&
        message.id === metadata.optimisticId &&
        (!metadata.codexTurnId || !message.codexTurnId),
    );
    if (optimisticIndex >= 0) {
      const optimistic = st.messages[optimisticIndex];
      const messages = [...st.messages];
      messages[optimisticIndex] = {
        ...optimistic,
        id: metadata.id,
        renderKey: optimistic.renderKey ?? optimistic.id,
        messageId: metadata.nativeMessageId ?? metadata.id,
        // The provider item may contain DSH-injected system-reminder/runtime
        // context. The optimistic row is the product-owned source of the
        // user-visible text; keep it when adopting the provider identity.
        codexTurnId: metadata.codexTurnId ?? optimistic.codexTurnId,
        attachments: optimistic.attachments,
      };
      return {
        messages,
        pending: { assistantId: null, reasoningId: null },
      };
    }
  }

  // A Codex user item can race the synthetic lifecycle event and arrive with
  // a different run-scoped id.  The turn is authoritative here; when the
  // optimistic id is unavailable, adopt the newest unacknowledged user row
  // with the same visible text instead of appending a second row.  Restrict
  // this fallback to the tail so identical prompts from older turns never
  // collapse into the current turn.
  if (metadata.codexTurnId) {
    const optimisticIndex = [...st.messages].reverse().findIndex(
      (message) =>
        message.role === "user" &&
        !message.codexTurnId &&
        message.content === text,
    );
    if (optimisticIndex >= 0) {
      const index = st.messages.length - 1 - optimisticIndex;
      const optimistic = st.messages[index];
      const messages = [...st.messages];
      messages[index] = {
        ...optimistic,
        id: metadata.id,
        // See the provider-id adoption path above: runtime context belongs to
        // the model prompt, never to the rendered user message.
        codexTurnId: metadata.codexTurnId,
        attachments: optimistic.attachments ?? metadata.attachments,
      };
      return {
        messages,
        pending: { assistantId: null, reasoningId: null },
      };
    }
  }

  const existingIndex = st.messages.findIndex(
    (message) => message.id === metadata.id && message.role === "user",
  );
  if (existingIndex >= 0) {
    const existing = st.messages[existingIndex];
    const messages = [...st.messages];
    messages[existingIndex] = {
      ...existing,
      messageId: metadata.nativeMessageId ?? existing.messageId,
      content: text,
      timestamp:
        existing.sourceTimestamp === undefined &&
        metadata.sourceTimestamp !== undefined
          ? messageTimestamp(metadata.sourceTimestamp)
          : existing.timestamp,
      sourceTimestamp: existing.sourceTimestamp ?? metadata.sourceTimestamp,
      sourceSequence: existing.sourceSequence ?? metadata.sourceSequence,
      sourceSubsequence:
        existing.sourceSubsequence ?? metadata.sourceSubsequence,
      codexTurnId: existing.codexTurnId ?? metadata.codexTurnId,
      attachments: existing.attachments ?? metadata.attachments,
    };
    return {
      messages,
      // A user row starts a new turn. Never let a late/missed stream_end make
      // the next assistant delta append to the previous turn's message.
      pending: { assistantId: null, reasoningId: null },
    };
  }

  // User events are turn boundaries in the live event stream. They must stay
  // after the already rendered transcript even when the provider attaches a
  // stale/turn-local source timestamp (Codex commonly uses sequence 0 for
  // every turn's user item). History pagination is the only path that may
  // prepend older messages.
  return {
    messages: [...st.messages, {
      id: metadata.id,
      renderKey: metadata.id,
      messageId: metadata.nativeMessageId,
      role: "user",
      content: text,
      timestamp: messageTimestamp(metadata.sourceTimestamp),
      sourceTimestamp: metadata.sourceTimestamp,
      sourceSequence: metadata.sourceSequence,
      sourceSubsequence: metadata.sourceSubsequence,
      codexTurnId: metadata.codexTurnId,
      attachments: metadata.attachments,
    }],
    pending: { assistantId: null, reasoningId: null },
  };
}

function messageTimestamp(sourceTimestamp?: number): string {
  return Number.isFinite(sourceTimestamp)
    ? new Date(sourceTimestamp!).toISOString()
    : new Date().toISOString();
}

/**
 * 文本 chunk ── assistant 出文字。 流式断点 ↔ `pendingAssistantId`:
 * - 为 null 时开新一条
 * - 已存在时 append 已有那条的 content (content += text)
 *
 * 同时把上一条未完成的 reasoning 行 `isCompleted=true` 收尾 ── assistant
 * 接 reasoning 是常规 Pattern, 不收尾会留着"思考中"视觉残留。
 */
export function applyTextChunk(st: MessageProjection, text: string, metadata: MessageChunkMetadata = {}): MessageProjection {
  const result = applyTextChunkInternal(st, text, metadata);
  return metadata.adoptPendingId ? { ...result, messages: orderPiMessageBlocks(result.messages) } : result;
}

function applyTextChunkInternal(
  st: MessageProjection,
  text: string,
  metadata: MessageChunkMetadata = {},
): MessageProjection {
  const closedMessages = st.pending.reasoningId
    ? st.messages.map((m) =>
        m.id === st.pending.reasoningId ? { ...m, isCompleted: true } : m,
      )
    : st.messages;
  const pendingAssistant = st.messages.find((row) => row.id === st.pending.assistantId && row.role === "assistant");
  const targetId = metadata.id ?? (metadata.adoptPendingId && metadata.blockIndex !== undefined &&
    pendingAssistant?.piBlockIndex !== metadata.blockIndex ? null : st.pending.assistantId);
  const existingIndex = targetId
    ? closedMessages.findIndex(
        (message) => message.id === targetId && message.role === "assistant",
      )
    : -1;
  if (existingIndex >= 0 && targetId) {
    const existing = closedMessages[existingIndex];
    // Completed-item snapshots are re-sent by design (item/completed plus
    // the turn/completed fallback). When the snapshot matches the streamed
    // content, keep every reference intact so duplicate delivery is a store
    // no-op instead of a fresh object graph.
    if (metadata.contentMode === "snapshot" && existing.content === text) {
      if (existing.messageType === metadata.messageType &&
          (!metadata.adoptPendingId || (existing.isCompleted ?? false) === (metadata.phase === "completed"))) {
        return {
          messages: closedMessages,
          pending: { assistantId: metadata.phase === "completed" ? null : targetId, reasoningId: null },
        };
      }
      const messages = [...closedMessages];
      messages[existingIndex] = {
        ...existing,
        isCompleted: metadata.phase === "completed",
        messageType: metadata.messageType ?? existing.messageType,
      };
      return {
        messages,
        pending: { assistantId: metadata.phase === "completed" ? null : targetId, reasoningId: null },
      };
    }
    const messages = [...closedMessages];
    messages[existingIndex] = {
      ...existing,
      isCompleted: metadata.phase === "completed",
      content:
        metadata.contentMode === "snapshot" ? text : existing.content + text,
      timestamp:
        existing.sourceTimestamp === undefined &&
        metadata.sourceTimestamp !== undefined
          ? messageTimestamp(metadata.sourceTimestamp)
          : existing.timestamp,
      sourceTimestamp: existing.sourceTimestamp ?? metadata.sourceTimestamp,
      sourceSequence: existing.sourceSequence ?? metadata.sourceSequence,
      sourceSubsequence:
        existing.sourceSubsequence ?? metadata.sourceSubsequence,
      codexTurnId: existing.codexTurnId ?? metadata.codexTurnId,
      messageType: metadata.messageType ?? existing.messageType,
    };
    return {
      messages,
      pending: { assistantId: metadata.phase === "completed" ? null : targetId, reasoningId: null },
    };
  }

  // Some providers expose their native message id only once the message is
  // committed. The live delta has already created the pending row, so adopt
  // the provider id in place when its completed snapshot matches that row.
  // Pending state is reset at user/tool boundaries, keeping equal answers in
  // separate turns independent.
  if (
    metadata.contentMode === "snapshot" &&
    metadata.id &&
    (st.pending.assistantId || metadata.adoptPendingId) &&
    targetId === metadata.id
  ) {
    const pendingIndex = closedMessages.findIndex(
      (message) =>
        message.role === "assistant" && (
          metadata.adoptPendingId && metadata.blockIndex !== undefined
            ? message.messageId === null && message.piBlockIndex === metadata.blockIndex &&
              !!metadata.draftScope && message.id.startsWith(`draft:${metadata.draftScope}:assistant:`)
            : message.id === st.pending.assistantId
        ),
    );
    if (pendingIndex >= 0) {
      const existing = closedMessages[pendingIndex];
      // Do not let a late snapshot for another item rename and overwrite the
      // currently pending assistant row.
      if (existing.content !== text && !metadata.adoptPendingId) {
        return applyTextSnapshotAsNewMessage(closedMessages, text, metadata);
      }
      const messages = [...closedMessages];
      messages[pendingIndex] = {
        ...existing,
        id: metadata.id,
        renderKey: existing.renderKey ?? existing.id,
        messageId: metadata.nativeMessageId ?? metadata.id,
        piBlockIndex: metadata.blockIndex,
        parentMessageId: metadata.nativeMessageId,
        isCompleted: metadata.phase === "completed",
        content: text,
        messageType: metadata.messageType ?? existing.messageType,
        sourceTimestamp: existing.sourceTimestamp ?? metadata.sourceTimestamp,
        sourceSequence: existing.sourceSequence ?? metadata.sourceSequence,
        sourceSubsequence:
          existing.sourceSubsequence ?? metadata.sourceSubsequence,
        codexTurnId: existing.codexTurnId ?? metadata.codexTurnId,
      };
      return {
        messages,
        pending: { assistantId: metadata.phase === "completed" ? null : metadata.id, reasoningId: null },
      };
    }
  }

  if (!targetId) {
    const id = generatedAssistantMessageId(metadata.draftScope);
    const message = {
      id,
      renderKey: id,
      messageId: metadata.adoptPendingId ? metadata.nativeMessageId ?? metadata.id ?? null : undefined,
      piBlockIndex: metadata.blockIndex,
      parentMessageId: metadata.nativeMessageId,
      isCompleted: metadata.phase === "completed",
      role: "assistant" as const,
      content: text,
      timestamp: messageTimestamp(metadata.sourceTimestamp),
      sourceTimestamp: metadata.sourceTimestamp,
      sourceSequence: metadata.sourceSequence,
      sourceSubsequence: metadata.sourceSubsequence,
      codexTurnId: metadata.codexTurnId,
      messageType: metadata.messageType,
    };
    return {
      messages: insertAgentMessageBySourceOrder(closedMessages, message, metadata.adoptPendingId),
      pending: { assistantId: id, reasoningId: null },
    };
  }

  const message = {
    id: targetId,
    renderKey: targetId,
    messageId: metadata.adoptPendingId ? metadata.nativeMessageId ?? metadata.id ?? null : undefined,
      piBlockIndex: metadata.blockIndex,
      parentMessageId: metadata.nativeMessageId,
    isCompleted: metadata.phase === "completed",
    role: "assistant" as const,
    content: text,
    timestamp: messageTimestamp(metadata.sourceTimestamp),
    sourceTimestamp: metadata.sourceTimestamp,
    sourceSequence: metadata.sourceSequence,
    sourceSubsequence: metadata.sourceSubsequence,
    codexTurnId: metadata.codexTurnId,
    messageType: metadata.messageType,
  };
  return {
    messages: insertAgentMessageBySourceOrder(closedMessages, message, metadata.adoptPendingId),
    pending: { assistantId: metadata.phase === "completed" ? null : targetId, reasoningId: null },
  };
}

function applyTextSnapshotAsNewMessage(
  messages: ChatMessage[],
  text: string,
  metadata: MessageChunkMetadata,
): MessageProjection {
  const id = metadata.id ?? generatedAssistantMessageId(metadata.draftScope);
  const message = {
    id,
    renderKey: id,
    messageId: metadata.adoptPendingId ? metadata.nativeMessageId ?? metadata.id ?? null : undefined,
      piBlockIndex: metadata.blockIndex,
      parentMessageId: metadata.nativeMessageId,
    isCompleted: metadata.phase === "completed",
    role: "assistant" as const,
    content: text,
    timestamp: messageTimestamp(metadata.sourceTimestamp),
    sourceTimestamp: metadata.sourceTimestamp,
    sourceSequence: metadata.sourceSequence,
    sourceSubsequence: metadata.sourceSubsequence,
    codexTurnId: metadata.codexTurnId,
    messageType: metadata.messageType,
  };
  return {
    messages: insertAgentMessageBySourceOrder(messages, message, metadata.adoptPendingId),
    pending: { assistantId: metadata.phase === "completed" ? null : id, reasoningId: null },
  };
}

/**
 * reasoning chunk ── 与 text chunk 形态相同, 仅 `role: "reasoning"` 与
 * 默认 `isCompleted: false`。 注意 reasoning 行不会因为后续 text chunk
 * 收尾 ── 由 `applyTextChunk` 显式 close, 这里保持原状。
 */
export function applyReasoningChunk(st: MessageProjection, text: string, metadata: MessageChunkMetadata = {}): MessageProjection {
  const result = applyReasoningChunkInternal(st, text, metadata);
  return metadata.adoptPendingId ? { ...result, messages: orderPiMessageBlocks(result.messages) } : result;
}

function applyReasoningChunkInternal(
  st: MessageProjection,
  text: string,
  metadata: MessageChunkMetadata = {},
): MessageProjection {
  const pendingReasoning = st.messages.find((row) => row.id === st.pending.reasoningId && row.role === "reasoning");
  const targetId = metadata.id ?? (metadata.adoptPendingId && metadata.blockIndex !== undefined &&
    pendingReasoning?.piBlockIndex !== metadata.blockIndex ? null : st.pending.reasoningId);
  const existingIndex = targetId
    ? st.messages.findIndex(
        (message) => message.id === targetId && message.role === "reasoning",
      )
    : -1;
  if (existingIndex >= 0 && targetId) {
    const existing = st.messages[existingIndex];
    // Snapshot idempotency: identical content and completion state keep the
    // row reference (and the array) untouched for duplicate snapshots.
    if (
      metadata.contentMode === "snapshot" &&
      existing.content === text &&
      (existing.isCompleted ?? false) === (metadata.phase === "completed")
    ) {
      return {
        messages: st.messages,
        pending: { assistantId: st.pending.assistantId, reasoningId: metadata.phase === "completed" ? null : targetId },
      };
    }
    const messages = [...st.messages];
    messages[existingIndex] = {
      ...existing,
      content:
        metadata.contentMode === "snapshot" ? text : existing.content + text,
      timestamp:
        existing.sourceTimestamp === undefined &&
        metadata.sourceTimestamp !== undefined
          ? messageTimestamp(metadata.sourceTimestamp)
          : existing.timestamp,
      sourceTimestamp: existing.sourceTimestamp ?? metadata.sourceTimestamp,
      sourceSequence: existing.sourceSequence ?? metadata.sourceSequence,
      sourceSubsequence:
        existing.sourceSubsequence ?? metadata.sourceSubsequence,
      // A later Claude tool cycle may append to the same run-scoped reasoning
      // row after assistant/tool output temporarily closed it.
      isCompleted: metadata.phase === "completed",
    };
    return {
      messages,
      pending: { assistantId: st.pending.assistantId, reasoningId: metadata.phase === "completed" ? null : targetId },
    };
  }
  if (!targetId) {
    const id = generatedAssistantMessageId(metadata.draftScope, "reasoning");
    return {
      messages: [
        ...st.messages,
        {
          id,
          renderKey: id,
          messageId: metadata.adoptPendingId ? null : undefined,
          piBlockIndex: metadata.blockIndex,
          role: "reasoning",
          content: text,
          timestamp: new Date().toISOString(),
          isCompleted: false,
        },
      ],
      pending: { assistantId: st.pending.assistantId, reasoningId: id },
    };
  }

  if (metadata.contentMode === "snapshot" && metadata.id) {
    // Closing the thinking animation must not discard the draft awaiting the
    // enclosing Pi message commit. Scope excludes drafts from earlier runs.
    const pendingIndex = st.messages.findIndex(
      (message) => message.role === "reasoning" && (
        (message.id === st.pending.reasoningId && (metadata.blockIndex === undefined || message.piBlockIndex === metadata.blockIndex)) ||
        (metadata.adoptPendingId && metadata.draftScope &&
          message.messageId === null &&
          (metadata.blockIndex === undefined || message.piBlockIndex === metadata.blockIndex) &&
          message.id.startsWith(`draft:${metadata.draftScope}:reasoning:`))
      ),
    );
    if (pendingIndex >= 0) {
      const existing = st.messages[pendingIndex];
      if (existing.content === text || metadata.adoptPendingId) {
        const messages = [...st.messages];
        messages[pendingIndex] = {
          ...existing,
          id: metadata.id,
          renderKey: existing.renderKey ?? existing.id,
          messageId: metadata.nativeMessageId ?? metadata.id,
        piBlockIndex: metadata.blockIndex,
        parentMessageId: metadata.nativeMessageId,
          content: text,
          isCompleted: metadata.phase === "completed",
          sourceTimestamp: existing.sourceTimestamp ?? metadata.sourceTimestamp,
          sourceSequence: existing.sourceSequence ?? metadata.sourceSequence,
          sourceSubsequence: existing.sourceSubsequence ?? metadata.sourceSubsequence,
        };
        return {
          messages,
          pending: { assistantId: st.pending.assistantId, reasoningId: metadata.phase === "completed" ? null : metadata.id },
        };
      }
    }
  }

  const message = {
    id: targetId,
    renderKey: targetId,
    messageId: metadata.adoptPendingId ? metadata.nativeMessageId ?? metadata.id ?? null : undefined,
      piBlockIndex: metadata.blockIndex,
      parentMessageId: metadata.nativeMessageId,
    role: "reasoning" as const,
    content: text,
    timestamp: messageTimestamp(metadata.sourceTimestamp),
    sourceTimestamp: metadata.sourceTimestamp,
    sourceSequence: metadata.sourceSequence,
    sourceSubsequence: metadata.sourceSubsequence,
    isCompleted: metadata.phase === "completed",
  };
  return {
    messages: insertAgentMessageBySourceOrder(st.messages, message, metadata.adoptPendingId),
    pending: { assistantId: st.pending.assistantId, reasoningId: metadata.phase === "completed" ? null : targetId },
  };
}

/**
 * error chunk ── 关闭此 run 的 streaming:
 * - 关 pending reasoning (`isCompleted=true`)
 * - 清 pendingAssistantId / pendingReasoningId
 * - append 一条 assistant 错误卡片
 *
 * 否则迟到的 text/reasoning chunk 会 append 到已"失败"的 assistant 行,
 * 形成撕裂 (同一段流既 error 又继续说)。 assistant 行没有 isCompleted 字段,
 * 关闭靠"pendingAssistantId 切 null" + 下次 text chunk 走 create-new 路径。
 */
export function applyErrorChunk(
  st: MessageProjection,
  message: string,
  metadata: Pick<MessageChunkMetadata, "id" | "notice" | "errorDetails"> = {},
): MessageProjection {
  const closedMessages = st.pending.reasoningId
    ? st.messages.map((m) =>
        m.id === st.pending.reasoningId ? { ...m, isCompleted: true } : m,
      )
    : st.messages;
  const id = metadata.id ?? `error-${Date.now()}`;
  const existingIndex = closedMessages.findIndex(
    (item) => item.id === id && item.role === "assistant",
  );
  if (existingIndex >= 0) {
    // Keep the first error body (usually the provider's stdout error), but
    // enrich it if a later lifecycle error carries structured diagnostics.
    const existing = closedMessages[existingIndex];
    const messages = [...closedMessages];
    messages[existingIndex] = {
      ...existing,
      content: existing.content || message,
      errorDetails: existing.errorDetails ?? metadata.errorDetails,
    };
    return {
      messages,
      pending: { assistantId: null, reasoningId: null },
    };
  }

  return {
    messages: [
      ...closedMessages,
      {
        id,
        role: "assistant",
        content: message,
        timestamp: new Date().toISOString(),
        ...(metadata.notice ? { notice: metadata.notice } : {}),
        ...(metadata.errorDetails
          ? { errorDetails: metadata.errorDetails }
          : {}),
      },
    ],
    pending: { assistantId: null, reasoningId: null },
  };
}
