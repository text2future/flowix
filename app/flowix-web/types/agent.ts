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
  "inherit" | "read-only" | "workspace-write" | "danger-full-access";
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
 * 閫氱敤 metadata 鍗忚瀛楁 鈹€鈹€ 涓€娆?token 鐢ㄩ噺澧為噺,涓€娆?run 鍐呭彲琚?emit 澶氭銆? * `prompt_tokens` / `completion_tokens` 鍦ㄩ儴鍒?provider / 鍗忚涓嬩负 null
 * (缃戝叧鏈崟鐙姤鍛?;`total_tokens` 鏄繀椤婚」,浣滀负绱姞鍜屽睍绀哄厹搴曘€? * 鍓嶇鎸?run 绱姞鍒?`AgentRunState.tokenUsage`銆? */
export interface AgentChunkUsage {
  kind: "usage";
  thread_id: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  input_tokens?: number | null;
  cached_input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  model_context_window?: number | null;
  model_id?: string | null;
  codex_plan_type?: string | null;
  codex_used_percent?: number | null;
  codex_resets_at?: number | null;
  last_run_at?: number | null;
  total_tokens: number;
}

export interface AgentChunkSessionResolved {
  kind: "session_resolved";
  thread_id: string;
  session_id: string;
  agent_type?: AgentTypeKey;
  run_id?: string;
}

/**
 * `runs[runId]` 涓?`lastRun` 鍏辩敤鐨?run 缁堟鐘舵€併€? * 姝ｅ父瀹屾垚 鈫?`'completed'`, 鐢ㄦ埛涓诲姩 stop 鈫?`'cancelled'`,
 * 閿欒 / 瓒?cycle / token budget 鈫?`'failed'`銆? *
 * 娉? 涓?`AgentConversationRun.status`(鍚庤€呭涓€涓?`'completed'`) 璇箟瀵归綈 鈹€鈹€
 * `run-lifecycle.applyRunEnded` 鍦ㄦ甯稿畬鎴愭椂鏍?`'completed'`,
 * `agent-conversation-store.markRunEnded` 鍚屾牱 `'completed'`銆? * `AgentThreadCardRunStatusView.status` 涔熸樉寮忓垪鍑?`'completed'` 浣滀负鍚堟硶
 * fallback 鍊笺€備袱杈归暱鏈熶笉涓€鑷?鈫?浼氬鑷?`lastRun.status === 'failed'` 浣? * `instance.run.status === 'completed'` 鐨勫涓嶄笂,灞曠ず灞?read this 鏃跺洶鎯戙€? */
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
  modelContextWindow?: number;
  codexPlanType?: string;
  codexUsedPercent?: number;
  codexResetsAt?: number;
  /**
   * 绱姞鐨?token 鐢ㄩ噺 鈹€鈹€ 鐢卞娆?Usage chunk 绱姞銆?   * 瀛楁鍏ㄩ儴鍙€? 缃戝叧鍙粰 total 涓嶇粰 prompt/completion 鏃?鍚庝袱鑰呬负 undefined銆?   */
  tokenUsage?: {
    prompt?: number;
    completion?: number;
    input?: number;
    cachedInput?: number;
    output?: number;
    reasoningOutput?: number;
    total: number;
  };
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
      /**
       * 閫氱敤 metadata 鍗忚 鈹€鈹€ 涓€娆?token 鐢ㄩ噺澧為噺銆?       * `promptTokens` / `completionTokens` 鍦ㄩ儴鍒?provider / 鍗忚涓嬩负 null
       * (缃戝叧鏈崟鐙姤鍛?;`totalTokens` 鏄繀椤婚」,浣滀负绱姞鍜屽睍绀哄厹搴曘€?       * 鍓嶇鎸?runId 绱姞鍒?`AgentRunState.tokenUsage`銆?       */
      promptTokens?: number | null;
      completionTokens?: number | null;
      inputTokens?: number | null;
      cachedInputTokens?: number | null;
      outputTokens?: number | null;
      reasoningOutputTokens?: number | null;
      modelContextWindow?: number | null;
      modelId?: string | null;
      codexPlanType?: string | null;
      codexUsedPercent?: number | null;
      codexResetsAt?: number | null;
      lastRunAt?: number | null;
      totalTokens: number;
    });

// `agent_running_threads` IPC 杩斿洖鍊?鈹€鈹€ camelCase, 璧?IPC command 杩斿洖
// 璺緞, Tauri 鑷姩浠?Rust snake_case (`started_at` / `current_tool`) 杞?// camelCase (`startedAt` / `currentTool`)銆?
export interface RunInfo {
  startedAt: number;
  currentTool: string | null;
  agentType?: AgentTypeKey;
  runId?: string;
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
  modelContextWindow?: number;
  codexPlanType?: string;
  codexUsedPercent?: number;
  codexResetsAt?: number;
  /** 绱姞鐨?token 鐢ㄩ噺,run 鏈熼棿鐢?Usage chunk 鎸佺画绱姞,run 缁撴潫淇濈暀鏈€缁堝€笺€?*/
  tokenUsage?: {
    prompt?: number;
    completion?: number;
    input?: number;
    cachedInput?: number;
    output?: number;
    reasoningOutput?: number;
    total: number;
  };
  /** 鏈€缁堢姸鎬?鈹€鈹€ 姝ｅ父瀹屾垚 / 澶辫触 / 鍙栨秷銆?*/
  status: AgentRunStatus;
  /** 澶辫触 / 鍙栨秷鍘熷洜;姝ｅ父瀹屾垚鏃朵负 undefined銆?*/
  reason?: string | null;
}

// Re-export for backwards compatibility
export type MessageType = ChatMessage;
