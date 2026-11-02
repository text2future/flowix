import { publishNotebookPathCreated, publishNotebookPathMove, type NotebookPathCreated, type NotebookPathMove } from '../notebook-change-events';
import { invokeDocumentMutation } from './document-mutation';
import { invoke } from '@tauri-apps/api/core';
import type { NoteColor } from '@/types/note-item';
import type { NoteContentCommit } from '@/types/memo';

export type FilterType = 'all' | 'todos' | 'agents' | 'favorited' | 'tagged' | 'thisWeek' | 'thisMonth';
export type SortType = 'createdAt' | 'updatedAt' | 'filenameAsc' | 'filenameDesc';
export type NoteColorFilter = 'any' | 'none' | NoteColor;
export type NotePathStatus = 'present' | 'missing';
export type NoteDeleteOutcome = 'deleted' | 'missingCleaned';
export type PruneMissingNoteOutcome = 'present' | 'missingCleaned';
export type MatchField = 'title' | 'tag' | 'body';
export type NoteVersionSource = 'auto' | 'manual' | 'restore_backup' | 'cloud_conflict';

export interface NoteEntry {
  /** File size in bytes, supplied by the note index. */
  sizeBytes?: number;
  relativePath: string;
  title: string;
  preview: string;
  thumbnail: string | null;
  tags: string[];
  todos: { content: string; status: string }[];
  agents: { threadId: string; title: string; agentType: string }[];
  createdAt: number;
  updatedAt: number;
  favorited: boolean;
  icon: string | null;
  colors: NoteColor[];
  properties: Record<string, unknown>;
}

export interface CreatedNoteDocument {
  notebookId: string;
  relativePath: string;
  path: string;
  initialContent: string;
  entry: NoteEntry;
  notebookChange?: NotebookPathCreated;
}

function publishCreatedNote(result: CreatedNoteDocument): CreatedNoteDocument {
  // Older desktop processes return the path result without a change receipt.
  // The command result still confirms creation, so refresh this window locally.
  publishNotebookPathCreated(result.notebookChange ?? {
    notebookId: result.notebookId,
    relativePath: result.relativePath,
  });
  return result;
}

export interface MarkdownLocation {
  path: string;
  notebookId: string | null;
  relativePath: string | null;
  notebookPath: string | null;
  indexable: boolean;
}

export interface NoteTitleFilter {
  match: 'all' | 'any';
  conditions: Array<{ op: 'eq' | 'contains'; value: string }>;
}

export interface NoteListPage {
  notes: NoteEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Title-only row for pickers; carries no preview, todos, agents or properties. */
export interface NoteSummary {
  relativePath: string;
  title: string;
  updatedAt: number;
}

export interface NoteSearchHit {
  notebookId: string;
  relativePath: string;
  title: string;
  snippet: string;
  matchedIn: MatchField;
}

export interface NoteTemplate {
  id: string;
  name: string;
}

export interface PathVersionMeta {
  id: string;
  createdAt: number;
  source: NoteVersionSource;
  size: number;
  contentHash: string;
}

export interface PathArchiveSummary {
  notebookId: string;
  notebookName: string;
  relativePath: string;
  latestAt: number;
  versionCount: number;
}

/** Path-identified Markdown operations. Existing IPC command names remain adapters. */
export const notes = {
  resolveLocation: (filePath: string) =>
    invoke<MarkdownLocation>('resolve_markdown_location', { filePath }),
  readDocument: (filePath: string) => invoke<string | null>('read_document', { filePath }),
  writeDocument: (params: { filePath: string; content: string; expectedContent?: string }) =>
    invokeDocumentMutation<({ path: string; content: string } & NoteContentCommit) | null>('write_document', {
      filePath: params.filePath,
      content: params.content,
      expectedContent: params.expectedContent,
    }),
  modifiedAt: (filePath: string) => invoke<number | null>('get_document_modified_at', { filePath }),
  moveToDirectory: (filePath: string, notebookId: string, parentRelativePath: string) =>
    invoke<{ path: string; notebookChange: NotebookPathMove }>('move_memo_to_directory', { filePath, notebookId, parentRelativePath }).then((result) => { publishNotebookPathMove(result.notebookChange); return result; }),
  list: (notebookId: string) => invoke<NoteEntry[]>('list_notes_by_path', { notebookId }),
  getIndexed: (notebookId: string, relativePath: string) =>
    invoke<NoteEntry | null>('get_indexed_note_by_path', { notebookId, relativePath }),
  listSummaries: (notebookId: string) =>
    invoke<NoteSummary[]>('list_note_summaries', { notebookId }),
  getPage: (params: {
    notebookId: string;
    filter?: FilterType;
    sort?: SortType;
    tagId?: string;
    color?: NoteColorFilter;
    cursor?: string;
    limit?: number;
    titleFilter?: NoteTitleFilter;
  }) => invoke<NoteListPage>('get_path_notes', {
    notebookId: params.notebookId,
    filter: params.filter || 'all',
    sort: params.sort || 'createdAt',
    tagId: params.tagId,
    color: params.color,
    cursor: params.cursor,
    titleFilter: params.titleFilter,
    limit: params.limit,
  }),
  search: (notebookId: string, query: string, limit?: number) =>
    invoke<NoteSearchHit[]>('search_path_notes', { notebookId, query, limit }),
  pathStatus: (filePath: string) => invoke<NotePathStatus>('note_path_status', { filePath }),
  delete: (filePath: string) => invoke<NoteDeleteOutcome>('delete_memo', { filePath }),
  pruneMissing: (filePath: string) => invoke<PruneMissingNoteOutcome>('prune_missing_memo', { filePath }),
  /** Omitted parent uses the notebook's default create folder; '' explicitly targets the notebook root. */
  create: (notebookId: string, tag?: string, parentRelativePath?: string, title?: string) =>
    invoke<CreatedNoteDocument>('add_path_document', { tag, notebookId, parentRelativePath, title })
      .then(publishCreatedNote),
  createFromTemplate: (templateId: string, notebookId: string) =>
    invoke<CreatedNoteDocument>('create_path_from_template', { templateId, notebookId })
      .then(publishCreatedNote),
  listTemplates: () => invoke<NoteTemplate[]>('list_memo_templates'),
  saveTemplate: (title: string, content: string) => invoke<NoteTemplate>('save_memo_template', { title, content }),
  deleteTemplate: (templateId: string) => invoke<boolean>('delete_memo_template', { templateId }),
  importDocument: (filePath: string, content: string, notebookId: string) =>
    invoke<CreatedNoteDocument>('import_external_document_by_path', { filePath, content, notebookId })
      .then(publishCreatedNote),
  listVersions: (notebookId: string, relativePath: string) =>
    invoke<PathVersionMeta[]>('list_path_versions', { notebookId, relativePath }),
  listArchives: () => invoke<PathArchiveSummary[]>('list_local_path_archives'),
  restoreArchivedVersion: (notebookId: string, relativePath: string, versionId: string) =>
    invoke<void>('restore_local_path_version', { notebookId, relativePath, versionId }),
  createVersion: (notebookId: string, relativePath: string) =>
    invoke<PathVersionMeta | null>('create_path_version', { notebookId, relativePath, source: 'manual' }),
  restoreVersion: (notebookId: string, relativePath: string, versionId: string, expectedContent?: string) =>
    invoke<string | null>('restore_path_version', { notebookId, relativePath, versionId, expectedContent }),
};
