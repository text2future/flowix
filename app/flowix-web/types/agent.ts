/**
 * Unified chat message types for Flowix app
 */

// Thread list item
export interface ThreadListItem {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

// Core message type used throughout the app
export type AgentRuntime = "flowix" | "codex";
export type AgentRoleKey = "flowix" | "codex";

export interface AgentRole {
  key: AgentRoleKey;
  runtime: AgentRuntime;
  /** 图片资产路径(Vite 静态资源 import 解析后的 URL)。
   *  所有 agent 图标统一在 agent-roles.ts 集中管理。 */
  icon: string;
  name: string;
  desc: string;
}

export type AgentPermissionMode =
  | "inherit"
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type AgentCodexModel = "inherit" | string;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "reasoning" | "end";
  content: string;
  llmContent?: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
  timestamp: string;
  isLoading?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolData?: string;
  toolInput?: Record<string, unknown>;
  toolCalls?: ToolCall[];
  reasoning?: string;
  isCompleted?: boolean;
  isCollapsed?: boolean;
}

// Tool call definition
export interface ToolCall {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  result?: string;
  args?: string;
}

// Stream events from agent ── 与后端 `AgentChunk` 1:1 镜像, 由
// `client.ts:listenToAgentStream` 监听 `agent-chunk` 通道消费。
// 替换之前 `[REASONING]:` / `[TOOL_CALL]:` / `[TOOL_RESULT]:` / `[ERROR]:`
// 字符串前缀协议 ── 用判别联合 (kind) 替代 startsWith。
//
// **字段命名 ── snake_case**: Tauri `app.emit("agent-chunk", &chunk)`
// 不做字段重命名, serde 原样输出。`thread_id` 在 JSON 里就是 `thread_id`,
// TS 端访问 `chunk.thread_id`。这跟 IPC command args/returns 的 camelCase
// 约定是两套规则 ── 后者有 Tauri 自动转换, 前者没有, 不要混
// (与 `memo-event` 的 `payload.memo` / `payload.source` 同形)。
export type AgentChunk =
  | AgentChunkText
  | AgentChunkReasoning
  | AgentChunkToolCall
  | AgentChunkToolResult
  | AgentChunkError
  | AgentChunkStreamStart
  | AgentChunkStreamEnd;

export interface AgentChunkText {
  kind: "text";
  thread_id: string;
  text: string;
}

export interface AgentChunkReasoning {
  kind: "reasoning";
  thread_id: string;
  text: string;
}

export interface AgentChunkToolCall {
  kind: "tool_call";
  thread_id: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentChunkToolResult {
  kind: "tool_result";
  thread_id: string;
  id: string;
  name: string;
  result: unknown;
}

export interface AgentChunkError {
  kind: "error";
  thread_id: string;
  message: string;
}

// 生命周期变体 ── 由后端 `chat_stream` 外层在 insert / remove cancel_flag
// 时各 emit 一次。覆盖所有退出路径 (Ok / Err / panic-via-drop)。前端
// chat-store 据此收敛 `threadStates[tid].isLoading`, 不再依赖 IPC finally。
export interface AgentChunkStreamStart {
  kind: "stream_start";
  thread_id: string;
}

export interface AgentChunkStreamEnd {
  kind: "stream_end";
  thread_id: string;
  /** null = 正常完成; string = 异常退出 (e.g. "agent stuck: ...") */
  reason: string | null;
}

// `agent_running_threads` IPC 返回值 ── camelCase, 走 IPC command 返回
// 路径, Tauri 自动从 Rust snake_case (`started_at` / `current_tool`) 转
// camelCase (`startedAt` / `currentTool`)。
export interface RunInfo {
  startedAt: number;
  currentTool: string | null;
}

// Re-export for backwards compatibility
export type MessageType = ChatMessage;
