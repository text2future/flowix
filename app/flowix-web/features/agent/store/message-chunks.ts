import type {
  ApplyResult,
  LiveMessageState,
} from "@features/agent/store/chunk-result";

/**
 * 文本 chunk ── assistant 出文字。 流式断点 ↔ `pendingAssistantId`:
 * - 为 null 时开新一条
 * - 已存在时 append 已有那条的 content (content += text)
 *
 * 同时把上一条未完成的 reasoning 行 `isCompleted=true` 收尾 ── assistant
 * 接 reasoning 是常规 Pattern, 不收尾会留着"思考中"视觉残留。
 */
export function applyTextChunk(st: LiveMessageState, text: string): ApplyResult {
  const closedMessages = st.pendingReasoningId
    ? st.messages.map((m) =>
        m.id === st.pendingReasoningId ? { ...m, isCompleted: true } : m,
      )
    : st.messages;
  if (!st.pendingAssistantId) {
    const id = `assistant-${Date.now()}`;
    return {
      messages: [
        ...closedMessages,
        {
          id,
          role: "assistant",
          content: text,
          timestamp: new Date().toISOString(),
        },
      ],
      pendingAssistantId: id,
      pendingReasoningId: null,
    };
  }
  return {
    messages: closedMessages.map((m) =>
      m.id === st.pendingAssistantId ? { ...m, content: m.content + text } : m,
    ),
    pendingAssistantId: st.pendingAssistantId,
    pendingReasoningId: null,
  };
}

/**
 * reasoning chunk ── 与 text chunk 形态相同, 仅 `role: "reasoning"` 与
 * 默认 `isCompleted: false`。 注意 reasoning 行不会因为后续 text chunk
 * 收尾 ── 由 `applyTextChunk` 显式 close, 这里保持原状。
 */
export function applyReasoningChunk(
  st: LiveMessageState,
  text: string,
): ApplyResult {
  if (!st.pendingReasoningId) {
    const id = `reasoning-${Date.now()}`;
    return {
      messages: [
        ...st.messages,
        {
          id,
          role: "reasoning",
          content: text,
          timestamp: new Date().toISOString(),
          isCompleted: false,
        },
      ],
      pendingReasoningId: id,
      pendingAssistantId: st.pendingAssistantId,
    };
  }
  return {
    messages: st.messages.map((m) =>
      m.id === st.pendingReasoningId ? { ...m, content: m.content + text } : m,
    ),
    pendingReasoningId: st.pendingReasoningId,
    pendingAssistantId: st.pendingAssistantId,
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
  st: LiveMessageState,
  message: string,
): ApplyResult {
  const closedMessages = st.pendingReasoningId
    ? st.messages.map((m) =>
        m.id === st.pendingReasoningId ? { ...m, isCompleted: true } : m,
      )
    : st.messages;
  return {
    messages: [
      ...closedMessages,
      {
        id: `error-${Date.now()}`,
        role: "assistant",
        content: message,
        timestamp: new Date().toISOString(),
      },
    ],
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}
