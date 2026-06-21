'use client';

import { invoke } from '@tauri-apps/api/core';
import { subscribe } from '@platform/tauri/event-bus';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { UserSettings } from '@/lib/constants';
import type { AgentChunk, AgentCodexModel, AgentPermissionMode, AgentRuntime, ChatMessage, RunInfo } from '@/types/agent';
import type { AgentAccessConfig } from '@/lib/types/agent-access';
import type { MemoColor } from '@features/memo';

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

// Preferences (后端 ~/.flowix/preference.json, 见 backend/src/user_config.rs)
export const preferences = {
  get: () => invoke<UserSettings>('get_preference'),
  set: (preference: UserSettings) => invoke<void>('set_preference', { preference }),
};

// AI Config (后端 ~/.flowix/flowix-ai-config.toml, 字段与 AgentConfig 镜像)
// ─ 真源在后端文件; 偏好设置的 AI 模型 tab 用 get/set 加载与保存。
//   chat 调用走 backend AgentManager, 无需前端再 init。
export const aiConfig = {
  get: () => invoke<{ model: AgentConfig }>('get_ai_config'),
  set: (config: AgentConfig) => invoke<void>('set_ai_config', { config: { model: config } }),
};

// Agent 可访问目录 (后端 ~/.flowix/agent_access.json)。
// ── 真源是后端 `agent_access::AgentAccessStore` ── 镜像所有
//   notebook + 用户自添加 folder, 每条 entry 有 enabled 勾选。
//   驱动 `ToolScope::allowed_roots` 与 `list_notebooks` 工具的过滤。
//
// 整份 set 替代逐条 patch, 避免前端对单条 entry 算 diff; 写时走乐观更新
// (本地先改, 失败 `loadInitial` 回滚)。
export const agentAccess = {
  get: () => invoke<AgentAccessConfig>('get_agent_access'),
  set: (config: AgentAccessConfig) => invoke<void>('set_agent_access', { config }),
};

// 全局元数据 KV (~/.flowix/global_meta_data.json, 用于 notebook 的 tag 顺序 / 隐藏状态等非偏好数据)
// 后端 set_* 返回 Result<(), String>, 前端 await 即抛错。
export const settings = {
  get: (key: string) => invoke<{ value: string | null }>('get_setting', { key }),
  getAll: () => invoke<{ settings: Record<string, string> }>('get_all_settings'),
  set: (key: string, value: string) => invoke<void>('set_setting', { key, value }),
  setMultiple: (settings: Record<string, string>) => invoke<void>('set_multiple_settings', { settings }),
  delete: (key: string) => invoke<boolean>('delete_setting', { key }),
};

// Memos
export type FilterType = 'all' | 'todos' | 'favorited' | 'tagged' | 'thisWeek' | 'thisMonth';
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

export type MemoVersionSource = 'auto' | 'manual' | 'restore_backup';

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
  readMemo: (id: string) => invoke<any | null>('read_memo', { id }),
  readDocument: (filePath: string) => invoke<string | null>('read_document', { filePath }),
  // 写盘 IPC。返回值为 null = 写盘失败 (路径非法 / CAS refuse / fs error),
  // 否则返回 { path, content } ── `path` 是磁盘上最终物理路径
  // (rename 后可能跟 caller 传的 filePath 不同, 前端需要据此切 buf),
  // `content` 是磁盘最终内容 (含 frontmatter), 用于 `lastSavedContent` 对齐。
  //
  // `channel`:
  // - 'internal' ── 内部 memo 文档, 用 `key` (memoId) 反查 index.json
  //   拿当前 entry.filename, 派生首行变化触发物理 rename + index.json 同步。
  // - 'external' ── 外部 .md 文件, 走 `filePath` 寻址 + CAS, 不改名
  //   不动 index.json。
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
  importExternalDocumentToMemo: (sourcePath: string, content: string, notebookId?: string) =>
    invoke<any | null>('import_external_document_to_memo', { sourcePath, content, notebookId }),
  deleteMemo: (id: string) => invoke<boolean>('delete_memo', { id }),
  clearMemos: (notebookId?: string) => invoke<boolean>('clear_memos', { notebookId }),
  favoriteMemo: (id: string) => invoke<boolean>('favorite_memo', { id }),
  unfavoriteMemo: (id: string) => invoke<boolean>('unfavorite_memo', { id }),
  setMemoColors: (id: string, colors: MemoColor[]) =>
    invoke<boolean>('set_memo_colors', { id, colors }),
  listVersions: (id: string) =>
    invoke<MemoVersionMeta[]>('list_memo_versions', { id }),
  readVersion: (id: string, versionId: string) =>
    invoke<string | null>('read_memo_version', { id, versionId }),
  createVersion: (id: string, source?: MemoVersionSource) =>
    invoke<MemoVersionMeta | null>('create_memo_version', { id, source }),
  restoreVersion: (id: string, versionId: string, expectedContent?: string) =>
    invoke<{ path: string; content: string } | null>('restore_memo_version', {
      id,
      versionId,
      expectedContent,
    }),
  deleteVersion: (id: string, versionId: string) =>
    invoke<boolean>('delete_memo_version', { id, versionId }),
  search: (notebookId: string | null, query: string, limit?: number) =>
    invoke<{ hits: MemoSearchHit[]; indexReady: boolean }>('search_memos', {
      notebookId,
      query,
      limit,
    }),
  // 全局"通过链接打开笔记"入口 ── 接收任意形式的 `flowix://` URL / 物理路径,
  // 后端走 parser + resolver, 返回 ResolvedOpenTarget。 null 表示解析失败
  // (id 不存在 / 路径不在 notebook 内 / 物理路径指向已删笔记)。 配合
  // `lib/openByTarget/listener.ts` 监听 `flowix:open-target` 事件 ── 主动
  // 调用 (noteReference 双击 / Agent 工具) 走 await, 被动派发 (外部深链 /
  // single-instance 二次启动) 走事件。 两条路径汇合到同一 `openNoteByTarget`。
  openMemoByTarget: (raw: string, options?: { emitEvent?: boolean }) => invoke<{
    memoId: string;
    notebookId: string;
    notebookName: string;
    notebookPath: string;
    absolutePath: string;
    memoTitle: string;
  } | null>('open_memo_by_target', { raw, emitEvent: options?.emitEvent ?? true }),
  // `<notebook>/.metadata/` 下的 memo 元数据数组文件名。cold-start 时
  // memo-list 直接 `files.read()` 这个文件做 parse, 不能用 IPC 读 (会
  // 走完整 IPC 链 ── read_document 还得带 `key` 走 rename 流程)。
  // 前端不硬编码, 通过此 IPC 拉后端的 `MEMO_INDEX_FILENAME` 常量。
  getIndexFilename: () => invoke<string>('get_index_filename'),
};

// Tags
export const tags = {
  getAll: () => invoke<{ tags: { id: string; name: string }[] }>('get_all_tags'),
  create: (name: string) => invoke<{ id: string; name: string } | null>('create_memo_tag', { name }),
  rename: (id: string, name: string) => invoke<{ id: string; name: string } | null>('rename_memo_tag', { id, name }),
  delete: (id: string) => invoke<boolean>('delete_memo_tag', { id }),
};

// Notebooks
export const notebooks = {
  getAll: () => invoke<any[]>('get_notebooks'),
  create: (name: string, path: string, icon?: string) =>
    invoke<any | null>('create_notebook', { name, path, icon }),
  update: (id: string, name?: string, icon?: string) =>
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
  saveAttachment: (sourcePath: string, notebookId?: string) =>
    invoke<string | null>('save_attachment', { sourcePath, notebookId }),
  copyAttachmentFile: (sourcePath: string, targetPath: string) =>
    invoke<boolean>('copy_attachment_file', { sourcePath, targetPath }),
};

// Windows
export const windows = {
  openPreferences: (tab?: string) => invoke<void>('open_preferences_window', { tab }),
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

export const product = {
  getInfo: () => invoke<ProductInfo>('get_product_info'),
  getDiagnostics: () => invoke<string>('get_diagnostics'),
  openLogDir: () => invoke<void>('open_log_dir'),
};

// Agent
//
// AI 模型配置以 ~/.flowix/flowix-ai-config.toml 为真源 ─ 见 aiConfig.set/get 上方。
// 前端不再 init agent / 提交模型信息: chat / thread 调用时, 后端按需读取配置
// 并惰性构建 provider 实例 (见 backend/src/agent.rs AgentManager::ensure_instance)。
//
// 字段命名: 后端 AiModelConfig 用 `#[serde(rename_all = "camelCase")]`, 所以
// IPC 传过去必须是 camelCase ─ snake_case 会被 serde 静默丢弃, 字段全部回退
// 到 #[serde(default)] = 空串, 表现就是"保存后刷新 apiKey/apiUrl 都空了"。
export interface AgentConfig {
  provider: string;
  model: string;
  apiUrl: string;
  apiKey: string;
}

interface ChatResponse {
  response: string;
}

interface AgentUserMessage {
  content: string;
  llmContent?: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
  runtime?: AgentRuntime;
  permissionMode?: AgentPermissionMode;
  codexModel?: AgentCodexModel;
}

export interface ThreadInfo {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export const agent = {
  chatStream: (threadId: string, message: AgentUserMessage) =>
    invoke<ChatResponse>('chat_with_agent_stream', { threadId, message }),
  // 终止运行中的 chat_stream。后端 AgentManager.stop_chat 翻转 cancel flag,
  // 正在跑的 ReAct 循环在下一个 checkpoint 检测到后调 flush_cancel 退出。
  // 返回 true = 成功触发了取消, false = 当前没有 chat 在跑 (no-op)。
  stopChatStream: (threadId: string) =>
    invoke<boolean>('stop_agent_stream', { threadId }),
  // 查询当前 in-flight chat 集合 ── 启动时前端调一次, seed
  // `threadStates[].isLoading`。 空 map 表示当前没有 in-flight chat。
  // 后端镜像 `cancel_flags` 的生命周期, 与 `StreamStart/End` chunk 同步。
  runningThreads: () =>
    invoke<Record<string, RunInfo>>('agent_running_threads'),
  listThreads: () =>
    invoke<ThreadInfo[]>('thread_list'),
  createThread: (title: string) =>
    invoke<ThreadInfo>('thread_create', { title }),
  getThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('thread_get', { threadId }),
  /**
   * Layer 4: 分页加载 thread 历史. 返回 { messages (ASC), oldestSequence, hasMore }.
   *  - beforeSequence = null/undefined → 取最近 limit 条
   *  - beforeSequence = N → 取 sequence < N 的最近 limit 条 (向上翻页)
   * 服务端 clamp limit 到 [1, 1000].
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
  listCodexThreads: () =>
    invoke<ThreadInfo[]>('codex_thread_list'),
  getCodexThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('codex_thread_get', { threadId }),
  getCodexSessionId: (threadId: string) =>
    invoke<string | null>('codex_thread_session_id', { threadId }),
  getCodexDefaultModel: () =>
    invoke<string>('codex_default_model'),
  deleteThread: (threadId: string) =>
    invoke<void>('thread_delete', { threadId }),
  // 重命名 thread ── 首条用户消息落地后调一次, 覆盖 ensureThread 走 early return
  // 时的漏网之鱼(点过"新建对话"再发消息的场景)。返回 None 表示 thread 不存在。
  updateThreadTitle: (threadId: string, title: string) =>
    invoke<ThreadInfo | null>('thread_update_title', { threadId, title }),
};

// Stream event handling
//
// **模块级单例 listener** ── 这里只允许注册一次, 整个 app 共享同一份
// 监听。`useAgentEvents` 在 App.tsx 顶层挂一次, 把 chunk 派发到 chat-store
// 的 `dispatchAgentChunk` action; 多个组件 (主窗口 / 偏好窗口) 不再各自
// 挂 listener ── 避免 chunk 被多个 handler 重复处理。
//
// 历史: 旧版 `listenToAgentStream` 是 `sendMessageStream` 内每次发消息挂
// 一次, 收到 `finally` 调 `stopListeningToAgentStream` 卸掉。 新模型下
// listener 长在, 永远不卸, 派发器自己按 `thread_id` 路由到正确的 store
// 状态。 旧调用点 (chat-store.ts: sendMessageStream 里的
// `listenToAgentStream((chunk) => ...)`) 已经整体替换为单点 dispatch。
type StreamCallback = (chunk: AgentChunk) => void;

// CLI sidecar JSON-RPC ── 通过后端 `cli_invoke` 命令走 `flowix-cli serve` 子进程。
// 后端 spawn sidecar 进程, 维护 stdin/stdout 双向流, 把 method + params 包成
// line-delimited JSON 发过去, 等响应回前端。 协议层见 `app/flowix-cli/src/serve.rs`。
//
// 当前直接消费者: command palette (未来), agent filesystem 工具 (未来)。
// v1 只是先暴露入口, 实际调用方会在后续工单里接。
export const cli = {
  invoke: <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> =>
    invoke<T>('cli_invoke', { method, params: params ?? {} }),
};

// 内部仅保留历史 API 名字; 实现全部走 event-bus。
// 多个调用点 (chat-store 与 useAgentEvents) 共享同一份 Tauri listener,
// 不再需要手工跟踪 streamUnlisten。 原 streamUnlisten 仅用于完全
// 卸载 (stopListeningToAgentStream), 现在也走 event-bus.unsubscribe。
export function listenToAgentStream(callback: StreamCallback): UnlistenFn {
  return subscribe<AgentChunk>('agent-chunk', callback);
}

// ============================================
// 跨窗口同步
// ============================================
// 后端 set_preference / set_ai_config 成功后 emit 'user-config-changed',
// payload 是 "preference" | "ai_config" 指明哪个文件变了。
// 其它窗口收到后从磁盘重新 load, 解决: 两个 Tauri 窗口各跑独立 React 树
// + 独立 zustand store, 一边改动另一边看不到的问题。

type UserConfigChangeKind = 'preference' | 'ai_config';
type UserConfigChangeHandler = (kind: UserConfigChangeKind) => void;

export function listenToUserConfigChanges(
  handler: UserConfigChangeHandler,
): UnlistenFn {
  return subscribe<UserConfigChangeKind>('user-config-changed', handler);
}

// 历史兼容: useEffect cleanup 仍有人手调这个空函数(例如
// `preferences/sections/agent.tsx`)。 内部走 event-bus.unsubscribe 不需要
// 全量 reset, GC 自然清理就行。 不删避免破坏调用方。
export function stopListeningToUserConfigChanges(): void {
  // 走 event-bus 的 UnlistenFn, 业务上应该让
  // subscribe 返回的 unlisten 走 useEffect cleanup, 不该手工调 stopXxx。
}

// Agent 可访问目录变更事件 ── 后端 set_agent_access / notebook CRUD
// 钩子任一成功都 emit, payload 是 `()` (无 payload), 监听者直接
// `loadInitial()` 拉整份 config。 与 `user-config-changed` 同形。
type AgentAccessChangeHandler = () => void;

export function listenToAgentAccessChanges(
  handler: AgentAccessChangeHandler,
): UnlistenFn {
  return subscribe<unknown>('agent-access-changed', () => handler());
}
