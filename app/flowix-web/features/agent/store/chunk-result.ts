import type { ChatMessage } from "@/types";

/**
 * `applyXxxChunk` 系列函数的返回值, 描述"把这条 chunk 落到 thread state 后":
 * - `messages`: 重写后整段 messages
 * - `pendingAssistantId` / `pendingReasoningId`: 流式游标 ── chunk handler
 *   通过这两个字段知道下条 text/reasoning chunk 应该 append 到哪条消息上
 *   (或开新一条)。 reasoning 后被 assistant text 接上的写法: 走
 *   `applyTextChunk`, 该函数内部会把上一条 reasoning `isCompleted` 收尾。
 *
 * 不要把单个 chunk handler 当作黑盒 ── `applyToolCallChunk` 主动清掉
 * `pendingAssistantId`, 因为 tool 调用是流中断点, 之后第一条 text chunk
 * 必须开新 assistant 行。
 */
export interface ApplyResult {
  messages: ChatMessage[];
  pendingAssistantId: string | null;
  pendingReasoningId: string | null;
}
