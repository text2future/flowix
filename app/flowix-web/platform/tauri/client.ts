'use client';

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { subscribe, type SubscribeOptions } from '@platform/tauri/event-bus';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { UserSettings } from '@/lib/constants';
import type {
  AgentChunk,
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentRuntimeConfig,
  AgentTypeKey,
  ChatMessage,
  RunInfo,
  StatusInfo,
  UsageInfo,
} from '@/types/agent';
import type { AgentAccessConfig, AgentAccessEntry } from '@/lib/types/agent-access';
import type { MemoColor, MemoItem } from '@features/memo';

// ============================================
// Types
// ============================================

export type { ChatMessage } from '@/types/agent';

// ============================================
// Tauri RPC Client
// ============================================

type RpcRequest = <T = unknown>(method: string, params?: unknown) => Promise<T>;

let rpcInstance: RpcRequest | null = null;

export function initTauriClient(): void {
  rpcInstance = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
    return await invoke<T>(method, params as Record<string, unknown> || {});
  };
  (window as any).__tauriRpc = rpcInstance;
}

// ============================================
// RPC Method Wrappers (for type safety)
// ============================================

// Preferences (backend ~/.flowix/boot/preference.json)
export const preferences = {
  get: () => invoke<UserSettings>('get_preference'),
  set: (preference: UserSettings) => invoke<void>('set_preference', { preference }),
};

export interface FontCacheStatus {
  fontId: string;
  cached: boolean;
}

export interface CachedFontFile {
  family: string;
  weight: string;
  style: string;
  format: string;
  unicodeRange?: string | null;
  path: string;
}

export interface CachedFontResult {
  fontId: string;
  cached: boolean;
  files: CachedFontFile[];
}

export const fontCache = {
  getStatus: () => invoke<FontCacheStatus[]>('get_font_cache_status'),
  ensureCached: (fontId: string) => invoke<CachedFontResult>('ensure_font_cached', { fontId }),
  toAssetUrl: (path: string) => convertFileSrc(path),
};

export interface WebPageMetadata {
  url: string;
  title: string;
  description: string;
  image: string;
}

export interface AgentRoleMemoItem {
  memoId: string;
  roleName: string;
  filename: string;
  memoIcon?: string | null;
  notebookId: string;
  notebookName: string;
  notebookIcon?: string | null;
}

export const web = {
  parsePage: (url: string) => invoke<WebPageMetadata>('parse_web_page', { url }),
};

// AI Config (backend ~/.flowix/agent-config.toml)
// 鈹€ 鐪熸簮鍦ㄥ悗绔枃浠? 鍋忓ソ璁剧疆鐨?AI 妯″瀷 tab 鐢?get/set 鍔犺浇涓庝繚瀛樸€?
//   chat 璋冪敤璧?backend AgentManager, 鏃犻渶鍓嶇鍐?init銆?
export const aiConfig = {
  get: () => invoke<{ model: AgentConfig }>('get_ai_config'),
  set: (config: AgentConfig) => invoke<void>('set_ai_config', { config: { model: config } }),
  /**
   * One-shot connectivity probe for the form the user is editing.
   *
   * Distinct from `set`: doesn't write to disk, doesn't broadcast
   * `user-config-changed`, and uses a fresh provider instance per call
   * (so a failing probe can't poison the production chat cache).
   *
   * The backend (`commands/settings.rs::test_ai_connection`) returns a
   * `TestConnectionResult` even on failure — the IPC boundary stays
   * 200-shaped and the failure is expressed via `result.error.kind`.
   */
  testConnection: (config: AgentConfig) =>
    invoke<TestConnectionResult>('test_ai_connection', { config }),
};

// Agent access roots (backend ~/.flowix/agent-access.json).
// Source of truth is `agent_access::AgentAccessStore`; it mirrors notebooks and user-added folders.
// 鏁翠唤 set 鏇夸唬閫愭潯 patch, 閬垮厤鍓嶇瀵瑰崟鏉?entry 绠?diff; 鍐欐椂璧颁箰瑙傛洿鏂?
// (鏈湴鍏堟敼, 澶辫触 `loadInitial` 鍥炴粴)銆?
export const agentAccess = {
  get: () => invoke<AgentAccessConfig>('get_agent_access'),
  set: (config: AgentAccessConfig) => invoke<void>('set_agent_access', { config }),
  addFolderFromPicker: () =>
    invoke<AgentAccessEntry | null>('add_agent_access_folder_from_picker'),
};

export interface SystemTagLayoutItem {
  id: string;
  parentId: string | null;
}

export interface NotebookTagSystemMetadata {
  hidden: string[];
  order: string[];
  layout: SystemTagLayoutItem[];
}

// System metadata (backend ~/.flowix/boot/system.json).
export const system = {
  getTagMetadata: (notebookId: string) =>
    invoke<NotebookTagSystemMetadata>('get_tag_system_metadata', { notebookId }),
  setTagLayout: (notebookId: string, layout: SystemTagLayoutItem[]) =>
    invoke<void>('set_tag_system_layout', { notebookId, layout }),
};

// Memos
export type FilterType = 'all' | 'todos' | 'agents' | 'favorited' | 'tagged' | 'thisWeek' | 'thisMonth';
export type SortType = 'createdAt' | 'updatedAt';

export type MatchField = 'title' | 'tag' | 'body';

export interface MemoSearchHit {
  id: string;
  filename: string;
  snippet: string;
  matchedIn: MatchField;
  score: number;
  updatedAt: number;
}

export interface MemoTemplate {
  id: string;
  name: string;
}

export interface MentionNoteSearchItem {
  id: string;
  filename: string;
  title: string;
  updatedAt: number;
  notebookId: string;
  notebookName: string;
  notebookPath: string;
  originalPath: string | null;
}

type MemoVersionSource = 'auto' | 'manual' | 'restore_backup';

export interface MemoVersionMeta {
  id: string;
  memoId: string;
  createdAt: number;
  source: MemoVersionSource;
  filename: string;
  title: string;
  size: number;
  contentHash: string;
}

export interface OpenMemoSession {
  memo: MemoItem;
  notebookId: string;
  notebookPath: string;
  path: string;
  content: string;
}

export const memos = {
  getMemos: (params?: {
    notebookId?: string;
    filter?: FilterType;
    sort?: SortType;
    tagId?: string;
  }) => invoke<{ memos: any[] }>('get_memos', {
    notebookId: params?.notebookId,
    filter: params?.filter || 'all',
    sort: params?.sort || 'createdAt',
    tagId: params?.tagId,
  }),
  searchMentionNotes: (query?: string, limit?: number) =>
    invoke<MentionNoteSearchItem[]>('search_mention_notes', {
      query,
      limit,
    }),
  listAgentRoleMemos: () =>
    invoke<AgentRoleMemoItem[]>('list_agent_role_memos'),
  getUsedTagIds: (notebookId?: string) =>
    invoke<{
      usedTagIds: string[];
      tagCounts: { tagId: string; count: number }[];
      totalMemoCount: number;
      agentMemoCount: number;
      todoMemoCount: number;
    }>('get_used_memo_tag_ids', { notebookId }),
  getTodoCount: (notebookId?: string) =>
    invoke<number>('get_memo_todo_count', { notebookId }),
  readMemo: (id: string) => invoke<any | null>('read_memo', { id }),
  openMemoSession: (id: string) =>
    invoke<OpenMemoSession | null>('open_memo_session', { id }),
  readDocument: (filePath: string) => invoke<string | null>('read_document', { filePath }),
  // 鍐欑洏 IPC銆傝繑鍥炲€间负 null = 鍐欑洏澶辫触 (璺緞闈炴硶 / CAS refuse / fs error),
  // 鍚﹀垯杩斿洖 { path, content } 鈹€鈹€ `path` 鏄鐩樹笂鏈€缁堢墿鐞嗚矾寰?  // (rename 鍚庡彲鑳借窡 caller 浼犵殑 filePath 涓嶅悓, 鍓嶇闇€瑕佹嵁姝ゅ垏 buf),
  // `content` 鏄鐩樻渶缁堝唴瀹?(鍚?frontmatter), 鐢ㄤ簬 `lastSavedContent` 瀵归綈銆?  //
  // `channel`:
  // - 'internal' 鈹€鈹€ 鍐呴儴 memo 鏂囨。, 鐢?`key` (memoId) 鍙嶆煡 memo index
  //   鎷垮綋鍓?entry.filename, 娲剧敓棣栬鍙樺寲瑙﹀彂鐗╃悊 rename + memo index 鍚屾銆?
  // - 'external' 鈹€鈹€ 澶栭儴 .md 鏂囦欢, 璧?`filePath` 瀵诲潃 + CAS, 涓嶆敼鍚?
  //   涓嶅姩 memo index銆?
  writeDocument: (params: {
    key: string | null;
    channel: 'internal' | 'external';
    filePath: string;
    content: string;
    expectedContent?: string;
  }) => invoke<{ path: string; content: string } | null>('write_document', {
    key: params.key,
    channel: params.channel,
    filePath: params.filePath,
    content: params.content,
    expectedContent: params.expectedContent,
  }),
  getLaunchOpenFiles: () => invoke<string[]>('get_launch_open_files'),
  addDocument: (tag?: string, notebookId?: string) => invoke<any>('add_document', { tag, notebookId }),
  listTemplates: () => invoke<MemoTemplate[]>('list_memo_templates'),
  saveTemplate: (title: string, content: string) =>
    invoke<MemoTemplate>('save_memo_template', { title, content }),
  deleteTemplate: (templateId: string) =>
    invoke<boolean>('delete_memo_template', { templateId }),
  createFromTemplate: (templateId: string, notebookId?: string) =>
    invoke<any>('create_memo_from_template', { templateId, notebookId }),
  importExternalDocumentToMemo: (filePath: string, content: string, notebookId?: string) =>
    invoke<any | null>('import_external_document_to_memo', { filePath, content, notebookId }),
  deleteMemo: (id: string) => invoke<boolean>('delete_memo', { id }),
  clearMemos: (notebookId?: string) => invoke<boolean>('clear_memos', { notebookId }),
  favoriteMemo: (id: string) => invoke<boolean>('favorite_memo', { id }),
  unfavoriteMemo: (id: string) => invoke<boolean>('unfavorite_memo', { id }),
  setMemoColors: (id: string, colors: MemoColor[]) =>
    invoke<boolean>('set_memo_colors', { id, colors }),
  listVersions: (id: string) =>
    invoke<MemoVersionMeta[]>('list_memo_versions', { id }),
  restoreVersion: (id: string, versionId: string, expectedContent?: string) =>
    invoke<{ path: string; content: string } | null>('restore_memo_version', {
      id,
      versionId,
      expectedContent,
    }),
  search: (notebookId: string | null, query: string, limit?: number) =>
    invoke<{ hits: MemoSearchHit[]; indexReady: boolean }>('search_memos', {
      notebookId,
      query,
      limit,
    }),
  // 鍏ㄥ眬"閫氳繃閾炬帴鎵撳紑绗旇"鍏ュ彛 鈹€鈹€ 鎺ユ敹浠绘剰褰㈠紡鐨?`flowix://` URL / 鐗╃悊璺緞,
  // 鍚庣璧?parser + resolver, 杩斿洖 ResolvedOpenTarget銆?null 琛ㄧず瑙ｆ瀽澶辫触
  // (id 涓嶅瓨鍦?/ 璺緞涓嶅湪 notebook 鍐?/ 鐗╃悊璺緞鎸囧悜宸插垹绗旇)銆?閰嶅悎
  // `lib/openByTarget/listener.ts` 鐩戝惉 `flowix:open-target` 浜嬩欢 鈹€鈹€ 涓诲姩
  // 璋冪敤 (noteReference 鍙屽嚮 / Agent 宸ュ叿) 璧?await, 琚姩娲惧彂 (澶栭儴娣遍摼 /
  // single-instance 浜屾鍚姩) 璧颁簨浠躲€?涓ゆ潯璺緞姹囧悎鍒板悓涓€ `openNoteByTarget`銆?
  openMemoByTarget: (raw: string, options?: { emitEvent?: boolean }) => invoke<{
    memoId: string;
    notebookId: string;
    notebookName: string;
    notebookPath: string;
    absolutePath: string;
    memoTitle: string;
  } | null>('open_memo_by_target', { raw, emitEvent: options?.emitEvent ?? true }),
};

// Tags
export const tags = {
  getAll: (notebookId?: string) =>
    invoke<{ tags: { id: string; name: string }[] }>('get_all_tags', { notebookId }),
  create: (name: string) => invoke<{ id: string; name: string } | null>('create_memo_tag', { name }),
  rename: (id: string, name: string) => invoke<{ id: string; name: string } | null>('rename_memo_tag', { id, name }),
  delete: (id: string) => invoke<boolean>('delete_memo_tag', { id }),
  /**
   * 移动 subtag: 把 `oldPath` 整棵子树重命名 (含 prefix 替换), 批量
   * 改写所有受影响 memo 的 .md body + 同步 memo index。
   * `notebookId` 必须传, IPC 端无默认值 (跟 getAll 的 optional 不同)。
   * 返回值: `{ affectedMemos, renamedTags: [[old, new], ...] }`。
   */
  move: (notebookId: string, oldPath: string, newPath: string) =>
    invoke<{ affectedMemos: number; renamedTags: [string, string][] }>(
      'move_memo_tag',
      { notebookId, oldPath, newPath },
    ),
  /**
   * 路径式 tag 树前缀计数: 每个 prefix (e.g. `中国`, `中国/湖南`)
   * 对应挂了"以该 prefix 起始的 tag"的去重 memo 数。按 memo 数算,
   * 同一 memo 多个子 tag 在父 prefix 下只算 1。
   */
  getPrefixCounts: (notebookId: string) =>
    invoke<Record<string, number>>('get_tag_prefix_counts', { notebookId }),
};

// Notebooks
export const notebooks = {
  getAll: () => invoke<any[]>('get_notebooks'),
  create: (name: string, path: string, icon?: string | null) =>
    invoke<any>('create_notebook', { name, path, icon }),
  update: (id: string, name?: string, icon?: string | null) =>
    invoke<any | null>('update_notebook', { id, name, icon }),
  delete: (id: string) => invoke<boolean>('delete_notebook', { id }),
  clearAll: () => invoke<boolean>('clear_notebooks'),
  setCurrent: (notebookId: string | null) => invoke<void>('set_current_notebook', { notebookId }),
};

// Files
export const files = {
  getTree: (spacePath: string) => invoke<any[] | null>('get_file_tree', { spacePath }),
  getDirChildren: (dirPath: string) => invoke<any[]>('get_dir_children', { dirPath }),
  read: (filePath: string, spacePath?: string) => invoke<string | null>('read_file', { filePath, spacePath }),
  write: (filePath: string, content: string, skipValidation?: boolean, spacePath?: string) =>
    invoke<boolean>('write_file', { filePath, content, skipValidation, spacePath }),
  delete: (filePath: string, spacePath?: string) => invoke<boolean>('delete_file', { filePath, spacePath }),
  createFolder: (spacePath: string, name: string, parentId?: string) =>
    invoke<any | null>('create_folder', { spacePath, name, parentId }),
  createDocument: (spacePath: string, name: string, parentId?: string) =>
    invoke<any | null>('create_document', { spacePath, name, parentId }),
};

// Dialogs
export interface SaveFileFilter {
  name: string;
  extensions: string[];
}

export const dialogs = {
  selectDirectory: () => invoke<string | null>('select_directory'),
  selectFiles: () => invoke<any[] | null>('select_files'),
  saveFile: (suggestedName?: string, filters?: SaveFileFilter[]) =>
    invoke<string | null>('save_file_dialog', {
      suggestedName,
      filters: filters?.map((f) => [f.name, ...f.extensions]),
    }),
  writeExportFile: (filePath: string, content: string) =>
    invoke<boolean>('write_export_file', { filePath, content }),
  copyAttachmentFile: (sourcePath: string, targetPath: string) =>
    invoke<boolean>('copy_attachment_file', { sourcePath, targetPath }),
};

// Windows
export type TabTarget =
  | {
      kind: 'memo';
      memoId: string;
      notebookId: string;
      notebookPath: string;
      filePath: string;
    }
  | {
      kind: 'web';
      url: string;
    };

export interface WindowTab {
  id: string;
  title: string;
  icon: string | null;
  target: TabTarget;
}

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowRegion extends WindowPosition {
  width: number;
  height: number;
}

export interface TabDragResult {
  merged: boolean;
}

export const windows = {
  showMain: () => invoke<void>('show_main_window'),
  openPreferences: (tab?: string) => invoke<void>('open_preferences_window', { tab }),
  openNoteWindow: (memoId: string) => invoke<void>('open_note_window', { memoId }),
  openNoteTab: (memoId: string) => invoke<void>('open_note_tab', { memoId }),
  tabWindowReady: () => invoke<WindowTab[]>('tab_window_ready'),
  ackTabWindowTransfer: (transferId: string, tabId: string) =>
    invoke<void>('tab_window_ack_transfer', { transferId, tabId }),
  setTabWindowRegion: (region: WindowRegion) =>
    invoke<void>('tab_window_set_tab_region', { region }),
  closeTabWindowTab: (tabId: string) => invoke<void>('tab_window_close_tab', { tabId }),
  reorderTabWindowTab: (tabId: string, beforeTabId: string | null) =>
    invoke<void>('tab_window_reorder_tab', { tabId, beforeTabId }),
  detachTabWindowTab: (
    tabId: string,
    position: WindowPosition,
    dragId: string,
  ) => invoke<TabDragResult>('tab_window_detach_tab', {
    tabId,
    position,
    dragId,
  }),
  beginTabItemDrag: (tabId: string, dragId: string) => invoke<void>('tab_window_begin_tab_item_drag', {
    tabId,
    dragId,
  }),
  cancelTabItemDrag: (tabId: string, dragId: string) =>
    invoke<void>('tab_window_cancel_tab_item_drag', { tabId, dragId }),
};

export interface ProductInfo {
  productName: string;
  version: string;
  configDir: string;
  dataDir: string;
  logDir: string;
  os: string;
  arch: string;
}

export interface ProductUpdateNotice {
  id: string;
  title: string;
  body: string;
  version?: string | null;
  ctaUrl?: string | null;
  publishedAt?: string | null;
}

export const product = {
  getInfo: () => invoke<ProductInfo>('get_product_info'),
  checkUpdateNotice: (language?: string, region?: string) =>
    invoke<ProductUpdateNotice | null>('check_product_update_notice', { language, region }),
  openLogDir: () => invoke<void>('open_log_dir'),
};

// Agent
//
// AI model config is sourced from ~/.flowix/agent-config.toml; see aiConfig.set/get above.
// 骞舵儼鎬ф瀯寤?provider 瀹炰緥 (瑙?backend/src/agent.rs AgentManager::ensure_instance)銆?//
// 瀛楁鍛藉悕: 鍚庣 AiModelConfig 鐢?`#[serde(rename_all = "camelCase")]`, 鎵€浠?// IPC 浼犺繃鍘诲繀椤绘槸 camelCase 鈹€ snake_case 浼氳 serde 闈欓粯涓㈠純, 瀛楁鍏ㄩ儴鍥為€€
// 鍒?#[serde(default)] = 绌轰覆, 琛ㄧ幇灏辨槸"淇濆瓨鍚庡埛鏂?apiKey/apiUrl 閮界┖浜?銆?
export interface AgentConfig {
  provider: string;
  model: string;
  apiUrl: string;
  /** 按 provider 隔离的秘钥桶。切换供应商时直接读这桶, 互不串。 */
  apiKeys: Record<string, string>;
}

// Result of a one-shot probe (`aiConfig.testConnection`).
// Mirrors `agent::provider::TestConnectionResult` on the Rust side
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
}

export interface ThreadInfo {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export type AgentConversationSource = {
  kind: 'thread-card';
  documentPath?: string | null;
  memoId?: string | null;
};

export interface AgentConversationRole {
  memoId?: string | null;
  name?: string | null;
}

export interface AgentConversationRun {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number | null;
  currentTool?: string | null;
  model?: string | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
  lastRunAt?: number | null;
  reason?: string | null;
  /** Nested token usage — mirrors Rust `UsageInfo` stored as JSON. */
  usage?: UsageInfo | null;
  /** Provider-specific status snapshot — mirrors Rust `StatusInfo`. */
  statusInfo?: StatusInfo | null;
}

export interface AgentConversationInstance {
  instanceId: string;
  agentType: AgentTypeKey;
  title: string;
  threadId: string | null;
  runtimeConfig?: string | null;
  source: AgentConversationSource;
  role?: AgentConversationRole | null;
  run?: AgentConversationRun | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRuntimeAvailability {
  available: boolean;
  reason?: string | null;
}

export interface AgentRuntimeStatus {
  flowix: AgentRuntimeAvailability;
  codex: AgentRuntimeAvailability;
  claude: AgentRuntimeAvailability;
  gemini: AgentRuntimeAvailability;
  hermes: AgentRuntimeAvailability;
  openclaw: AgentRuntimeAvailability;
}

export const agent = {
  runtimeStatus: () =>
    invoke<AgentRuntimeStatus>('agent_runtime_status'),
  openCodexCliInstallTerminal: () =>
    invoke<void>('open_codex_cli_install_terminal'),
  openCodexConfig: () =>
    invoke<void>('open_codex_config'),
  cacheImage: (content: string, mimeType: string) =>
    invoke<CachedAgentImage>('cache_agent_image', { content, mimeType }),
  deleteCachedImage: (path: string) =>
    invoke<boolean>('delete_cached_agent_image', { path }),
  readCachedImage: (path: string) =>
    invoke<string | null>('read_cached_agent_image', { path }),
  chatStream: (threadId: string, message: AgentUserMessage) =>
    invoke<ChatResponse>('chat_with_agent_stream', { threadId, message }),
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
  listThreads: () =>
    invoke<ThreadInfo[]>('thread_list'),
  listLocalAgentThreads: (agentType: AgentTypeKey) =>
    invoke<ThreadInfo[]>('local_agent_thread_list', { agentType }),
  createThread: (title: string) =>
    invoke<ThreadInfo>('thread_create', { title }),
  getThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('thread_get', { threadId }),
  /**
   * Layer 4: 鍒嗛〉鍔犺浇 thread 鍘嗗彶. 杩斿洖 { messages (ASC), oldestSequence, hasMore }.
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
  getConversationInstance: (instanceId: string) =>
    invoke<AgentConversationInstance | null>('agent_conversation_get', {
      instanceId,
    }),
  findConversationByThread: (threadId: string) =>
    invoke<AgentConversationInstance | null>(
      'agent_conversation_find_by_thread',
      { threadId },
    ),
  findConversationByRun: (runId: string) =>
    invoke<AgentConversationInstance | null>('agent_conversation_find_by_run', {
      runId,
    }),
  upsertConversationInstance: (instance: AgentConversationInstance) =>
    invoke<AgentConversationInstance>('agent_conversation_upsert', { instance }),
  upsertConversationRunState: (instanceId: string, run: AgentConversationRun) =>
    invoke<void>('agent_conversation_upsert_run_state', { instanceId, run }),
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
  ) =>
    invoke<{
      messages: ChatMessage[];
      oldestSequence: number | null;
      hasMore: boolean;
    }>('codex_thread_get_page', { threadId, beforeSequence, limit }),
  getCodexSessionId: (threadId: string) =>
    invoke<string | null>('codex_thread_session_id', { threadId }),
  getCodexDefaultModel: () =>
    invoke<string>('codex_default_model'),
  listSupportedModels: (agentType: AgentTypeKey) =>
    invoke<string[]>('agent_supported_models', { agentType }),
  listClaudeThreads: () =>
    invoke<ThreadInfo[]>('claude_thread_list'),
  getClaudeThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('claude_thread_get', { threadId }),
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
  ) =>
    invoke<{
      messages: ChatMessage[];
      oldestSequence: number | null;
      hasMore: boolean;
    }>('hermes_thread_get_page', { threadId, beforeSequence, limit }),
  getHermesSessionId: (threadId: string) =>
    invoke<string | null>('hermes_thread_session_id', { threadId }),
  deleteThread: (threadId: string) =>
    invoke<void>('thread_delete', { threadId }),
  // 閲嶅懡鍚?thread 鈹€鈹€ 棣栨潯鐢ㄦ埛娑堟伅钀藉湴鍚庤皟涓€娆? 瑕嗙洊 ensureThread 璧?early return
  // 鏃剁殑婕忕綉涔嬮奔(鐐硅繃"鏂板缓瀵硅瘽"鍐嶅彂娑堟伅鐨勫満鏅?銆傝繑鍥?None 琛ㄧず thread 涓嶅瓨鍦ㄣ€?
  updateThreadTitle: (threadId: string, title: string, agentType?: AgentTypeKey) =>
    invoke<ThreadInfo | null>('thread_update_title', { threadId, title, agentType }),
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

// ============================================
// 璺ㄧ獥鍙ｅ悓姝?// ============================================
// 鍚庣 set_preference / set_ai_config 鎴愬姛鍚?emit 'user-config-changed',
// payload 鏄?"preference" | "ai_config" 鎸囨槑鍝釜鏂囦欢鍙樹簡銆?// 鍏跺畠绐楀彛鏀跺埌鍚庝粠纾佺洏閲嶆柊 load, 瑙ｅ喅: 涓や釜 Tauri 绐楀彛鍚勮窇鐙珛 React 鏍?// + 鐙珛 zustand store, 涓€杈规敼鍔ㄥ彟涓€杈圭湅涓嶅埌鐨勯棶棰樸€?
type UserConfigChangeKind = 'preference' | 'ai_config';
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
