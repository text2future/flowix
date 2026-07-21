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
  "flowix" | "codex" | "claude" | "gemini" | "hermes" | "openclaw";

export interface AgentType {
  key: AgentTypeKey;
  /** 鍥剧墖璧勪骇璺緞(Vite 闈欐€佽祫婧?import 瑙ｆ瀽鍚庣殑 URL)銆?   *  鎵€鏈?agent 鍥炬爣缁熶竴鍦?agent-types.ts 闆嗕腑绠＄悊銆?*/
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
}

export type AgentPermissionMode =
  | "inherit"
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | "yolo";
export type AgentCodexModel = "inherit" | string;
export type AgentCodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface AgentRuntimeConfigBase {
  cwd?: string;
  workspacePaths?: string[];
}

export interface CodexRuntimeConfig extends AgentRuntimeConfigBase {
  model?: AgentCodexModel;
  permissionMode?: AgentPermissionMode;
  reasoningEffort?: AgentCodexReasoningEffort;
}

export interface ClaudeRuntimeConfig extends AgentRuntimeConfigBase {
  model?: AgentCodexModel;
  permissionMode?: AgentPermissionMode;
}

export interface SimpleCliRuntimeConfig extends AgentRuntimeConfigBase {}

export interface HermesRuntimeConfig extends AgentRuntimeConfigBase {
  permissionMode?: AgentPermissionMode;
}

export interface FlowixRuntimeConfig extends AgentRuntimeConfigBase {}

export interface AgentRuntimeConfig {
  codex?: CodexRuntimeConfig;
  claude?: ClaudeRuntimeConfig;
  gemini?: SimpleCliRuntimeConfig;
  hermes?: HermesRuntimeConfig;
  openclaw?: SimpleCliRuntimeConfig;
  flowix?: FlowixRuntimeConfig;
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
}

export interface AccessConfig {
  sandbox: AgentPermissionMode;
}

export interface FilesConfig {
  /** 主工作目录 (path 单值) ── 映射到 message.systemReminderDirectory */
  workspace?: string;
  /** 启用目录列表 (path 数组) */
  folders: string[];
  /** 笔记本路径列表 (path 数组, 与 agent-access-store 同语义) */
  notebooks: string[];
  /**
   * 标记 "此 instance 已经发出过首条消息" 的内嵌位 ── 烧录成功后由
   * `agent-conversation-store.lockInstanceFileSeed()` 设置为 true, 之后
   * `buildInitialInstanceRuntimeConfig()` 不会再用冻结前的暂存或全局
   * 兜底链覆盖这个 instance 的 files, "上次设的偏好" 已经转成只读真值。
   *
   * 字段仅在 JS 层用, 序列化到 backend snapshot 时跟着 files 一起落 SQLite
   * (`runtimeConfig` 走 JSON.stringify), 不需要 backend schema 升级。
   */
  _frozen?: boolean;
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
  /** 预留：工具白名单 */
  tools?: string[];
  /** 预留：cwd 显式覆盖 (当前 files.workspace 优先) */
  cwd?: string;
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
  content: string;
  llmContent?: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
  timestamp: string;
  isLoading?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolAgentType?: AgentTypeKey;
  toolData?: string;
  toolInput?: Record<string, unknown>;
  toolDisplay?: AgentToolDisplay;
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

// Stream events from agent 鈹€鈹€ 涓庡悗绔?`AgentChunk` 1:1 闀滃儚, 鐢?// `client.ts:listenToAgentStream` 鐩戝惉 `agent-chunk` 閫氶亾娑堣垂銆?// 鏇挎崲涔嬪墠 `[REASONING]:` / `[TOOL_CALL]:` / `[TOOL_RESULT]:` / `[ERROR]:`
// 瀛楃涓插墠缂€鍗忚 鈹€鈹€ 鐢ㄥ垽鍒仈鍚?(kind) 鏇夸唬 startsWith銆?//
// **瀛楁鍛藉悕 鈹€鈹€ snake_case**: Tauri `app.emit("agent-chunk", &chunk)`
// 涓嶅仛瀛楁閲嶅懡鍚? serde 鍘熸牱杈撳嚭銆俙thread_id` 鍦?JSON 閲屽氨鏄?`thread_id`,
// TS 绔闂?`chunk.thread_id`銆傝繖璺?IPC command args/returns 鐨?camelCase
// 绾﹀畾鏄袱濂楄鍒?鈹€鈹€ 鍚庤€呮湁 Tauri 鑷姩杞崲, 鍓嶈€呮病鏈? 涓嶈娣?// (涓?`memo-event` 鐨?`payload.memo` / `payload.source` 鍚屽舰)銆?
export type AgentChunk =
  | AgentChunkText
  | AgentChunkReasoning
  | AgentChunkToolCall
  | AgentChunkToolResult
  | AgentChunkError
  | AgentChunkStreamStart
  | AgentChunkStreamEnd
  | AgentChunkSessionResolved
  | AgentChunkUsage;

export interface AgentChunkText {
  kind: "text";
  thread_id: string;
  text: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
}

export interface AgentChunkReasoning {
  kind: "reasoning";
  thread_id: string;
  text: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
}

export interface AgentChunkToolCall {
  kind: "tool_call";
  thread_id: string;
  id: string;
  name: string;
  input: unknown;
  agent_type?: AgentTypeKey;
  run_id?: string;
}

export interface AgentChunkToolResult {
  kind: "tool_result";
  thread_id: string;
  id: string;
  name: string;
  result: unknown;
  agent_type?: AgentTypeKey;
  run_id?: string;
}

export interface AgentChunkError {
  kind: "error";
  thread_id: string;
  message: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
}

// 鐢熷懡鍛ㄦ湡鍙樹綋 鈹€鈹€ 鐢卞悗绔?`chat_stream` 澶栧眰鍦?insert / remove cancel_flag
// 鏃跺悇 emit 涓€娆°€傝鐩栨墍鏈夐€€鍑鸿矾寰?(Ok / Err / panic-via-drop)銆傚墠绔?// chat-store 鎹鏀舵暃 `threadStates[tid].isLoading`, 涓嶅啀渚濊禆 IPC finally銆?
export interface AgentChunkStreamStart {
  kind: "stream_start";
  thread_id: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
  /**
   * 閫氱敤 metadata 鍗忚瀛楁 鈹€鈹€ 璇?run 閿佸畾鐨?LLM model id銆?   * 鍚庣鍦?spawn 鏃剁‘瀹?浠庣敤鎴烽厤缃?CLI override 瑙ｆ瀽),瀵?OpenAI /
   * Codex / Claude / Gemini 绛夋墍鏈?provider 涓€鑷?瀛楁涓嶈瘑鍒椂涓?undefined銆?   * 鍓嶇璇?`run.model ?? threadStates[tid].runs[activeRunId].model` 鍙栧€笺€?   */
  model?: string;
  /**
   * 閫氱敤 metadata 鍗忚瀛楁 鈹€鈹€ reasoning effort("low"/"medium"/"high"/"xhigh")銆?   * Provider 涓嶆敮鎸佹椂涓?undefined銆?   */
  reasoning_effort?: string;
}

export interface AgentChunkStreamEnd {
  kind: "stream_end";
  thread_id: string;
  /** null = 姝ｅ父瀹屾垚; string = 寮傚父閫€鍑?(e.g. "agent stuck: ...") */
  reason: string | null;
  agent_type?: AgentTypeKey;
  run_id?: string;
}

/**
 * Token usage breakdown — nested object emitted on `usage` field of the
 * `AgentChunk::Usage` wire variant. Mirrors Rust
 * [`crate::agent_flowix::UsageInfo`]. Fields are all optional so providers that
 * only report `total_tokens` can still send a chunk without zero-filling.
 *
 * `total_tokens` is the sum used by the Rust `token_budget` cross-cycle
 * breaker. `input_tokens` / `output_tokens` are new-protocol fields;
 * `cached_input_tokens` is the cache-hit portion;
 * `reasoning_output_tokens` is o-series style internal consumption;
 * `model_context_window` is the provider-reported context window for UI.
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
}

/**
 * Provider-specific status snapshot — nested object emitted on the
 * `status_info` field of `AgentChunk::Usage`. Mirrors Rust
 * [`crate::agent_flowix::StatusInfo`]. Fields use `codex_` / `claude_` /
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
  // 鈹€鈹€ 閫氱敤 metadata 鍗忚瀛楁 (鐢?StreamStart chunk 濉厖) 鈹€鈹€
  /** 璇?run 閿佸畾鐨?LLM model id,鍚姩鏃跺啓鍏ヤ笉鍐嶅彉鏇?*/
  model?: string;
  modelId?: string;
  lastRunAt?: number;
  /** 璇?run 閿佸畾鐨?reasoning effort,鍚姩鏃跺啓鍏?*/
  reasoningEffort?: string;
  /**
   * Accumulated token usage — fed by multiple Usage chunks during the run.
   */
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
}

export type AgentEvent =
  | (AgentEventBase & {
      kind: "stream_start";
      /**
       * 閫氱敤 metadata 鍗忚 鈹€鈹€ 璇?run 閿佸畾鐨?LLM model id銆?       * 浠?AgentChunkStreamStart.model 閫忎紶,涓嶈瘑鍒椂涓?undefined銆?       */
      model?: string;
      /**
       * 閫氱敤 metadata 鍗忚 鈹€鈹€ reasoning effort ("low"/"medium"/"high"/"xhigh")銆?       * Provider 涓嶆敮鎸佹椂涓?undefined銆?       */
      reasoningEffort?: string;
    })
  | (AgentEventBase & { kind: "text_delta"; text: string })
  | (AgentEventBase & { kind: "final_message"; text: string })
  | (AgentEventBase & { kind: "reasoning_delta"; text: string })
  | (AgentEventBase & {
      kind: "tool_call";
      toolCallId: string;
      name: string;
      input: unknown;
      display?: AgentToolDisplay;
    })
  | (AgentEventBase & {
      kind: "tool_result";
      toolCallId: string;
      name: string;
      result: unknown;
    })
  | (AgentEventBase & { kind: "error"; message: string })
  | (AgentEventBase & { kind: "stream_end"; reason: string | null })
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

// `agent_running_threads` IPC 杩斿洖鍊?鈹€鈹€ camelCase, 璧?IPC command 杩斿洖
// 璺緞, Tauri 鑷姩浠?Rust snake_case (`started_at` / `current_tool`) 杞?// camelCase (`startedAt` / `currentTool`)銆?
export interface RunInfo {
  startedAt: number;
  currentTool: string | null;
  agentType?: AgentTypeKey;
  runId?: string;
  pendingThreadId?: string | null;
  sessionId?: string | null;
}

/**
 * 閫氱敤 metadata 鍗忚 鈹€鈹€ 涓€娆?run 鐨?灞曠ず蹇収"銆? * 鍐欏湪 `ThreadState.lastRun` 涓?鍦?run 缁撴潫(applyRunEnded)鍚?鍗充娇璇?run
 * 宸茶浠?`runs` map 涓竻鐞?灞曠ず鐢ㄧ殑 metadata 浠嶇劧鍙 鈹€鈹€ BadgeHoverCard
 * 鍗充緷璧栬繖涓瓧娈靛湪"浼氳瘽宸茬粨鏉?鏃朵粛鑳借鍑?sessionId/model/elapsed/totalTokens銆? * Provider-agnostic:瀵?Codex / Claude / Gemini / Flowix / Hermes / OpenClaw
 * 鍏ㄩ儴閫傜敤,瀛楁涓嶈瘑鍒椂涓?undefined銆? */
export interface LastRunSnapshot {
  runId: string;
  agentType: AgentTypeKey;
  startedAt: number;
  endedAt?: number;
  /** LLM model id,鍚姩鏃堕攣瀹氥€侾rovider 涓嶆敮鎸?/ 鏈€忎紶鏃朵负 undefined銆?*/
  model?: string;
  modelId?: string;
  lastRunAt?: number;
  /** Accumulated token usage — preserved after run ends so badges can still
   * read totals. See [`UsageInfo`]. */
  usage?: UsageInfo;
  /** Provider-specific status snapshot — see [`StatusInfo`]. */
  statusInfo?: StatusInfo;
  /** 鏈€缁堢姸鎬?鈹€鈹€ 姝ｅ父瀹屾垚 / 澶辫触 / 鍙栨秷銆?*/
  status: AgentRunStatus;
  /** 澶辫触 / 鍙栨秷鍘熷洜;姝ｅ父瀹屾垚鏃朵负 undefined銆?*/
  reason?: string | null;
}

// Re-export for backwards compatibility
export type MessageType = ChatMessage;
