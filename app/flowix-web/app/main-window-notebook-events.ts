import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import {
  getAppNotebookPath,
  refreshAppPathNoteMetadata,
} from '@features/memo/public/app-api';
import { invalidateMentionNotes } from '@features/editor/public/mention-data-api';
import { invalidateMentionTags } from '@features/editor/public/mention-data-api';
import { notifyCreatedDocument, removeCreatedDocumentNotices, moveCreatedDocumentNotices } from './created-document-notices';
import { rebaseStoredRecoveryDraftPaths } from '@features/document/public/workspace-api';
import { removeBrowserColumnContentByPath, applyNotebookPathMove } from '@features/workspace/public/app-api';
import { clearWorkspaceTargetForDeletedFile } from '@features/workspace/public/shell-api';
import { createLogger } from '@/lib/logger';
import { joinNotebookMemoPath } from '@/lib/path';

const logger = createLogger('main-window-notebook-events');

/** Mount the main window's production notebook path event projections. */
export function mountMainWindowNotebookEvents(): () => void {
  let pathChangeChain = Promise.resolve();
  let disposed = false;
  const unsubscribe = subscribeNotebookChanges((change) => {
    const { notebookId } = change;
    invalidateMentionNotes();
    invalidateMentionTags();
    refreshAppPathNoteMetadata(notebookId);

    if (change.kind === 'resource-created'
      && change.source === 'external_tool'
      && change.relativePath.split('/').pop() !== 'AGENTS.md') {
      const { relativePath } = change;
      pathChangeChain = pathChangeChain.then(async () => {
        if (disposed) return;
        const notebookPath = await getAppNotebookPath(notebookId);
        const path = notebookPath && joinNotebookMemoPath(notebookPath, relativePath);
        if (disposed || !path || !notebookPath) return;
        notifyCreatedDocument(path, notebookPath, notebookId);
      }).catch((error) => logger.warn('queue created document notification failed', { error, notebookId, relativePath }));
    }

    if (change.kind === 'path-moved') {
      const { previousRelativePath, relativePath, directory } = change;
      pathChangeChain = pathChangeChain.then(async () => {
        if (disposed) return;
        const notebookPath = await getAppNotebookPath(notebookId);
        if (!disposed && notebookPath) {
          await applyNotebookPathMove({ notebookId, notebookPath, previousRelativePath, relativePath, directory });
          const previous = joinNotebookMemoPath(notebookPath, previousRelativePath);
          const next = joinNotebookMemoPath(notebookPath, relativePath);
          if (previous && next) {
            moveCreatedDocumentNotices(previous, next, directory);
            await rebaseStoredRecoveryDraftPaths(previous, next, directory);
          }
        }
      }).catch((error) => logger.warn('rebase moved note path failed', { error, notebookId, relativePath }));
    }

    if (change.kind === 'resource-deleted') {
      const { relativePath } = change;
      pathChangeChain = pathChangeChain.then(async () => {
        if (disposed) return;
        const notebookPath = await getAppNotebookPath(notebookId);
        if (disposed) return;
        const path = notebookPath && joinNotebookMemoPath(notebookPath, relativePath);
        if (path) {
          removeCreatedDocumentNotices(path);
          removeBrowserColumnContentByPath(path);
          await clearWorkspaceTargetForDeletedFile(path);
        }
      }).catch((error) => logger.warn('resolve deleted note path failed', { error, notebookId, relativePath }));
    }
  });
  return () => { disposed = true; unsubscribe(); };
}
