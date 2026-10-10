import { invokeDocumentMutation } from './document-mutation';
import { invoke } from '@tauri-apps/api/core';
import type { MemoItem } from '@/types/memo-item';
import type { NotebookImportStatus } from './agent';
import { notes } from './notes';
import type {
  FilterType,
  NoteColorFilter,
  NotePathStatus,
  SortType,
} from './notes';

export { notes };
export type {
  CreatedNoteDocument,
  FilterType,
  MarkdownLocation,
  MatchField,
  NoteColorFilter,
  NoteDeleteOutcome,
  NoteEntry,
  NoteListPage,
  NotePathStatus,
  NoteSearchHit,
  NoteTemplate,
  NoteVersionSource,
  PathArchiveSummary,
  PathVersionMeta,
  PruneMissingNoteOutcome,
  SortType,
} from './notes';

export interface NotebookTemplateRecord {
  id: string;
  name: string;
  description: string;
  sourceDirectory: string;
  icon: string;
  category?: string;
  coverUrl?: string;
}

/** Legacy Memo-ID operations and compatibility IPC. */
export const memos = {
  /** @deprecated Use `notes.resolveLocation`. */
  resolveMarkdownLocation: (filePath: string) =>
    notes.resolveLocation(filePath),
  /** @deprecated Use `notes.list`. */
  listNotesByPath: notes.list,
  /** @deprecated Use `notes.getPage`. */
  getPathNotes: (params: {
    notebookId: string;
    filter?: FilterType;
    sort?: SortType;
    tagId?: string;
    color?: NoteColorFilter;
    cursor?: string;
    limit?: number;
  }) => notes.getPage(params),
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
  /** @deprecated Use `notes.readDocument`. */
  readDocument: notes.readDocument,
  /** @deprecated Use `notes.pathStatus`. */
  notePathStatus: (filePath: string) => invoke<NotePathStatus>('note_path_status', { filePath }),
  /** @deprecated Use `notes.modifiedAt`. */
  getDocumentModifiedAt: notes.modifiedAt,
  // Save by notebook path with content CAS. Memo IDs are not part of note writes.
  /** @deprecated Use `notes.writeDocument`. */
  writeDocument: notes.writeDocument,
  getLaunchOpenFiles: () => invoke<string[]>('get_launch_open_files'),
  /** @deprecated Use `notes.create`. */
  addPathDocument: notes.create,
  /** @deprecated Use `notes.moveToDirectory`. */
  moveMemoToDirectory: notes.moveToDirectory,
  /** @deprecated Use `notes.renameTitle`. */
  renameMemoTitle: (params: { filePath: string; title: string; expectedFilename?: string; expectedContent: string }) =>
    invokeDocumentMutation<{ memo: MemoItem | null; path: string; filename: string }>('rename_memo_title', {
      filePath: params.filePath,
      title: params.title,
      expectedFilename: params.expectedFilename,
      expectedContent: params.expectedContent,
    }),
  /** @deprecated Use `notes.listTemplates`. */
  listTemplates: notes.listTemplates,
  /** @deprecated Use `notes.saveTemplate`. */
  saveTemplate: notes.saveTemplate,
  /** @deprecated Use `notes.deleteTemplate`. */
  deleteTemplate: notes.deleteTemplate,
  /** @deprecated Use `notes.createFromTemplate`. */
  createPathFromTemplate: notes.createFromTemplate,
  /** @deprecated Use `notes.importDocument`. */
  importExternalDocumentByPath: notes.importDocument,
  /** @deprecated Use `notes.listVersions`. */
  listPathVersions: notes.listVersions,
  /** @deprecated Use `notes.createVersion`. */
  createPathVersion: notes.createVersion,
  /** @deprecated Use `notes.restoreVersion`. */
  restorePathVersion: notes.restoreVersion,
  /** @deprecated Use `notes.search`. */
  searchPathNotes: notes.search,
  // 鍏ㄥ眬"閫氳繃閾炬帴鎵撳紑绗旇"鍏ュ彛 鈹€鈹€ 鎺ユ敹浠绘剰褰㈠紡鐨?`flowix://` URL / 鐗╃悊璺緞,
  // 鍚庣璧?parser + resolver, 杩斿洖 ResolvedOpenTarget銆?null 琛ㄧず瑙ｆ瀽澶辫触
  // (id 涓嶅瓨鍦?/ 璺緞涓嶅湪 notebook 鍐?/ 鐗╃悊璺緞鎸囧悜宸插垹绗旇)銆?閰嶅悎
  // `lib/openByTarget/listener.ts` 鐩戝惉 `flowix:open-target` 浜嬩欢 鈹€鈹€ 涓诲姩
  // 璋冪敤 (noteReference 鍙屽嚮 / Agent 宸ュ叿) 璧?await, 琚姩娲惧彂 (澶栭儴娣遍摼 /
  // single-instance 浜屾鍚姩) 璧颁簨浠躲€?涓ゆ潯璺緞姹囧悎鍒板悓涓€ `openNoteByTarget`銆?
};

export type ExternalDocumentWriteOutcome =
  | { status: 'saved'; path: string; content: string; merged?: boolean }
  | { status: 'conflict'; diskContent: string }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export const externalDocuments = {
  mimeType: (filePath: string) =>
    invoke<string>('get_external_document_mime_type', { filePath }),
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
  create: (notebookId: string, path: string) =>
    invoke<{ path: string }>('create_notebook_tag', { notebookId, path }),
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
  missing?: boolean;
}

export type NotebookSetupJobStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed';

export interface NotebookSetupReport {
  totalFiles: number;
  writtenFiles: number;
  skippedExistingFiles: number;
  failedFiles: number;
  firstFailurePath: string | null;
  firstFailureReason: string | null;
}

export interface NotebookSetupJob {
  notebookId: string;
  templateId: string | null;
  overwriteExisting: boolean;
  status: NotebookSetupJobStatus;
  stage: string;
  completedFiles: number;
  totalFiles: number;
  message: string | null;
  report: NotebookSetupReport | null;
  updatedAt: number;
}

export const notebooks = {
  getAll: () => invoke<NotebookRecord[]>('get_notebooks'),
  listTemplates: () => invoke<NotebookTemplateRecord[]>('list_notebook_templates'),
  getDefaultPath: (name: string) =>
    invoke<string>('get_default_notebook_path', { name }),
  confirmPresetOverwrite: (message: string) =>
    invoke<boolean>('confirm_notebook_preset_overwrite', { message }),
  ensureDefaultPath: (name: string) =>
    invoke<string>('ensure_default_notebook_path', { name }),
  initializeTemplate: (
    notebookId: string,
    templateId: string,
    isNewNotebook: boolean,
  ) => invoke<number>('initialize_notebook_template', {
    notebookId,
    templateId,
    isNewNotebook,
  }),
  create: (
    name: string,
    path?: string,
    icon?: string | null,
    activate = true,
    templateId?: string | null,
    overwriteExisting = false,
  ) => invoke<NotebookRecord>('create_notebook', {
    name, path, icon, activate, templateId, overwriteExisting,
  }),
  ensureTemplateSetup: (notebookId: string, templateId: string, overwriteExisting = false) =>
    invoke<NotebookSetupJob>('ensure_notebook_template_setup', { notebookId, templateId, overwriteExisting }),
  getTemplateSetupStatus: (notebookId: string) =>
    invoke<NotebookSetupJob | null>('get_notebook_template_setup_status', { notebookId }),
  startTemplateSetup: (notebookId: string, retry = false) =>
    invoke<NotebookSetupJob | null>('start_notebook_template_setup', { notebookId, retry }),
  createFromCloud: (id: string, name: string, path: string, icon?: string | null) =>
    invoke<NotebookRecord>('create_notebook_from_cloud', { id, name, path, icon }),
  startImport: (notebookId: string) =>
    invoke<void>('start_notebook_import', { notebookId }),
  getImportStatus: (notebookId: string) =>
    invoke<NotebookImportStatus | null>('get_notebook_import_status', { notebookId }),
  update: (id: string, name?: string, icon?: string | null) =>
    invoke<NotebookRecord | null>('update_notebook', { id, name, icon }),
  delete: (id: string) => invoke<boolean>('delete_notebook', { id }),
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
