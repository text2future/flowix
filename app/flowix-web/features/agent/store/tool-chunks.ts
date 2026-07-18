import type { ChatMessage } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import type {
  ApplyResult,
  LiveMessageState,
} from "@features/agent/store/chunk-result";
import {
  createAgentToolDisplay,
  normalizeToolInput,
} from "@features/agent/tool-display";
import {
  TOOL_RESULT_OUTPUT_PREVIEW_MAX_CHARS,
  truncateToolResultForDisplay,
  truncateToolResultOutputPreview,
} from "@features/agent/message/display-limits";

/**
 * tool_call chunk ── 插入一条 `role: "tool"` 的消息, `isLoading=true` 等
 * tool_result 收尾。 tool 行作为流式断点, 显式清 `pendingAssistantId` ─
 * 下一条 text chunk 必须开新 assistant 行, 不能 append 到本行。
 *
 * `toolDisplay` 的优先级: caller 显式传 (来自外部 runtime 的预渲染) 优先,
 * 否则用 createAgentToolDisplay(...) 兜底。
 */
export function applyToolCallChunk(
  st: LiveMessageState,
  id: string,
  name: string,
  input: unknown,
  agentType?: AgentTypeKey,
  display?: ChatMessage["toolDisplay"],
): ApplyResult {
  const toolInput = normalizeToolInput(input);
  const toolMessage: ChatMessage = {
    id: `tool-${id || Date.now()}`,
    role: "tool",
    content: "",
    timestamp: new Date().toISOString(),
    toolCallId: id,
    toolName: name,
    toolAgentType: agentType,
    toolInput,
    toolDisplay:
      display ??
      createAgentToolDisplay({
        agentType,
        toolName: name,
        input: toolInput ?? input,
      }),
    isLoading: true,
  };
  const existingIndex = st.messages.findIndex(
    (message) => message.role === "tool" && message.toolCallId === id,
  );
  if (existingIndex >= 0) {
    const existing = st.messages[existingIndex];
    const messages = [...st.messages];
    messages[existingIndex] = {
      ...existing,
      toolName: name || existing.toolName,
      toolAgentType: agentType ?? existing.toolAgentType,
      toolInput: toolInput ?? existing.toolInput,
      toolDisplay: display ?? toolMessage.toolDisplay ?? existing.toolDisplay,
      // Replayed/complete events must never reopen an already-finished row.
      isLoading: existing.isLoading === false ? false : true,
    };
    return {
      messages,
      pendingAssistantId: null,
      pendingReasoningId: st.pendingReasoningId,
    };
  }
  return {
    messages: [...st.messages, toolMessage],
    pendingAssistantId: null,
    pendingReasoningId: st.pendingReasoningId,
  };
}

/**
 * tool_result chunk ── 找到对应 tool_call 行, 收尾 (isLoading=false) +
 * 注入 result 内容与摘要。 摘要来自 summarizeToolResult, 对 command-style
 * 结果做字段裁剪 (command / exit_code / status / output preview), 其他
 * 类型直接 stringify。所有展示文本超限截断 + 标 truncation。
 */
export function applyToolResultChunk(
  st: LiveMessageState,
  id: string,
  name: string,
  result: unknown,
  agentType?: AgentTypeKey,
): ApplyResult {
  const resultContent = summarizeToolResult(result);
  const resultToolName = name && name !== "tool_result" ? name : "";
  const hasMatchingCall = st.messages.some(
    (message) => message.role === "tool" && message.toolCallId === id,
  );
  const messages = hasMatchingCall
    ? st.messages.map((m) =>
        m.role === "tool" && m.toolCallId === id
          ? {
              ...m,
              content: resultContent,
              toolData: resultContent,
              toolName: resultToolName || m.toolName || "",
              isLoading: false,
            }
          : m,
      )
    : [
        ...st.messages,
        {
          id: `tool-${id || Date.now()}`,
          role: "tool" as const,
          content: resultContent,
          timestamp: new Date().toISOString(),
          toolCallId: id,
          toolName: resultToolName || "unknown_tool",
          toolAgentType: agentType,
          toolData: resultContent,
          isLoading: false,
        },
      ];
  return {
    messages,
    pendingAssistantId: st.pendingAssistantId,
    pendingReasoningId: st.pendingReasoningId,
  };
}

/**
 * 把 tool_result 后端响应收缩成单条字符串, 喂给 tool 行 content/toolData。
 * - 简单对象 (只含 content) 直接取 content;含 `is_error` 时加 `[error]` 前缀
 * - command-style 含 `exit_code / command / status / output_chars` 等,
 *   提取关键字段 + output 截前 2000 字符 + truncated 标记
 * - 其他结构走 stringify (单条超 4096 字符再截)
 *
 * 不导出 ── 只服务于 applyToolResultChunk。
 */
function summarizeToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return stringifyToolResult(result);
  }
  const record = result as Record<string, unknown>;

  if (
    typeof record.content === "string" &&
    !("exit_code" in record) &&
    !("command" in record)
  ) {
    const isError = record.is_error === true;
    const content = truncateToolResultForDisplay(record.content);
    return isError ? `[error] ${content}` : content;
  }

  const summary: Record<string, unknown> = {};
  for (const key of [
    "command",
    "exit_code",
    "status",
    "output_chars",
    "output_truncated",
  ]) {
    if (key in record) summary[key] = record[key];
  }
  if (typeof record.output === "string") {
    summary.output_preview = truncateToolResultOutputPreview(record.output);
    if (Array.from(record.output).length > TOOL_RESULT_OUTPUT_PREVIEW_MAX_CHARS) {
      summary.output_preview_truncated = true;
    }
  }
  if (typeof record.output_preview === "string") {
    summary.output_preview = truncateToolResultOutputPreview(
      record.output_preview,
    );
    if (
      Array.from(record.output_preview).length >
      TOOL_RESULT_OUTPUT_PREVIEW_MAX_CHARS
    ) {
      summary.output_preview_truncated = true;
    }
  }
  return stringifyToolResult(Object.keys(summary).length > 0 ? summary : result);
}

/**
 * JSON.stringify 的薄壳, 单条超限截断并加 `[truncated]` 标记。
 * 用于 summarizeToolResult 兜底路径 ── 把任意 unknown 序列化进 tool_data。
 */
function stringifyToolResult(result: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(result ?? {}, null, 2);
  } catch {
    text = String(result ?? {});
  }
  return truncateToolResultForDisplay(text);
}
