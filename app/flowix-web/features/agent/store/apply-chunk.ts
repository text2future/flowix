// Re-export 兼容旧 import 路径 (`@features/agent/store/apply-chunk`)。
// 实际 chunk handler 已按职责拆到两个文件:
//   - message-chunks.ts: assistant / reasoning / error chunk
//   - tool-chunks.ts: tool_call / tool_result chunk (含 summarizeToolResult)
//
// 拆分动机: text/reasoning/error 都是流式状态机的一组 (开/续/收), 共
// 一个 `pendingAssistantId`/`pendingReasoningId` 游标语义; tool_call/
// tool_result 是另一组 (中间件 await 链路), 走 `isLoading` 收尾。两组
// 不共享内部 helper, 一起放在一个文件里反而不易读 ── 调用方通过 chunk
// 类型自然分流, 模块边界与语义边界对齐。
export type { ApplyResult } from "@features/agent/store/chunk-result";
export {
  applyTextChunk,
  applyReasoningChunk,
  applyErrorChunk,
} from "@features/agent/store/message-chunks";
export {
  applyToolCallChunk,
  applyToolResultChunk,
} from "@features/agent/store/tool-chunks";
