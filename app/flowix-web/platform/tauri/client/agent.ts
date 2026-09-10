import { invoke } from '@tauri-apps/api/core';
import { subscribe, type SubscribeOptions } from '@platform/tauri/event-bus';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type {
  AgentChunk,
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentRuntimeConfig,
  AgentTypeKey,
  ChatMessage,
  RunInfo,
  UsageInfo,
} from '@/types/agent';

export interface AgentConfig {
  provider: string;
  /** Harness custom-provider route ID. Empty for built-in catalog providers. */
  providerId?: string;
  /** Human-readable name for a custom Harness provider. */
  displayName?: string;
  /** Wire protocol selected for a custom Harness provider. */
  apiProtocol?: string;
  /** DSH credentials-service reference for this provider route. */
  apiKeyEnv?: string;
  model: string;
  /** Custom Harness provider model directory. */
  models?: AgentModelConfig[];
  apiUrl: string;
  /** 按 provider 隔离的秘钥桶。切换供应商时直接读这桶, 互不串。 */
  apiKeys: Record<string, string>;
  /** DSH owns a key for apiKeyEnv. The secret itself is never returned. */
  credentialConfigured?: boolean;
}

export interface AgentModelConfig {
  id: string;
  name?: string;
}

export interface AgentConversationCursor {
  updatedAt: number;
  instanceId: string;
}

export interface AgentConversationListQuery {
  notebookId: string | null;
  agentType: AgentTypeKey | null;
  cursor: AgentConversationCursor | null;
}

export interface AgentConversationListPage {
  items: AgentConversationInstance[];
  hasMore: boolean;
  nextCursor: AgentConversationCursor | null;
}

export interface AgentConversationTypeCount {
  agentType: string;
  count: number;
}

// Result of a one-shot DeepSeek Harness probe.
// Mirrors `connection_probe::TestConnectionResult` on the Rust side
// (`#[serde(rename_all = "camelCase")]`):
//   latency_ms -> latencyMs, model_id -> modelId.
export type TestConnectionErrorKind =
  // Pre-flight failure: provider / model / apiKey / apiUrl missing or
  // malformed. Caller should fix the form, not retry.
  | 'bad_config'
  // Provider string didn't normalise to any known backend.
  | 'unsupported_provider'
  // 401 / 403 — wrong or revoked API key.
  | 'auth_failed'
  // 404 — model id unknown, or endpoint path wrong.
  | 'not_found'
  // 429 — rate-limited upstream.
  | 'rate_limited'
  // 5xx — provider side outage.
  | 'server_error'
  // 4xx other than the above — usually a malformed request body.
  | 'bad_request'
  // DNS / TCP / TLS failure surfaced by reqwest.
  | 'network_unreachable'
  // Provider returned a body that isn't valid JSON.
  | 'invalid_response'
  // Catch-all (retry-exhausted, generic provider errors, ...).
  | 'other';

export interface TestConnectionError {
  kind: TestConnectionErrorKind;
  /** Raw error from the backend — `[<LLMError variant>] <message>`.
   *  Intended for the developer console / toast detail, not the
   *  user-facing inline note (use the kind to pick that). */
  message: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  /** Model id that was actually probed (echoed back). */
  modelId: string;
  /** First up-to-80 chars of the model's text response. Empty when
   *  the model only emitted reasoning / tool_calls. */
  summary: string;
  error?: TestConnectionError;
}

interface ChatResponse {
  response: string;
}

interface AgentUserMessage {
  content: string;
  llmContent?: string;
  imagePaths?: string[];
  runId?: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
  agentType?: AgentTypeKey;
  runtimeConfig?: AgentRuntimeConfig;
  permissionMode?: AgentPermissionMode;
  codexModel?: AgentCodexModel;
  codexReasoningEffort?: AgentCodexReasoningEffort;
  agentRoleMemoId?: string;
  agentRoleName?: string;
  conversationTitle?: string;
}

export interface ThreadInfo {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentExternalEvent {
  id: number;
  runtime: AgentTypeKey;
  threadId: string;
  normalizedJson: string;
  rawJson?: string | null;
  createdAt: number;
}

export interface CodexApprovalRequest {
  requestId: string;
  method: string;
  threadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  params: Record<string, unknown>;
}

export type AgentConversationSource = {
  kind: 'thread-card' | 'dedicated';
  documentPath?: string | null;
  memoId?: string | null;
  notebookId?: string | null;
};

export interface AgentConversationRole {
  memoId?: string | null;
  name?: string | null;
}

export interface AgentConversationInstance {
  instanceId: string;
  agentType: AgentTypeKey;
  /** Product title projected from threads.title; null before a thread exists. */
  threadTitle: string | null;
  threadId: string | null;
  /** Provider-owned session id read from the durable provider binding. */
  sessionId?: string | null;
  runtimeConfig?: string | null;
  /** Backend-owned cwd; omitted from conversation upsert requests. */
  readonly frozenCwd?: string | null;
  source: AgentConversationSource;
  role?: AgentConversationRole | null;
  createdAt: number;
  updatedAt: number;
}

export type AgentConversationInstanceUpsert = Omit<AgentConversationInstance, 'threadTitle' | 'sessionId' | 'runtimeConfig'> & {
  /** Initial title used when the upsert creates the product thread. */
  initialTitle: string;
  runtimeConfig?: string | null;
};

export interface AgentRuntimeAvailability {
  available: boolean;
  reason?: string | null;
}

export interface AgentRuntimeStatus {
  codex: AgentRuntimeAvailability;
  claude: AgentRuntimeAvailability;
  gemini: AgentRuntimeAvailability;
  hermes: AgentRuntimeAvailability;
  openclaw: AgentRuntimeAvailability;
  opencode: AgentRuntimeAvailability;
  'deepseek-harness': AgentRuntimeAvailability;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexRateLimitResetCredits {
  availableCount?: number | null;
}

export interface CodexRuntimeInfo {
  account?: { type?: string; email?: string | null; planType?: string } | null;
  rateLimits?: {
    rateLimitResetCredits?: CodexRateLimitResetCredits | null;
    rateLimitsByLimitId?: Record<string, {
      limitName?: string | null;
      primary?: CodexRateLimitWindow | null;
      secondary?: CodexRateLimitWindow | null;
    }> | null;
  } | null;
  usage?: UsageInfo | null;
}

export interface CodexCapabilityResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface CodexProjectCapabilities {
  cwd: string;
  skills: CodexCapabilityResult;
  config: CodexCapabilityResult;
  requirements: CodexCapabilityResult;
  models: CodexCapabilityResult;
  mcp: CodexCapabilityResult;
  plugins: CodexCapabilityResult;
  pluginCatalog: CodexCapabilityResult;
  agents: CodexCapabilityResult;
  experiments: CodexCapabilityResult;
  projectConfigPath: string;
  refreshedAt: number;
}
export type AgentExternalSource = 'auto' | 'user';

export interface AgentExternalEntry {
  path: string | null;
  source: AgentExternalSource;
  available: boolean;
}

export const agent = {
  runtimeStatus: () =>
    invoke<AgentRuntimeStatus>('agent_runtime_status'),
  openCodexCliInstallTerminal: () =>
    invoke<void>('open_codex_cli_install_terminal'),
  openCodexConfig: () =>
    invoke<void>('open_codex_config'),
  // ── External CLI 路径配置 (~/.flowix/agent-external-config.json) ──
  // 唯一参照: 启动探测写入, 偏好设置可改 path / 重新探测。
  getExternalConfig: () =>
    invoke<Record<string, AgentExternalEntry>>('get_agent_external_config'),
  setExternalPath: (agentType: string, path: string) =>
    invoke<AgentExternalEntry>('set_agent_external_path', { agentType, path }),
  redetectExternal: (agentType: string) =>
    invoke<AgentExternalEntry>('redetect_agent_external', { agentType }),
  selectExternalCliPath: () =>
    invoke<string | null>('select_external_cli_path'),
  cacheImage: (content: string, mimeType: string) =>
    invoke<CachedAgentImage>('cache_agent_image', { content, mimeType }),
  deleteCachedImage: (path: string) =>
    invoke<boolean>('delete_cached_agent_image', { path }),
  readCachedImage: (path: string) =>
    invoke<string | null>('read_cached_agent_image', { path }),
  chatStream: (threadId: string, message: AgentUserMessage) =>
    invoke<ChatResponse>('chat_with_agent_stream', { threadId, message }),
  steerChat: (threadId: string, message: AgentUserMessage, clientUserMessageId: string) =>
    invoke<void>('steer_agent_stream', { threadId, message, clientUserMessageId }),
  executeDeepSeekHarnessCommand: (threadId: string, command: string, message: AgentUserMessage) =>
    invoke<unknown>('execute_deepseek_harness_command', { threadId, command, message }),
  listDeepSeekHarnessSkills: (threadId: string, message: AgentUserMessage) =>
    invoke<{ skills: Array<{ name: string; description: string; whenToUse?: string; modelInvocable?: boolean }> }>(
      'deepseek_harness_skill_catalog',
      { threadId, message },
    ),
  // 缁堟杩愯涓殑 chat_stream銆傚悗绔?AgentManager.stop_chat 缈昏浆 cancel flag,
  // 姝ｅ湪璺戠殑 ReAct 寰幆鍦ㄤ笅涓€涓?checkpoint 妫€娴嬪埌鍚庤皟 flush_cancel 閫€鍑恒€?
  // 杩斿洖 true = 鎴愬姛瑙﹀彂浜嗗彇娑? false = 褰撳墠娌℃湁 chat 鍦ㄨ窇 (no-op)銆?
  stopChatStream: (threadId: string, agentType?: AgentTypeKey, runId?: string) =>
    invoke<boolean>('stop_agent_stream', { threadId, agentType, runId }),
  // 鏌ヨ褰撳墠 in-flight chat 闆嗗悎 鈹€鈹€ 鍚姩鏃跺墠绔皟涓€娆? seed
  // `threadStates[].isLoading`銆?绌?map 琛ㄧず褰撳墠娌℃湁 in-flight chat銆?
  // 鍚庣闀滃儚 `cancel_flags` 鐨勭敓鍛藉懆鏈? 涓?`StreamStart/End` chunk 鍚屾銆?
  runningThreads: () =>
    invoke<Record<string, RunInfo>>('agent_running_threads'),
  backgroundTerminals: (threadId: string) =>
    invoke<unknown>('agent_background_terminals', { threadId }),
  backgroundJobs: (threadId: string) =>
    invoke<unknown>('agent_background_jobs', { threadId }),
  externalEvents: (threadId: string, afterId?: number | null, limit?: number) =>
    invoke<AgentExternalEvent[]>('agent_external_events', { threadId, afterId, limit }),
  listThreads: () =>
    invoke<ThreadInfo[]>('thread_list'),
  listLocalAgentThreads: (agentType: AgentTypeKey) =>
    invoke<ThreadInfo[]>('local_agent_thread_list', { agentType }),
  createThread: (title: string) =>
    invoke<ThreadInfo>('thread_create', { title }),
  getThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('thread_get', { threadId }),
  /**
   * Layer 4: 鍒嗛〉鍔犺浇 thread 鍘嗗彶 (limit = complete turns).
   * 杩斿洖 { messages (ASC), oldestSequence, hasMore }.
   *  - beforeSequence = null/undefined 鈫?鍙栨渶杩?limit 鏉?   *  - beforeSequence = N 鈫?鍙?sequence < N 鐨勬渶杩?limit 鏉?(鍚戜笂缈婚〉)
   * 鏈嶅姟绔?clamp limit 鍒?[1, 1000].
   */
  getThreadPage: (
    threadId: string,
    beforeSequence: number | null,
    limit: number,
  ) =>
    invoke<{
      messages: ChatMessage[];
      oldestSequence: number | null;
      hasMore: boolean;
    }>('thread_get_page', { threadId, beforeSequence, limit }),
  listConversationInstances: () =>
    invoke<AgentConversationInstance[]>('agent_conversation_list'),
  listConversationInstancesPage: (query: AgentConversationListQuery, limit: number) =>
    invoke<AgentConversationListPage>('agent_conversation_list_page', { ...query, limit }),
  countConversationInstancesByNotebook: (notebookId: string | null) =>
    invoke<number>('agent_conversation_count_by_notebook', { notebookId }),
  listConversationTypeCountsByNotebook: (notebookId: string | null) =>
    invoke<AgentConversationTypeCount[]>('agent_conversation_type_counts_by_notebook', { notebookId }),
  getConversationInstance: (instanceId: string) =>
    invoke<AgentConversationInstance | null>('agent_conversation_get', {
      instanceId,
    }),
  findConversationByThread: (threadId: string) =>
    invoke<AgentConversationInstance | null>(
      'agent_conversation_find_by_thread',
      { threadId },
    ),
  upsertConversationInstance: (instance: AgentConversationInstanceUpsert) =>
    invoke<AgentConversationInstance>('agent_conversation_upsert', { instance }),
  deleteConversationInstance: (instanceId: string) =>
    invoke<boolean>('agent_conversation_delete', { instanceId }),
  deleteConversationInstancesForThread: (threadId: string) =>
    invoke<number>('agent_conversation_delete_for_thread', { threadId }),
  listCodexThreads: () =>
    invoke<ThreadInfo[]>('codex_thread_list'),
  getCodexThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('codex_thread_get', { threadId }),
  getCodexThreadPage: (
    threadId: string,
    beforeSequence: number | null,
    limit: number,
    snapshotSequence: number | null = null,
  ) =>
    invoke<{
      messages: ChatMessage[];
      oldestSequence: number | null;
      hasMore: boolean;
      snapshotSequence?: number | null;
    }>('codex_thread_get_page', {
      threadId,
      beforeSequence,
      limit,
      snapshotSequence,
    }),
  getCodexSessionId: (threadId: string) =>
    invoke<string | null>('codex_thread_session_id', { threadId }),
  forkCodexThread: (threadId: string, lastTurnId: string) =>
    invoke<{ thread: ThreadInfo; codexThreadId: string }>('codex_thread_fork', {
      threadId,
      lastTurnId,
    }),
  getCodexDefaultModel: () =>
    invoke<string>('codex_default_model'),
  getCodexRuntimeInfo: (threadId?: string | null) =>
    invoke<CodexRuntimeInfo>('codex_runtime_info', { threadId: threadId ?? null }),
  getCodexProjectCapabilities: (cwd: string, forceReload = false) =>
    invoke<CodexProjectCapabilities>('codex_project_capabilities', { cwd, forceReload }),
  writeCodexProjectConfig: (cwd: string, edits: Array<{ keyPath: string; value: unknown; mergeStrategy: 'replace' | 'upsert' }>, expectedVersion?: string | null) =>
    invoke<{ status: string; version: string; filePath: string; overriddenMetadata?: unknown }>('codex_project_config_write', { cwd, edits, expectedVersion: expectedVersion ?? null }),
  setCodexSkillEnabled: (cwd: string, name: string, enabled: boolean) =>
    invoke<{ effectiveEnabled: boolean }>('codex_skill_enabled_set', { cwd, name, enabled }),
  setCodexPluginInstalled: (cwd: string, pluginId: string, installed: boolean) =>
    invoke<unknown>('codex_plugin_installed_set', { cwd, pluginId, installed }),
  reloadCodexMcp: (cwd: string) => invoke<unknown>('codex_mcp_reload', { cwd }),
  upsertCodexProjectMcp: (cwd: string, name: string, definition: Record<string, unknown>, expectedVersion?: string | null) =>
    invoke<unknown>('codex_project_mcp_upsert', { cwd, name, definition, expectedVersion: expectedVersion ?? null }),
  writeCodexProjectSkill: (cwd: string, name: string, description: string, instructions: string) =>
    invoke<{ path: string }>('codex_project_skill_write', { cwd, name, description, instructions }),
  updateCodexThreadSettings: (args: {
    threadId: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: AgentPermissionMode;
  }) => invoke<void>('codex_thread_settings_update', {
    threadId: args.threadId,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    permissionMode: args.permissionMode,
  }),
  listSupportedModels: (agentType: AgentTypeKey) =>
    invoke<string[]>('agent_supported_models', { agentType }),
  listClaudeThreads: () =>
    invoke<ThreadInfo[]>('claude_thread_list'),
  getClaudeThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('claude_thread_get', { threadId }),
  getClaudeThreadPage: (
    threadId: string,
    beforeSequence: number | null,
    limit: number,
    snapshotSequence: number | null = null,
  ) =>
    invoke<{
      messages: ChatMessage[];
      oldestSequence: number | null;
      hasMore: boolean;
      snapshotSequence?: number | null;
    }>('claude_thread_get_page', {
      threadId,
      beforeSequence,
      limit,
      snapshotSequence,
    }),
  getClaudeSessionId: (threadId: string) =>
    invoke<string | null>('claude_thread_session_id', { threadId }),
  listHermesThreads: () =>
    invoke<ThreadInfo[]>('hermes_thread_list'),
  getHermesThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('hermes_thread_get', { threadId }),
  getHermesThreadPage: (
    threadId: string,
    beforeSequence: number | null,
    limit: number,
    snapshotSequence: number | null = null,
  ) =>
    invoke<{
      messages: ChatMessage[];
      oldestSequence: number | null;
      hasMore: boolean;
      snapshotSequence?: number | null;
    }>('hermes_thread_get_page', {
      threadId,
      beforeSequence,
      limit,
      snapshotSequence,
    }),
  listDeepSeekHarnessThreads: () =>
    invoke<ThreadInfo[]>('deepseek_harness_thread_list'),
  getDeepSeekHarnessThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('deepseek_harness_thread_get', { threadId }),
  getDeepSeekHarnessThreadPage: (
    threadId: string,
    beforeSequence: number | null,
    limit: number,
    snapshotSequence: number | null = null,
  ) =>
    invoke<{
      messages: ChatMessage[];
      oldestSequence: number | null;
      hasMore: boolean;
      snapshotSequence?: number | null;
    }>('deepseek_harness_thread_get_page', {
      threadId,
      beforeSequence,
      limit,
      snapshotSequence,
    }),
  getHermesSessionId: (threadId: string) =>
    invoke<string | null>('hermes_thread_session_id', { threadId }),
  getDeepSeekHarnessSessionId: (threadId: string) =>
    invoke<string | null>('deepseek_harness_thread_session_id', { threadId }),
  forkDeepSeekHarnessThread: (threadId: string, boundarySequence: number) =>
    invoke<{ thread: ThreadInfo; dshThreadId: string }>('deepseek_harness_thread_fork', {
      threadId,
      boundarySequence,
    }),
  getOpenCodeSessionId: (threadId: string) =>
    invoke<string | null>('opencode_thread_session_id', { threadId }),
  listOpenCodeThreads: () =>
    invoke<ThreadInfo[]>('opencode_thread_list'),
  getOpenCodeThreadPage: (
    threadId: string,
    beforeSequence: number | null,
    limit: number,
    snapshotSequence: number | null = null,
  ) =>
    invoke<{
      messages: ChatMessage[];
      oldestSequence: number | null;
      hasMore: boolean;
      snapshotSequence?: number | null;
    }>('opencode_thread_get_page', {
      threadId,
      beforeSequence,
      limit,
      snapshotSequence,
    }),
  deleteThread: (threadId: string) =>
    invoke<void>('thread_delete', { threadId }),
  // 统一的对话生命周期入口: 后端按 agentType 分发到对应 runtime 的 provider
  // 侧 (codex -> thread/archive / thread/delete), 未适配的 runtime 保持
  // Flowix 本地删除语义。
  archiveAgentThread: (agentType: AgentTypeKey, threadId: string) =>
    invoke<{ provider: boolean }>('agent_thread_archive', { agentType, threadId }),
  deleteAgentThread: (agentType: AgentTypeKey, threadId: string) =>
    invoke<{ provider: boolean }>('agent_thread_delete', { agentType, threadId }),
  // 閲嶅懡鍚?thread 鈹€鈹€ 棣栨潯鐢ㄦ埛娑堟伅钀藉湴鍚庤皟涓€娆? 瑕嗙洊 ensureThread 璧?early return
  // 鏃剁殑婕忕綉涔嬮奔(鐐硅繃"鏂板缓瀵硅瘽"鍐嶅彂娑堟伅鐨勫満鏅?銆傝繑鍥?None 琛ㄧず thread 涓嶅瓨鍦ㄣ€?
  updateThreadTitle: (threadId: string, title: string, agentType?: AgentTypeKey) =>
    invoke<ThreadInfo | null>('thread_update_title', { threadId, title, agentType }),
  codexApprovalRespond: (requestId: string, result: unknown) =>
    invoke<void>('codex_approval_respond', { requestId, result }),
};

export interface CachedAgentImage {
  path: string;
  mimeType: string;
  name: string;
}

// Stream event handling
//
// Module-level singleton listener — only ONE registration is allowed. The
// whole app shares a single subscription. `useAgentEvents` mounts once at
// the app.tsx root and dispatches each chunk to chat-store's
// `dispatchAgentChunk` action; multiple components (main / preferences
// window) no longer register their own listeners — preventing the same chunk
// from being processed by multiple handlers.
//
// History: the legacy `listenToAgentStream` was unmounted on each send via
// `stopListeningToAgentStream` in a `finally`. The new model keeps the
// listener alive forever; the dispatcher routes by `thread_id` to the correct
// store state on its own. Older call sites that registered a per-send
// listener (e.g. the deleted sidebar's send pipeline) have all been folded
// into this single dispatch path.
type StreamCallback = (chunk: AgentChunk) => void;

// Standalone CLI installation/status. Memo automation is exposed to external Agents
// through `flowix mcp`; the desktop does not keep a CLI sidecar process alive.
export interface CliLinkStatus {
  targetPath: string | null;
  binDir: string;
  commandPath: string;
  symlinkInstalled: boolean;
  pathConfigured: boolean;
  availableInPath: boolean;
  shellConfigPath: string | null;
  needsInstall: boolean;
  message: string | null;
}

export const cli = {
  linkStatus: () => invoke<CliLinkStatus>('cli_link_status'),
  installPath: () => invoke<CliLinkStatus>('install_cli_path'),
};

// 鍐呴儴浠呬繚鐣欏巻鍙?API 鍚嶅瓧; 瀹炵幇鍏ㄩ儴璧?event-bus銆?// 澶氫釜璋冪敤鐐?(chat-store 涓?useAgentEvents) 鍏变韩鍚屼竴浠?Tauri listener,
// 涓嶅啀闇€瑕佹墜宸ヨ窡韪?streamUnlisten銆?鍘?streamUnlisten 浠呯敤浜庡畬鍏?
// 鍗歌浇 (stopListeningToAgentStream), 鐜板湪涔熻蛋 event-bus.unsubscribe銆?
export function listenToAgentStream(
  callback: StreamCallback,
  options?: SubscribeOptions,
): UnlistenFn {
  return subscribe<AgentChunk>('agent-chunk', callback, options);
}

export function listenToCodexApprovalRequests(
  callback: (request: CodexApprovalRequest) => void,
): UnlistenFn {
  return subscribe<CodexApprovalRequest>('codex-approval-request', callback);
}

// ============================================
// 璺ㄧ獥鍙ｅ悓姝?// ============================================
// 鍚庣 set_preference / set_deepseek_harness_config 鎴愬姛鍚?emit 'user-config-changed',
// payload 鏄?"preference" | "ai_config" 鎸囨槑鍝釜鏂囦欢鍙樹簡銆?// 鍏跺畠绐楀彛鏀跺埌鍚庝粠纾佺洏閲嶆柊 load, 瑙ｅ喅: 涓や釜 Tauri 绐楀彛鍚勮窇鐙珛 React 鏍?// + 鐙珛 zustand store, 涓€杈规敼鍔ㄥ彟涓€杈圭湅涓嶅埌鐨勯棶棰樸€?
export type UserConfigChangeKind = 'preference' | 'dsh_config';
type UserConfigChangeHandler = (kind: UserConfigChangeKind) => void;

export function listenToUserConfigChanges(
  handler: UserConfigChangeHandler,
): UnlistenFn {
  return subscribe<UserConfigChangeKind>('user-config-changed', handler);
}

// 鍘嗗彶鍏煎: useEffect cleanup 浠嶆湁浜烘墜璋冭繖涓┖鍑芥暟(渚嬪
// `preferences/sections/agent.tsx`)銆?鍐呴儴璧?event-bus.unsubscribe 涓嶉渶瑕?
// 鍏ㄩ噺 reset, GC 鑷劧娓呯悊灏辫銆?涓嶅垹閬垮厤鐮村潖璋冪敤鏂广€?
export function stopListeningToUserConfigChanges(): void {
  // 璧?event-bus 鐨?UnlistenFn, 涓氬姟涓婂簲璇ヨ
  // subscribe 杩斿洖鐨?unlisten 璧?useEffect cleanup, 涓嶈鎵嬪伐璋?stopXxx銆?
}

// Agent 鍙闂洰褰曞彉鏇翠簨浠?鈹€鈹€ 鍚庣 set_agent_access / notebook CRUD
// 閽╁瓙浠讳竴鎴愬姛閮?emit, payload 鏄?`()` (鏃?payload), 鐩戝惉鑰呯洿鎺?
// `loadInitial()` 鎷夋暣浠?config銆?涓?`user-config-changed` 鍚屽舰銆?
type AgentAccessChangeHandler = () => void;

export function listenToAgentAccessChanges(
  handler: AgentAccessChangeHandler,
): UnlistenFn {
  return subscribe<unknown>('agent-access-changed', () => handler());
}

export function listenToNotebookImportComplete(
  handler: (notebookId: string) => void,
): UnlistenFn {
  return subscribe<string>('notebook-import-complete', handler);
}

export type NotebookImportStatusKind = 'started' | 'skipped' | 'completed' | 'failed';

export interface NotebookImportStatus {
  notebookId: string;
  status: NotebookImportStatusKind;
  message?: string | null;
}

export function listenToNotebookImportStatus(
  handler: (status: NotebookImportStatus) => void,
): UnlistenFn {
  return subscribe<NotebookImportStatus>('notebook-import-status', handler);
}
