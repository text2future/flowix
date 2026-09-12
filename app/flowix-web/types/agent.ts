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
export type AgentTypeKey =
  | "codex"
  | "claude"
  | "gemini"
  | "hermes"
  | "openclaw"
  | "opencode"
  | "deepseek-harness";

export interface AgentType {
  key: AgentTypeKey;
  /** 图标资源路径 (Vite 静态资源 import 解析后的 URL)。所有 agent 图标统一在 agent-types.ts 集中管理。 */
  icon: string;
  name: string;
  desc: string;
  /**
   * i18n key for `name` ── 卡片列表里走 t() 读多语言。给 `null` / 缺省就
   * 走 `name` 兜底 (英文, 适配非 React 上下文: 编辑器节点 / 后端日志)。
   * 字符串形式而非强类型 I18nKey, 避免 features/i18n 跟 types/agent 的循环依赖。
   */
  nameKey?: string | null;
  /** i18n key for `desc`, 同上。 */
  descKey?: string | null;
  releaseStatus?: "coming-soon";
  capabilities: AgentRuntimeCapabilities;
}

export interface AgentRuntimeCapabilities {
  supportsTextStreaming: boolean;
  supportsToolEvents: boolean;
  externalSessionBacked: boolean;
  /** Provider keeps persisted threads that Flowix can archive (and later
   * restore). Absent/false: conversation delete stays Flowix-local. */
  supportsThreadArchive?: boolean;
}

/** Structured diagnostics from an external CLI/provider. Raw wire fields are
 * snake_case; the event/message layers expose this normalized camelCase form.
 */
export interface AgentErrorDetails {
  category: string;
  statusCode?: number;
  requestId?: string;
  retryAfter?: string;
  exitCode?: number;
  upstreamMessage?: string;
  source?: string;
  retryable: boolean;
}

export type AgentPermissionMode =
  | "inherit"
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | "yolo";
export type AgentCodexModel = "inherit" | string;
export type AgentCodexReasoningEffort = "low" | "medium" | "high" | "xhigh";
/** DeepSeek Harness Agent preset / conversation mode. */
export type AgentHarnessPreset = "standard" | "code" | "minimal" | "cordis";

export interface AgentRuntimeConfigBase {
  cwd?: string;
  workspacePaths?: string[];
}

export interface CodexRuntimeConfig extends AgentRuntimeConfigBase {
  model?: AgentCodexModel;
  permissionMode?: AgentPermissionMode;
  reasoningEffort?: AgentCodexReasoningEffort;
}

export interface DeepSeekHarnessRuntimeConfig extends CodexRuntimeConfig {
  mode?: AgentHarnessPreset;
  /** Native llm-pi-ai provider route, for example `deepseek` or `openai`. */
  providerId?: string;
}

export interface ClaudeRuntimeConfig extends AgentRuntimeConfigBase {
  model?: AgentCodexModel;
  permissionMode?: AgentPermissionMode;
}

export interface SimpleCliRuntimeConfig extends AgentRuntimeConfigBase {}

export interface HermesRuntimeConfig extends AgentRuntimeConfigBase {
  permissionMode?: AgentPermissionMode;
}

export interface AgentRuntimeConfig {
  codex?: CodexRuntimeConfig;
  claude?: ClaudeRuntimeConfig;
  gemini?: SimpleCliRuntimeConfig;
  hermes?: HermesRuntimeConfig;
  openclaw?: SimpleCliRuntimeConfig;
  opencode?: CodexRuntimeConfig;
  deepseekHarness?: DeepSeekHarnessRuntimeConfig;
}

// ─────────────────────────────────────────────────────────────────────────
// Runtime config snapshot ── stored on `agent_conversation_instances`.
// Used by Agent Thread Card instances to lock model / permission / files
// configuration without polluting other cards.
//
// 字段语义对齐后端 `app/flowix-desktop/src/threads.rs::RuntimeConfig`。
// 序列化 / 反序列化与后端保持 camelCase 命名一致。
// ─────────────────────────────────────────────────────────────────────────

export interface ModelConfig {
  key: string;
  /** DeepSeek Harness provider route for this model selection. */
  providerId?: string;
}

export interface AccessConfig {
  sandbox: AgentPermissionMode;
}

export interface FilesConfig {
  /** @deprecated Notebook path is always cwd; retained for legacy JSON reads. */
  workspace?: string | null;
  /** 启用目录列表 (path 数组) */
  folders: string[];
  /** 笔记本路径列表 (path 数组, 与 agent-access-store 同语义) */
  notebooks: string[];
  /**
   * 旧冻结模型的兼容字段。新数据使用 `RuntimeConfig.workspaceSnapshot`。
   *
   * 字段仅在 JS 层用, 序列化到 backend snapshot 时跟着 files 一起落 SQLite
   * (`runtimeConfig` 走 JSON.stringify), 不需要 backend schema 升级。
   */
  _frozen?: boolean;
}

/**
 * Conversation-scoped workspace captured immediately before the first run.
 * Later turns reuse these exact paths instead of consulting notebook defaults
 * or the currently selected notebook again.
 */
export interface WorkspaceSnapshot {
  version: 1;
  /** Effective process working directory. */
  cwd: string;
  /** Notebook-local add-dir roots; cwd is carried separately above. */
  workspacePaths: string[];
  /** Notebook association and path as they existed when the snapshot was made. */
  notebookId?: string;
  notebookPath?: string;
  capturedAt: number;
}

export interface ConversationWorkspaceState {
  version: 1;
  desired: WorkspaceSnapshot;
  applied: WorkspaceSnapshot | null;
  revision: number;
  appliedRevision: number;
  error?: string;
}

export interface RuntimeConfig {
  model?: ModelConfig;
  access?: AccessConfig;
  files?: FilesConfig;
  /**
   * 推理 effort (Codex 用) ── 与后端 `RuntimeConfig::reasoning_effort` 字段镜像。
   * 三态语义同 model / access：缺失或 null = 走全局；非空 = 锁定。
   */
  reasoningEffort?: AgentCodexReasoningEffort;
  /** DeepSeek Harness Agent preset, locked per thread card. */
  deepseekHarness?: Pick<DeepSeekHarnessRuntimeConfig, "mode">;
  /** 预留：工具白名单 */
  tools?: string[];
  /** 旧版 cwd 显式覆盖；历史数据会迁移到 workspaceSnapshot。 */
  cwd?: string;
  /** 首次运行时冻结的 add-dir / notebook 路径；cwd 仅用于旧数据迁移。 */
  workspaceSnapshot?: WorkspaceSnapshot;
  /** Canonical conversation workspace state. Legacy snapshots are read-only migration input. */
  workspaceState?: ConversationWorkspaceState;
  /**
   * 创建该 instance 时所属 notebook 的 id 快照 (如 `nb_<ts>` / `nb_default`)。
   *
   * 非运行时配置 ── 它不发给 LLM, 仅用于把卡片关联到所属 notebook 的
   * `.flowix/agent.json` add-dir 配置。借 `runtimeConfig` 的
   * JSON 透传通道一起落 SQLite (后端 `runtime_config` 是裸 TEXT, 不解析内部),
   * 与 `_frozen` 同构 ── 无需 backend schema 升级。
   *
   * 缺失时仅保留历史会话兼容，不再写入全局资料默认。
   */
  notebookId?: string;
}

/**
 * `RuntimeConfig` 的 partial patch ── instance runtimeConfig updates use this.
 *
 * 三态语义（与 chat-store 实际 merge 行为一致）：
 *   - 字段缺失 / `undefined` → 不动
 *   - 字段为 `null` → 显式清空（merge 后该 key 值为 null,
 *     序列化为 JSON 字符串 → 后端反序列化为 None → 走全局 fallback）
 *   - 字段为有值对象 → 锁定为该值
 *
 * 因此字段值类型展开为 `T | null | undefined` ── `undefined` 跳过,
 * `null` 清空, 其他覆盖。
 */
export type RuntimeConfigPatch = {
  [K in keyof RuntimeConfig]?: RuntimeConfig[K] | null;
};

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "reasoning" | "end";
  /** Provider-owned timeline/control message, distinct from human content. */
  messageType?: AgentMessageType;
  content: string;
  /** Display-only notice kind for provider-specific runtime failures. */
  notice?: "deepseek-harness-reconnect-failed";
  errorDetails?: AgentErrorDetails;
  llmContent?: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
  timestamp: string;
  /** Provider/source ordering metadata. `timestamp` remains display data. */
  sourceTimestamp?: number;
  sourceSequence?: number;
  sourceSubsequence?: number;
  isLoading?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolAgentType?: AgentTypeKey;
  toolData?: string;
  toolInput?: Record<string, unknown>;
  toolDisplay?: AgentToolDisplay;
  toolCalls?: ToolCall[];
  /** Raw provider tool events projected by DSH history, when available. */
  toolCall?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  reasoning?: string;
  isCompleted?: boolean;
  isCollapsed?: boolean;
  /** Codex Turn owning this projected message, when available. */
  codexTurnId?: string;
  /** Native provider turn duration in milliseconds, when available. */
  turnDurationMs?: number;
}

/** Display categories for messages that are not ordinary human/agent text. */
export type AgentMessageType =
  | "context-compaction"
  | "goal-round"
  | "goal-complete"
  | "goal-blocked"
  /** DSH-owned slash command input/result rows projected from its event log. */
  | "dsh-command"
  | "dsh-command-result"
  /** Legacy classification for older `/plan` history projections. */
  | "dsh-command-prompt"
  /** Product-owned row for Codex-native `/compact` and `/goal` operations. */
  | "codex-command";

// Tool call definition
export interface ToolCall {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  result?: string;
  args?: string;
}

// Stream events from agent —— 与后端 `AgentChunk` 1:1 镜像, 由
// `client.ts:listenToAgentStream` 监听 `agent-chunk` 通道消费。替代
// 之前的 `[REASONING]:` / `[TOOL_CALL]:` / `[TOOL_RESULT]:` / `[ERROR]:` 字符串前缀协议,
// 用判别联合 (kind) 代替 startsWith。
//
// 字段命名 —— snake_case: Tauri `app.emit("agent-chunk", &chunk)` 不做字段重命名, serde 原样输出。
// 这与 IPC command args/returns 的 camelCase 约定是两套规则 (后者有 Tauri 自动转换)。
export type AgentChunk =
  | AgentChunkUserMessage
  | AgentChunkText
  | AgentChunkReasoning
  | AgentChunkContextCompaction
  | AgentChunkToolCall
  | AgentChunkToolResult
  | AgentChunkDshCommand
  | AgentChunkCodexCommand
  | AgentChunkError
  | AgentChunkStreamStart
  | AgentChunkStreamEnd
  | AgentChunkSessionResolved
  | AgentChunkUsage;

export interface AgentChunkUserMessage {
  kind: "user_message";
  thread_id: string;
  id: string;
  text: string;
  timestamp: number;
  message_type?: AgentMessageType;
  agent_type?: AgentTypeKey;
  run_id?: string;
  message_id?: string;
  source_message_id?: string;
}

export interface AgentChunkText {
  kind: "text";
  thread_id: string;
  text: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
  message_id?: string;
  source_message_id?: string;
  message_phase?: "started" | "updated" | "completed";
  content_mode?: "delta" | "snapshot";
  source_timestamp?: number;
  source_sequence?: number;
  source_subsequence?: number;
}

export interface AgentChunkReasoning {
  kind: "reasoning";
  thread_id: string;
  text: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
  message_id?: string;
  source_message_id?: string;
  message_phase?: "started" | "updated" | "completed";
  content_mode?: "delta" | "snapshot";
  source_timestamp?: number;
  source_sequence?: number;
  source_subsequence?: number;
}

export interface AgentChunkContextCompaction {
  kind: "context_compaction";
  thread_id: string;
  id: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
  message_id?: string;
  source_message_id?: string;
  codex_turn_id?: string;
  message_phase?: "started" | "updated" | "completed";
  content_mode?: "delta" | "snapshot";
  source_timestamp?: number;
  source_sequence?: number;
  source_subsequence?: number;
}

export interface AgentChunkToolCall {
  kind: "tool_call";
  thread_id: string;
  id: string;
  name: string;
  input: unknown;
  agent_type?: AgentTypeKey;
  run_id?: string;
  message_id?: string;
  source_message_id?: string;
  message_phase?: "started" | "updated" | "completed";
  source_timestamp?: number;
  source_sequence?: number;
  source_subsequence?: number;
  reasoning_boundary?: boolean;
}

export interface AgentChunkToolResult {
  kind: "tool_result";
  thread_id: string;
  id: string;
  name: string;
  result: unknown;
  agent_type?: AgentTypeKey;
  run_id?: string;
  message_id?: string;
  source_message_id?: string;
  message_phase?: "started" | "updated" | "completed";
  source_timestamp?: number;
  source_sequence?: number;
  source_subsequence?: number;
}

export interface AgentChunkDshCommand {
  kind: "dsh_command";
  thread_id: string;
  id: string;
  name: string;
  args: string;
  status: "pending" | "success" | "error" | "cancelled";
  result?: string;
  timestamp: number;
  agent_type?: AgentTypeKey;
  run_id?: string;
  message_id?: string;
  source_sequence?: number;
}

export interface AgentChunkCodexCommand {
  kind: "codex_command";
  thread_id: string;
  id: string;
  command: string;
  status: "pending" | "success" | "error" | "cancelled";
  result?: string;
  timestamp: number;
  agent_type?: AgentTypeKey;
  run_id?: string;
  message_id?: string;
  source_sequence?: number;
}

export interface AgentChunkError {
  kind: "error";
  thread_id: string;
  message: string;
  error_details?: AgentErrorDetailsWire;
  agent_type?: AgentTypeKey;
  run_id?: string;
  message_id?: string;
  source_message_id?: string;
}

/** Raw Tauri event shape; unlike the normalized message/event model it uses
 * snake_case because `agent-chunk` is emitted directly by serde. */
export interface AgentErrorDetailsWire {
  category: string;
  status_code?: number;
  request_id?: string;
  retry_after?: string;
  exit_code?: number;
  upstream_message?: string;
  source?: string;
  retryable: boolean;
}

// 生命周期变体 —— 由后端 `chat_stream` 外层在 insert / remove cancel_flag
// 时各 emit 一次。覆盖所有退出路径 (Ok / Err / panic-via-drop)。前端
// chat-store 据此翻 `threadStates[tid].isLoading`, 不再依赖 IPC finally。
export interface AgentChunkStreamStart {
  kind: "stream_start";
  thread_id: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
  /**
   * 通用 metadata 协议字段 —— 该 run 锁定的 LLM model id. 后端在 spawn 时确定 (从用户配置 / CLI override 解析), 对 OpenAI /
   * Codex / Claude / Gemini 等所有 provider 一致, 字段不识别时为 undefined. 前端读 `run.model ?? threadStates[tid].runs[activeRunId].model` 取值.
   */
  model?: string;
  /**
   * 通用 metadata 协议 —— reasoning effort ("low"/"medium"/"high"/"xhigh"). Provider 不支持时为 undefined.
   */
  reasoning_effort?: string;
}

export interface AgentChunkStreamEnd {
  kind: "stream_end";
  thread_id: string;
  /** null = 正常完成; string = 异常退出 (e.g. "agent stuck: ...") */
  reason: string | null;
  /** Native provider turn duration in milliseconds, when available. */
  duration_ms?: number;
  agent_type?: AgentTypeKey;
  run_id?: string;
}
/**
 * Token usage breakdown — nested object emitted on `usage` field of the
 * `AgentChunk::Usage` wire variant. Mirrors Rust
 * [`crate::agent_wire::UsageInfo`]. Fields are all optional so providers that
 * only report `total_tokens` can still send a chunk without zero-filling.
 *
 * `total_tokens` is the sum used by the Rust `token_budget` cross-cycle
 * breaker. `input_tokens` / `output_tokens` are new-protocol fields;
 * `cached_input_tokens` is the cache-hit portion;
 * `reasoning_output_tokens` is o-series style internal consumption;
 * `model_context_window` is the provider-reported context window for UI.
 * `context_used_tokens` is the Harness projected context occupancy.
 *
 * Compatibility: prompt/completion fields intentionally omitted — older
 * providers that only report them are mapped to input/output at SSE-parse
 * time so the wire shape stays clean.
 */
export interface UsageInfo {
  input_tokens?: number | null;
  cached_input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  total_tokens?: number | null;
  model_context_window?: number | null;
  context_used_tokens?: number | null;
}

/**
 * Provider-specific status snapshot — nested object emitted on the
 * `status_info` field of `AgentChunk::Usage`. Mirrors Rust
 * [`crate::agent_wire::StatusInfo`]. Fields use `codex_` / `claude_` /
 * `hermes_` prefixes for flat namespace; no nested `codex: CodexStatus`
 * sub-struct. Latest-snapshot semantics, not accumulated.
 */
export interface StatusInfo {
  codex_plan_type?: string | null;
  codex_used_percent?: number | null;
  codex_resets_at?: number | null;
}

/**
 * Wire-protocol `usage` chunk variant. Top-level metadata
 * (`model_id` / `last_run_at`) is preserved at the top level;
 * token breakdown lives under `usage`; provider status snapshot lives
 * under `status_info`. See [`UsageInfo`] and [`StatusInfo`].
 */
export interface AgentChunkUsage {
  kind: "usage";
  thread_id: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
  model_id?: string | null;
  last_run_at?: number | null;
  usage?: UsageInfo | null;
  status_info?: StatusInfo | null;
}

export interface AgentChunkSessionResolved {
  kind: "session_resolved";
  thread_id: string;
  session_id: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
}

/**
 * Shared terminal status for `runs[runId]` and `lastRun`.
 */
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentRunState {
  runId: string;
  agentType: AgentTypeKey;
  threadId: string;
  status: AgentRunStatus;
  startedAt: number;
  endedAt?: number;
  currentTool?: string | null;
  reason?: string | null;
  // ── 通用 metadata 协议字段 (由 StreamStart chunk 填充) ──
  /** 该 run 锁定的 LLM model id,启动时写入不再变更 */
  model?: string;
  modelId?: string;
  lastRunAt?: number;
      /** 通用 metadata 协议 —— reasoning effort ("low"/"medium"/"high"/"xhigh")。Provider 不支持时为 undefined。 */
  reasoning_effort?: string;
  usage?: UsageInfo;
  /**
   * Provider-specific status snapshot — overwritten on every chunk.
   */
  statusInfo?: StatusInfo;
}

export type AgentToolDisplayKind =
  | "command"
  | "file"
  | "search"
  | "network"
  | "todo"
  | "patch"
  | "question"
  | "generic";

export interface AgentToolDisplay {
  summary?: string;
  title?: string;
  kind?: AgentToolDisplayKind;
}

interface AgentEventBase {
  agentType: AgentTypeKey;
  threadId: string;
  runId: string;
  timestamp: number;
  messageId?: string;
  messagePhase?: "started" | "updated" | "completed";
  contentMode?: "delta" | "snapshot";
  sourceTimestamp?: number;
  sourceSequence?: number;
  sourceSubsequence?: number;
  reasoningBoundary?: boolean;
  codexTurnId?: string;
}

export type AgentEvent =
  | (AgentEventBase & {
      kind: "stream_start";
      /** 通用 metadata 协议字段 —— 该 run 锁定的 LLM model id。后端在 spawn 时确定 (从用户配置 / CLI override 解析), 对 OpenAI / Codex / Claude / Gemini 等所有 provider 一致, 字段不识别时为 undefined。前端读 `run.model ?? threadStates[tid].runs[activeRunId].model` 取值。 */
      model?: string;
      /** 通用 metadata 协议 —— reasoning effort ("low"/"medium"/"high"/"xhigh")。Provider 不支持时为 undefined。 */
      reasoning_effort?: string;
    })
  | (AgentEventBase & { kind: "text_delta"; text: string })
  | (AgentEventBase & {
      kind: "user_message";
      id: string;
      text: string;
      messageType?: AgentMessageType;
    })
  | (AgentEventBase & { kind: "final_message"; text: string })
  | (AgentEventBase & { kind: "reasoning_delta"; text: string })
  | (AgentEventBase & { kind: "context_compaction"; id: string })
  | (AgentEventBase & {
      kind: "tool_call";
      toolCallId: string;
      name: string;
      input: unknown;
      reasoningBoundary?: boolean;
    })
  | (AgentEventBase & {
      kind: "tool_result";
      toolCallId: string;
      name: string;
      result: unknown;
    })
  | (AgentEventBase & {
      kind: "dsh_command";
      id: string;
      name: string;
      args: string;
      status: "pending" | "success" | "error" | "cancelled";
      result?: string;
    })
  | (AgentEventBase & {
      kind: "codex_command";
      id: string;
      command: string;
      status: "pending" | "success" | "error" | "cancelled";
      result?: string;
    })
  | (AgentEventBase & {
      kind: "error";
      message: string;
      errorDetails?: AgentErrorDetails;
    })
  | (AgentEventBase & {
      kind: "stream_end";
      reason: string | null;
      durationMs?: number;
    })
  | (AgentEventBase & { kind: "session_resolved"; sessionId: string })
  | (AgentEventBase & {
      kind: "usage";
      /** Top-level metadata preserved from the wire chunk. */
      modelId?: string | null;
      lastRunAt?: number | null;
      /** Nested token usage breakdown — see [`UsageInfo`]. */
      usage?: UsageInfo | null;
      /** Provider-specific status snapshot — see [`StatusInfo`]. */
      statusInfo?: StatusInfo | null;
    });

// `agent_running_threads` IPC 返回值 —— camelCase, 走 IPC command 返回路径, Tauri 自动从 Rust snake_case (`started_at` / `current_tool`) 转
// camelCase (`startedAt` / `currentTool`)。
export interface RunInfo {
  startedAt: number;
  currentTool: string | null;
  agentType?: AgentTypeKey;
  runId?: string;
  pendingThreadId?: string | null;
  sessionId?: string | null;
}

/**
 * 通用 metadata 协议 —— session 的最近一次 run 展示快照。写在
 * `ThreadState.lastRun` 中, run 从 `runs` map 清理后仍作为常驻展示信息保留；
 * 迟到的 usage 事件也会继续合并到这个快照。Provider-agnostic: 对 Codex /
 * Claude / Gemini / Hermes / OpenClaw / DeepSeek Harness 全部适用, 字段不识别时为 undefined。
 */

export interface LastRunSnapshot {
  runId: string;
  agentType: AgentTypeKey;
  startedAt: number;
  endedAt?: number;
  /** LLM model id,启动时锁定。Provider 不支持 / 未透传时为 undefined。*/
  model?: string;
  modelId?: string;
  lastRunAt?: number;
  /** Accumulated token usage — preserved after run ends so badges can still
   * read totals. See [`UsageInfo`]. */
  usage?: UsageInfo;
  /** Provider-specific status snapshot — see [`StatusInfo`]. */
  statusInfo?: StatusInfo;
  /** 最终状态 —— 正常完成 / 失败 / 取消。*/
  status: AgentRunStatus;
  /** 失败 / 取消原因;正常完成时为 undefined。*/
  reason?: string | null;
}

// Re-export for backwards compatibility
export type MessageType = ChatMessage;
