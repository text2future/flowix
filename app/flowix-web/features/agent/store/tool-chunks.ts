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
import { insertAgentMessageBySourceOrder, orderPiMessageBlocks } from "@features/agent/store/message-order";
import type { MessageChunkMetadata } from "@features/agent/store/message-chunks";

function toolMessageTimestamp(sourceTimestamp?: number): string {
  return Number.isFinite(sourceTimestamp)
    ? new Date(sourceTimestamp!).toISOString()
    : new Date().toISOString();
}

function toolCallIdsMatch(left: string | undefined, right: string): boolean {
  if (left === right) return true;
  return left?.endsWith(`:tool-call:${right}`) === true ||
    right.endsWith(`:tool-call:${left ?? ""}`);
}

/**
 * tool_call chunk ── 插入一条 `role: "tool"` 的消息, `isLoading=true` 等
 * tool_result 收尾。 tool 行作为流式断点, 显式清 `pendingAssistantId` ─
 * 下一条 text chunk 必须开新 assistant 行, 不能 append 到本行。
 *
 * 工具展示完全由 Flowix 根据结构化的 tool name/input 计算；runtime 只
 * 提供原始工具事件，不把另一套 toolview/display 注入消息。
 */
export function applyToolCallChunk(
  st: LiveMessageState,
  id: string,
  name: string,
  input: unknown,
  agentType?: AgentTypeKey,
  metadata: MessageChunkMetadata = {},
): ApplyResult {
  const toolInput = normalizeToolInput(input);
  const toolMessage: ChatMessage = {
    id: metadata.id ?? `tool-${id || Date.now()}`,
    renderKey: metadata.id ?? id,
    messageId: agentType === "pi" ? metadata.id ?? id : undefined,
    role: "tool",
    content: "",
    timestamp: toolMessageTimestamp(metadata.sourceTimestamp),
    sourceTimestamp: metadata.sourceTimestamp,
    sourceSequence: metadata.sourceSequence,
    sourceSubsequence: metadata.sourceSubsequence,
    parentMessageId: metadata.parentMessageId,
    piBlockIndex: agentType === "pi" ? metadata.sourceSubsequence : undefined,
    toolCallId: id,
    toolName: name,
    toolAgentType: agentType,
    toolInput,
    toolDisplay: createAgentToolDisplay({
      agentType,
      toolName: name,
      input: toolInput ?? input,
    }),
    isLoading: true,
  };
  const existingIndex = st.messages.findIndex(
    (message) => message.role === "tool" && toolCallIdsMatch(message.toolCallId, id),
  );
  if (existingIndex >= 0) {
    const existing = st.messages[existingIndex];
    const messages = [...st.messages];
    messages[existingIndex] = {
      ...existing,
      id: metadata.id ?? existing.id,
      toolName: name || existing.toolName,
      toolAgentType: agentType ?? existing.toolAgentType,
      toolInput: toolInput ?? existing.toolInput,
      // Recompute from the latest structured call metadata. This keeps a
      // repeated/live call and history replay on the same Flowix formatter.
      toolDisplay: toolMessage.toolDisplay ?? existing.toolDisplay,
      timestamp: existing.timestamp || toolMessage.timestamp,
      sourceTimestamp: existing.sourceTimestamp ?? metadata.sourceTimestamp,
      sourceSequence: existing.sourceSequence ?? metadata.sourceSequence,
      sourceSubsequence:
        existing.sourceSubsequence ?? metadata.sourceSubsequence,
      parentMessageId: existing.parentMessageId ?? metadata.parentMessageId,
      piBlockIndex: existing.piBlockIndex ?? (agentType === "pi" ? metadata.sourceSubsequence : undefined),
      // Replayed/complete events must never reopen an already-finished row.
      isLoading: existing.isLoading === false ? false : true,
    };
    return {
      messages: agentType === "pi" ? orderPiMessageBlocks(messages) : messages,
      pendingAssistantId: null,
      pendingReasoningId: st.pendingReasoningId,
    };
  }
  return {
    messages: agentType === "pi" ? orderPiMessageBlocks([...st.messages, toolMessage]) : insertAgentMessageBySourceOrder(st.messages, toolMessage),
    pendingAssistantId: null,
    pendingReasoningId: st.pendingReasoningId,
  };
}

/**
 * tool_result chunk ── 找到对应 tool_call 行, 收尾 (isLoading=false) +
 * 注入 result 内容与摘要。摘要来自 summarizeToolResult, 对 command-style
 * 结果做字段裁剪 (command / exit_code / status / output preview), 其他
 * 类型直接 stringify。所有展示文本超限截断 + 标 truncation。
 *
 * Result is also a hard assistant boundary. The started event can be missing
 * or arrive late; retaining pendingAssistantId here would make the assistant
 * response after this tool append to the assistant message before the tool.
 */
export function applyToolResultChunk(
  st: LiveMessageState,
  id: string,
  name: string,
  result: unknown,
  agentType?: AgentTypeKey,
  metadata: MessageChunkMetadata = {},
): ApplyResult {
  const resultToolName = name && name !== "tool_result" ? name : "";
  const resultContent = summarizeToolResult(result, resultToolName);
  const hasMatchingCall = st.messages.some(
    (message) => message.role === "tool" && toolCallIdsMatch(message.toolCallId, id),
  );
  const messages = hasMatchingCall
    ? st.messages.map((m) =>
        m.role === "tool" && toolCallIdsMatch(m.toolCallId, id)
          ? {
              ...m,
              content: resultContent,
              toolData: resultContent,
              // The started event owns the tool identity. Result sources in
              // external runtimes may use a generic/legacy name (for example
              // `tool`), so never replace a known call name at completion.
              toolName: m.toolName || resultToolName || "",
              // The started event is the canonical presentation identity.
              // A result may arrive with a provider-specific/generic name;
              // keep the live display metadata so completion cannot switch
              // the row to a different card format.
              toolDisplay: m.toolDisplay ?? createAgentToolDisplay({
                agentType: m.toolAgentType ?? agentType,
                toolName: m.toolName || resultToolName || "",
                input: m.toolInput,
              }),
              isLoading: false,
            }
          : m,
      )
    : insertAgentMessageBySourceOrder(st.messages, {
        id: metadata.id ?? `tool-${id || Date.now()}`,
        renderKey: metadata.id ?? id,
        messageId: agentType === "pi" ? metadata.id ?? id : undefined,
        role: "tool" as const,
        content: resultContent,
        timestamp: toolMessageTimestamp(metadata.sourceTimestamp),
        sourceTimestamp: metadata.sourceTimestamp,
        sourceSequence: metadata.sourceSequence,
        sourceSubsequence: metadata.sourceSubsequence,
        parentMessageId: metadata.parentMessageId,
    piBlockIndex: agentType === "pi" ? metadata.sourceSubsequence : undefined,
        toolCallId: id,
        toolName: resultToolName || "unknown_tool",
        toolAgentType: agentType,
        toolDisplay: createAgentToolDisplay({
          agentType,
          toolName: resultToolName || "unknown_tool",
          input: undefined,
        }),
        toolData: resultContent,
        isLoading: false,
      }, agentType === "pi");
  return {
    messages,
    pendingAssistantId: null,
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
function summarizeToolResult(result: unknown, toolName?: string): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return stringifyToolResult(result);
  }
  const record = result as Record<string, unknown>;

  if (["image_generation", "image_generation_call"].includes(
    toolName?.toLowerCase() ?? "",
  )) {
    const status = typeof record.status === "string"
      ? record.status.toLowerCase()
      : "";
    const failure = [record.failure, record.error, record.reason]
      .map(imageGenerationErrorText)
      .find((value): value is string => Boolean(value));
    if (failure || ["failed", "failure", "error"].includes(status)) {
      return `[error] ${truncateToolResultForDisplay(
        failure || "Image generation failed",
      )}`;
    }
  }

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
    "durationMs",
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

function imageGenerationErrorText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail", "reason"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].trim();
    }
  }
  return Object.keys(record).length > 0 ? stringifyToolResult(record) : undefined;
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
