import { renameCollectionAtPath } from '@features/collection/mutations';
import { canonicalPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { externalDocuments } from '@platform/tauri/client';
import { files } from '@platform/tauri/client/desktop';
import { prepareMovedDocumentForRead, updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import { beginExternalDocumentRename, isExternalDocumentRenameInProgress } from '@features/document/store/external-document-operation';
import { beginNotebookPathRename } from '@platform/tauri/notebook-change-events';

import type { EditableDocumentOperations } from './editable-document-operations';

/** Persistence boundary for Markdown and other editable local files. */
export const localDocumentOperations: Omit<EditableDocumentOperations, 'rename'> = {
  read: async ({ path, scopePath }) => {
    await prepareMovedDocumentForRead(path);
    return externalDocuments.read(path, scopePath);
  },
  write: async ({ path, content, expectedContent, scopePath }) => {
    const result = await externalDocuments.write({
      filePath: path,
      content,
      expectedContent,
      scopePath,
    });
    return result.status === 'saved'
      ? { status: 'saved', path: canonicalPath(result.path), content: result.content }
      : result;
  },
  delete: async ({ path, scopePath }) => {
    const deleted = await files.delete(path, scopePath ?? undefined);
    if (!deleted) throw new Error('delete_file returned false');
    return { path: canonicalPath(path) };
  },
};

// Only the guarded rename use case below may reach the native mutation.
const renameLocalPath: EditableDocumentOperations['rename'] = async ({ path, name, scopePath, notebookId, collectionId }) => {
  if (!scopePath) throw new Error('A file scope is required to rename this document');
  if (/\.(?:(?:table|lib)\.ya?ml|index\.yaml)$/i.test(path)) {
    const title = name.replace(/\.(?:(?:table|lib)\.ya?ml|index\.yaml)$/i, '');
    const result = await renameCollectionAtPath(path, scopePath, title, notebookId, collectionId);
    if (result.errorCode) throw new Error(`集合已更新，但操作尚未完成：${result.errorCode}`);
    return { path: result.filePath };
  }
  const renamedPath = canonicalPath(await files.rename(path, name, scopePath));
  if (renamedPath !== canonicalPath(path)) {
    updateNoteLinksAfterMove(path, renamedPath);
  }
  return { path: renamedPath };
};

export interface RenameLocalDocumentFileRequest {
  path: string;
  name: string;
  scopePath: string;
  /** Explicitly null for files outside a registered notebook. */
  notebook: { id: string; path: string } | null;
  displayId: string;
  collectionId?: string;
  expectFollowupWrite?: boolean;
  onPathChanged: (oldPath: string, newPath: string) => void;
}

export type RenameMarkdownTitleRequest = Omit<RenameLocalDocumentFileRequest, 'name'> & { title: string };

export interface RenameMarkdownTitleResult {
  path: string;
  filename: string;
  changed: boolean;
}

/**
 * Replace characters the backend rejects in file names with spaces, matching
 * `sanitize_filename_component` (`/ \ : * ? " < > |`) plus control characters
 * and a trailing dot, so a title rename never rejects on reserved characters.
 */
export function sanitizeTitleForFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, ' ')
    // Unicode Cc covers C0/C1 controls, matching the backend's `char::is_control`.
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .replace(/\.+$/, '')
    .trim();
}

/** Strip the current file's Markdown extension from a requested title. */
function requestedTitleStem(path: string, requestedTitle: string): string {
  const filename = path.split(/[\\/]/).pop() ?? '';
  const extension = filename.match(/(\.markdown|\.md)$/i)?.[0] ?? '';
  let title = requestedTitle.trim();
  if (extension && title.toLowerCase().endsWith(extension.toLowerCase())) {
    title = title.slice(0, -extension.length).trimEnd();
  }
  return title;
}

/** True when the requested title needed filesystem-reserved characters replaced. */
function titleNeededSanitization(path: string, requestedTitle: string): boolean {
  const stem = requestedTitleStem(path, requestedTitle);
  return sanitizeTitleForFilename(stem) !== stem.trim();
}

/** Build a Markdown filename from a title while preserving its extension. */
export function markdownFilenameForTitle(path: string, requestedTitle: string): string | null {
  const title = sanitizeTitleForFilename(requestedTitleStem(path, requestedTitle));
  if (!title || title === '.' || title === '..') return null;
  const extension = (path.split(/[\\/]/).pop() ?? '').match(/(\.markdown|\.md)$/i)?.[0] ?? '';
  return `${title}${extension}`;
}

/**
 * Rename a note title through the shared scoped file operation, coordinating
 * open editor buffers and publishing the new path before releasing the rename
 * lock. The backend owns index and table-reference maintenance.
 */
export async function renameMarkdownTitle({ title, ...request }: RenameMarkdownTitleRequest): Promise<RenameMarkdownTitleResult | null> {
  const name = markdownFilenameForTitle(request.path, title);
  if (!name) return null;
  const result = await renameLocalDocumentFile({ ...request, name });
  if (result.changed && titleNeededSanitization(request.path, title)) {
    toast.info(translate(getCurrentAppLanguage(), 'memo.fileTree.invalidNameReplaced'));
  }
  return result;
}

/** Rename an exact filename with the same session/event protection as a title edit. */
export async function renameLocalDocumentFile({
  path,
  name: filename,
  scopePath,
  notebook,
  displayId,
  collectionId,
  expectFollowupWrite = false,
  onPathChanged,
}: RenameLocalDocumentFileRequest): Promise<RenameMarkdownTitleResult> {
  const sourcePath = canonicalPath(path);
  const currentFilename = sourcePath.split(/[\\/]/).pop() ?? '';
  if (filename === currentFilename) {
    return { path: sourcePath, filename, changed: false };
  }
  if (isExternalDocumentRenameInProgress(displayId)) {
    throw new Error('此笔记正在重命名，请稍后重试');
  }

  const rootPrefix = notebook ? `${canonicalPath(notebook.path).replace(/\/+$/, '')}/` : null;
  const relativePath = rootPrefix && sourcePath.startsWith(rootPrefix)
    ? sourcePath.slice(rootPrefix.length) : null;
  if (notebook && (!notebook.path || !relativePath)) {
    throw new Error('Rename source must belong to the supplied notebook');
  }

  const operation = beginExternalDocumentRename(displayId);
  const cancelExpectedDelete = operation.expectSourceDelete(sourcePath);
  let finishNotebookRename: ((succeeded: boolean) => void) | undefined;
  let renameConfirmed = false;
  try {
    if (notebook && relativePath) {
      finishNotebookRename = beginNotebookPathRename(notebook.id, relativePath);
    }
    const renamed = await renameLocalPath({ path: sourcePath, name: filename, scopePath, notebookId: notebook?.id, collectionId });
    renameConfirmed = true;
    if (expectFollowupWrite) operation.expectFollowupWrite(renamed.path);
    onPathChanged(sourcePath, renamed.path);
    return {
      path: renamed.path,
      filename: renamed.path.split(/[\\/]/).pop() ?? filename,
      changed: true,
    };
  } catch (error) {
    // A projection failure cannot undo the already confirmed filesystem move.
    if (!renameConfirmed) cancelExpectedDelete();
    throw error;
  } finally {
    finishNotebookRename?.(renameConfirmed);
    operation.finish();
  }
}
