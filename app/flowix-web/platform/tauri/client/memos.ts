import { invokeDocumentMutation } from './document-mutation';
import { invoke } from '@tauri-apps/api/core';
import type { NotebookImportStatus } from './agent';

/** Tag summary and memo events. Path-based note operations live in `notes`. */
export const memos = {
  getUsedTagIds: (notebookId?: string) =>
    invoke<{
      usedTagIds: string[];
      tagCounts: { tagId: string; count: number }[];
      totalMemoCount: number;
      agentMemoCount: number;
      todoMemoCount: number;
    }>('get_used_memo_tag_ids', { notebookId }),
};

export type ExternalDocumentWriteOutcome =
  | { status: 'saved'; path: string; content: string; merged?: boolean }
  | { status: 'conflict'; diskContent: string }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export const externalDocuments = {
  detectTextContent: (filePath: string, scopePath?: string | null) =>
    invoke<boolean>('detect_external_document_text', { filePath, scopePath: scopePath ?? null }),
  openWithDefaultApp: (filePath: string, scopePath?: string | null) =>
    invoke<void>('open_file_with_default_app', { filePath, scopePath: scopePath ?? null }),
  read: (filePath: string, scopePath?: string | null, maxBytes?: number) =>
    invoke<string>('read_external_document', { filePath, scopePath: scopePath ?? null, maxBytes: maxBytes ?? null }),
  write: (params: {
    filePath: string;
    content: string;
    expectedContent?: string;
    scopePath?: string | null;
  }) => invokeDocumentMutation<ExternalDocumentWriteOutcome>('write_external_document', {
    filePath: params.filePath,
    content: params.content,
    expectedContent: params.expectedContent,
    scopePath: params.scopePath ?? null,
  }),
};

// Tags
export const tags = {
  getAll: (notebookId?: string) =>
    invoke<{ tags: { id: string; name: string }[] }>('get_all_tags', { notebookId }),
  /**
   * 移动 subtag: 把 `oldPath` 整棵子树重命名 (含 prefix 替换), 批量
   * 改写所有受影响 memo 的 YAML `tags` + 同步 memo index。
   * `notebookId` 必须传, IPC 端无默认值 (跟 getAll 的 optional 不同)。
   * 返回值: `{ affectedMemos, renamedTags: [[old, new], ...] }`。
   */
  move: (notebookId: string, oldPath: string, newPath: string) =>
    invoke<{ affectedMemos: number; renamedTags: [string, string][] }>(
      'move_memo_tag',
      { notebookId, oldPath, newPath },
    ),
  /**
   * Delete a tag subtree: removes `tagPath` itself + every nested
   * `tagPath/<...>` tag from memo index + document YAML `tags`. Symmetric to
   * `move` -- returns `{ affectedMemos, deletedTags }` so the caller
   * can refresh dropdown / tag panel caches without re-querying.
   */
  delete: (notebookId: string, tagPath: string) =>
    invoke<{ affectedMemos: number; deletedTags: string[] }>(
      'delete_memo_tag',
      { notebookId, tagPath },
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
export interface NotebookSortEntry {
  id: string;
  sort: number;
}

export interface NotebookBackgroundStatus {
  notebookId: string;
  state: 'queued' | 'running' | 'ready' | 'failed';
  revision: number;
  memoCount?: number;
  missing?: boolean;
  message: string | null;
}

export interface NotebookMediaMaintenanceStatus {
  notebookId: string;
  state: 'queued' | 'running' | 'ready' | 'failed';
  revision: number;
  message: string | null;
}

export interface NotebookRecord {
  id: string;
  name: string;
  icon?: string | null;
  /** Total number of notes in the notebook, when provided by the caller. */
  memoCount?: number;
  path: string;
  createdAt: number;
  updatedAt: number;
  isDefault: boolean;
  sort?: number;
  pinned?: boolean;
  missing?: boolean;
}

export interface ObsidianVaultRecord {
  name: string;
  path: string;
}

export const notebooks = {
  getAll: () => invoke<NotebookRecord[]>('get_notebooks'),
  listObsidianVaults: () => invoke<ObsidianVaultRecord[]>('list_obsidian_vaults'),
  setPinned: (notebookId: string, pinned: boolean) =>
    invoke<boolean>('set_notebook_pinned', { notebookId, pinned }),
  getBackgroundStatus: () => invoke<NotebookBackgroundStatus[]>('get_notebook_background_status'),
  refreshIndex: (notebookId: string) => invoke<void>('request_notebook_refresh', { notebookId }),
  getMediaMaintenanceStatus: () => invoke<NotebookMediaMaintenanceStatus[]>('get_notebook_media_maintenance_status'),
  retryMediaMaintenance: (notebookId: string) => invoke<void>('request_notebook_media_maintenance', { notebookId }),
  getDefaultPath: (name: string) =>
    invoke<string>('get_default_notebook_path', { name }),
  ensureDefaultPath: (name: string) =>
    invoke<string>('ensure_default_notebook_path', { name }),
  create: (name: string, path?: string, icon?: string | null, activate = true) =>
    invoke<NotebookRecord>('create_notebook', { name, path, icon, activate }),
  createFromCloud: (id: string, name: string, path: string, icon?: string | null, activate = true) =>
    invoke<NotebookRecord>('create_notebook_from_cloud', { id, name, path, icon, activate }),
  startImport: (notebookId: string) =>
    invoke<void>('start_notebook_import', { notebookId }),
  getImportStatus: (notebookId: string) =>
    invoke<NotebookImportStatus | null>('get_notebook_import_status', { notebookId }),
  update: (id: string, name?: string, icon?: string | null) =>
    invoke<NotebookRecord | null>('update_notebook', { id, name, icon }),
  setPrimaryDirectory: (id: string, path: string) =>
    invoke<NotebookRecord>('set_notebook_primary_directory', { id, path }),
  delete: (id: string, deleteLocalFiles = false) =>
    invoke<boolean>('delete_notebook', { id, deleteLocalFiles }),
  clearAll: () => invoke<boolean>('clear_notebooks'),
  setCurrent: (notebookId: string | null) => invoke<void>('set_current_notebook', { notebookId }),
  /**
   * Reorder notebooks. `order` is the desired (id, sort) pairs; the backend
   * keeps any ids not present in the list untouched. Returns the fresh
   * notebook list in the new order so callers can immediately replace their
   * local cache without re-querying.
   */
  reorder: (order: NotebookSortEntry[]) =>
    invoke<NotebookRecord[]>('reorder_notebooks', { order }),
};
