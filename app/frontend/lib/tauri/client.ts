'use client';

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ChatMessage } from '../../types/agent';

// ============================================
// Types
// ============================================

export type { ChatMessage } from '../../types/agent';

// Lightweight message type for LLM communication (without id/timestamp)
export interface LlmMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface RpcRequest {
  <T = unknown>(method: string, params?: unknown): Promise<T>;
}

// ============================================
// Tauri RPC Client
// ============================================

let rpcInstance: RpcRequest | null = null;

export function initTauriClient(): void {
  rpcInstance = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
    return await invoke<T>(method, params as Record<string, unknown> || {});
  };
  (window as any).__tauriRpc = rpcInstance;
}

export function getRpc(): RpcRequest {
  if (!rpcInstance) {
    throw new Error("Tauri RPC not initialized. Call initTauriClient() first.");
  }
  return rpcInstance;
}

export function isInitialized(): boolean {
  return rpcInstance !== null;
}

// ============================================
// RPC Method Wrappers (for type safety)
// ============================================

// Settings
export const settings = {
  get: (key: string) => invoke<{ value: string | null }>('get_setting', { key }),
  getAll: () => invoke<{ settings: Record<string, string> }>('get_all_settings'),
  set: (key: string, value: string) => invoke<boolean>('set_setting', { key, value }),
  setMultiple: (settings: Record<string, string>) => invoke<boolean>('set_multiple_settings', { settings }),
  delete: (key: string) => invoke<boolean>('delete_setting', { key }),
};

// Memos
export type FilterType = 'all' | 'todos' | 'favorited' | 'tagged' | 'thisWeek' | 'thisMonth';
export type SortType = 'createdAt' | 'updatedAt';

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
  readMemo: (id: string) => invoke<any | null>('read_memo', { id }),
  readDocument: (filePath: string) => invoke<string | null>('read_document', { filePath }),
  writeDocument: (filePath: string, content: string, expectedContent?: string) =>
    invoke<boolean>('write_document', { filePath, content, expectedContent }),
  getLaunchOpenFiles: () => invoke<string[]>('get_launch_open_files'),
  addDocument: (tag?: string, notebookId?: string) => invoke<any>('add_document', { tag, notebookId }),
  importExternalDocumentToMemo: (sourcePath: string, content: string, notebookId?: string) =>
    invoke<any | null>('import_external_document_to_memo', { sourcePath, content, notebookId }),
  updateMemoDb: (id: string, filename?: string, content?: string, preview?: string) =>
    invoke<boolean>('update_memo_db', { id, filename, content, preview }),
  deleteMemo: (id: string) => invoke<boolean>('delete_memo', { id }),
  clearMemos: (notebookId?: string) => invoke<boolean>('clear_memos', { notebookId }),
  favoriteMemo: (id: string) => invoke<boolean>('favorite_memo', { id }),
  unfavoriteMemo: (id: string) => invoke<boolean>('unfavorite_memo', { id }),
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
};

// Windows
export const windows = {
  openPreferences: (tab?: string) => invoke<void>('open_preferences_window', { tab }),
};

// Agent
export interface AgentConfig {
  name: string;
  api_url: string;
  api_key: string;
  model: string;
  system_prompt: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  model: string;
}

export interface ChatResponse {
  response: string;
}

export interface AgentUserMessage {
  content: string;
  llmContent?: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
}

export interface ThreadInfo {
  threadId: string;
  agentId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export const agent = {
  init: (config: AgentConfig) =>
    invoke<AgentInfo>('init_agent', { config }),
  chat: (agentId: string, threadId: string, message: AgentUserMessage) =>
    invoke<ChatResponse>('chat_with_agent', { agentId, threadId, message }),
  chatStream: (agentId: string, threadId: string, message: AgentUserMessage) =>
    invoke<ChatResponse>('chat_with_agent_stream', { agentId, threadId, message }),
  listThreads: () =>
    invoke<ThreadInfo[]>('thread_list'),
  createThread: (agentId: string, title: string) =>
    invoke<ThreadInfo>('thread_create', { agentId, title }),
  getThread: (threadId: string) =>
    invoke<{ messages: ChatMessage[] }>('thread_get', { threadId }),
  deleteThread: (threadId: string) =>
    invoke<void>('thread_delete', { threadId }),
};

// Stream event handling
export type StreamCallback = (chunk: string) => void;

let streamUnlisten: UnlistenFn | null = null;

export async function listenToAgentStream(callback: StreamCallback): Promise<void> {
  if (streamUnlisten) {
    streamUnlisten();
  }
  streamUnlisten = await listen<string>('agent-chunk', (event) => {
    callback(event.payload);
  });
}

export function stopListeningToAgentStream(): void {
  if (streamUnlisten) {
    streamUnlisten();
    streamUnlisten = null;
  }
}
