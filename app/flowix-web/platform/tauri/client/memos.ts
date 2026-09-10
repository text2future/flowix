import { invoke } from '@tauri-apps/api/core';
import type { MemoColor, MemoItem } from '@/types/memo-item';
import type { MemoContentCommit } from '@/types/memo';
import type { AgentRoleMemoItem } from './general';
import type { ResolvedOpenTarget } from '@platform/open-target/types';

export type FilterType = 'all' | 'todos' | 'agents' | 'favorited' | 'tagged' | 'thisWeek' | 'thisMonth';
export type SortType = 'createdAt' | 'updatedAt';
export type MemoColorFilter = 'any' | 'none' | MemoColor;

export interface MemoListPage {
  memos: MemoItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

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
    color?: MemoColorFilter;
    cursor?: string;
    limit?: number;
  }) => invoke<MemoListPage>('get_memos', {
    notebookId: params?.notebookId,
    filter: params?.filter || 'all',
    sort: params?.sort || 'createdAt',
    tagId: params?.tagId,
    color: params?.color,
    cursor: params?.cursor,
    limit: params?.limit,
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
  readMemo: (id: string) => invoke<MemoItem | null>('read_memo', { id }),
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
    key: string;
    content: string;
    expectedContent?: string;
  }) => invoke<({ path: string; content: string } & MemoContentCommit) | null>('write_document', {
    key: params.key,
    content: params.content,
    expectedContent: params.expectedContent,
  }),
  getLaunchOpenFiles: () => invoke<string[]>('get_launch_open_files'),
  addDocument: (tag?: string, notebookId?: string, parentRelativePath?: string) =>
    invoke<MemoItem>('add_document', { tag, notebookId, parentRelativePath }),
  moveMemoToDirectory: (id: string, notebookId: string, parentRelativePath: string) =>
    invoke<{
      memo: MemoItem;
      oldPath: string;
      path: string;
    }>('move_memo_to_directory', { id, notebookId, parentRelativePath }),
  renameMemoTitle: (params: { id: string; title: string; expectedFilename?: string }) =>
    invoke<{ memo: MemoItem; oldPath: string; path: string }>('rename_memo_title', {
      id: params.id,
      title: params.title,
      expectedFilename: params.expectedFilename,
    }),
  listTemplates: () => invoke<MemoTemplate[]>('list_memo_templates'),
  saveTemplate: (title: string, content: string) =>
    invoke<MemoTemplate>('save_memo_template', { title, content }),
  deleteTemplate: (templateId: string) =>
    invoke<boolean>('delete_memo_template', { templateId }),
  createFromTemplate: (templateId: string, notebookId?: string) =>
    invoke<MemoItem>('create_memo_from_template', { templateId, notebookId }),
  importExternalDocumentToMemo: (filePath: string, content: string, notebookId?: string) =>
    invoke<MemoItem | null>('import_external_document_to_memo', { filePath, content, notebookId }),
  deleteMemo: (id: string) => invoke<boolean>('delete_memo', { id }),
  clearMemos: (notebookId?: string) => invoke<boolean>('clear_memos', { notebookId }),
  favoriteMemo: (id: string) => invoke<boolean>('favorite_memo', { id }),
  unfavoriteMemo: (id: string) => invoke<boolean>('unfavorite_memo', { id }),
  setMemoColors: (id: string, colors: MemoColor[]) =>
    invoke<boolean>('set_memo_colors', { id, colors }),
  listVersions: (id: string) =>
    invoke<MemoVersionMeta[]>('list_memo_versions', { id }),
  restoreVersion: (id: string, versionId: string, expectedContent?: string) =>
    invoke<({ path: string; content: string } & MemoContentCommit) | null>('restore_memo_version', {
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
  openMemoByTarget: (raw: string, options?: { emitEvent?: boolean }) => invoke<ResolvedOpenTarget | null>(
    'open_memo_by_target',
    { raw, emitEvent: options?.emitEvent ?? true },
  ),
};

export type ExternalDocumentWriteOutcome =
  | { status: 'saved'; path: string; content: string }
  | { status: 'conflict'; diskContent: string }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export const externalDocuments = {
  read: (filePath: string, scopePath?: string | null) =>
    invoke<string>('read_external_document', { filePath, scopePath: scopePath ?? null }),
  write: (params: {
    filePath: string;
    content: string;
    expectedContent?: string;
    scopePath?: string | null;
  }) => invoke<ExternalDocumentWriteOutcome>('write_external_document', {
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

export const notebooks = {
  getAll: () => invoke<NotebookRecord[]>('get_notebooks'),
  create: (name: string, path?: string, icon?: string | null) =>
    invoke<NotebookRecord>('create_notebook', { name, path, icon }),
  createFromCloud: (id: string, name: string, path: string, icon?: string | null) =>
    invoke<NotebookRecord>('create_notebook_from_cloud', { id, name, path, icon }),
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
