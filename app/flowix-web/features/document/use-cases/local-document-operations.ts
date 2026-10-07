import { renameCollectionAtPath } from '@features/collection/mutations';
import { canonicalPath } from '@/lib/path';
import { externalDocuments } from '@platform/tauri/client';
import { files } from '@platform/tauri/client/desktop';
import { updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import { beginExternalDocumentRename, isExternalDocumentRenameInProgress } from '@features/document/store/external-document-operation';

import type { EditableDocumentOperations } from './editable-document-operations';

/** Persistence boundary for Markdown and other editable local files. */
export const localDocumentOperations: EditableDocumentOperations = {
  read: ({ path, scopePath }) => externalDocuments.read(path, scopePath),
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
  rename: async ({ path, name, scopePath, notebookId, collectionId }) => {
    if (!scopePath) throw new Error('A file scope is required to rename this document');
    if (/\.(?:table|lib)\.ya?ml$/i.test(path)) {
      const title = name.replace(/\.(?:table|lib)\.ya?ml$/i, '');
      const result = await renameCollectionAtPath(path, scopePath, title, notebookId, collectionId);
      if (result.errorCode) throw new Error(`集合已更新，但操作尚未完成：${result.errorCode}`);
      return { path: result.filePath };
    }
    const renamedPath = canonicalPath(await files.rename(path, name, scopePath));
    if (/\.(?:md|markdown)$/i.test(path) && renamedPath !== canonicalPath(path)) {
      updateNoteLinksAfterMove(path, renamedPath);
    }
    return { path: renamedPath };
  },
  delete: async ({ path, scopePath }) => {
    const deleted = await files.delete(path, scopePath ?? undefined);
    if (!deleted) throw new Error('delete_file returned false');
    return { path: canonicalPath(path) };
  },
};

export interface RenameMarkdownTitleRequest {
  path: string;
  title: string;
  scopePath: string;
  displayId: string;
  expectFollowupWrite?: boolean;
  onPathChanged: (oldPath: string, newPath: string) => void;
}

export interface RenameMarkdownTitleResult {
  path: string;
  filename: string;
  changed: boolean;
}

/** Build a Markdown filename from a title while preserving its extension. */
export function markdownFilenameForTitle(path: string, requestedTitle: string): string | null {
  const filename = path.split(/[\\/]/).pop() ?? '';
  const extension = filename.match(/(\.markdown|\.md)$/i)?.[0] ?? '';
  let title = requestedTitle.trim();
  if (extension && title.toLowerCase().endsWith(extension.toLowerCase())) {
    title = title.slice(0, -extension.length).trimEnd();
  }
  if (!title || title === '.' || title === '..') return null;
  return `${title}${extension}`;
}

/**
 * Rename a note title through the shared scoped file operation, coordinating
 * open editor buffers and publishing the new path before releasing the rename
 * lock. The backend owns index and table-reference maintenance.
 */
export async function renameMarkdownTitle({
  path,
  title,
  scopePath,
  displayId,
  expectFollowupWrite = false,
  onPathChanged,
}: RenameMarkdownTitleRequest): Promise<RenameMarkdownTitleResult | null> {
  const sourcePath = canonicalPath(path);
  const filename = markdownFilenameForTitle(sourcePath, title);
  if (!filename) return null;
  const currentFilename = sourcePath.split(/[\\/]/).pop() ?? '';
  if (filename === currentFilename) {
    return { path: sourcePath, filename, changed: false };
  }
  if (isExternalDocumentRenameInProgress(displayId)) {
    throw new Error('此笔记正在重命名，请稍后重试');
  }

  const operation = beginExternalDocumentRename(displayId);
  const cancelExpectedDelete = operation.expectSourceDelete(sourcePath);
  try {
    const renamed = await localDocumentOperations.rename({ path: sourcePath, name: filename, scopePath });
    if (expectFollowupWrite) operation.expectFollowupWrite(renamed.path);
    onPathChanged(sourcePath, renamed.path);
    return {
      path: renamed.path,
      filename: renamed.path.split(/[\\/]/).pop() ?? filename,
      changed: true,
    };
  } catch (error) {
    cancelExpectedDelete();
    throw error;
  } finally {
    operation.finish();
  }
}
