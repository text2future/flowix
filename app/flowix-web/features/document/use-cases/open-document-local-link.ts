import { columnAtIndex } from '@features/workspace/public/session-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { resolveNotebookIdForPath } from './resolve-notebook-id-for-path';
import { publishHeadingAnchorRequest } from '@features/document/use-cases/heading-anchor-publish';
import type { ResolvedEditorLocalLink } from '@features/editor/editor-link-resolution';
import { canonicalDirectoryPath } from '@/lib/path';

/**
 * Open a local file or folder reached through an in-editor path link.
 *
 * `scopePath` is the notebook/workspace root the linking document belongs to;
 * it keeps the opened target inside the same editable boundary. When a file
 * link carries a heading fragment, a location request is published so the opened
 * document reveals the anchor after load — the same channel agent links use.
 * This module owns the editor → workspace dependency so the editor itself
 * stays free of navigation-layer imports.
 */
export async function openDocumentLocalLink(
  target: ResolvedEditorLocalLink,
  scopePath: string | null,
): Promise<void> {
  if (target.isDirectory) {
    const notebooks = getWorkspaceMemoState().notebooks;
    const notebookId = notebooks.find((notebook) => (
      canonicalDirectoryPath(notebook.path) === canonicalDirectoryPath(target.path)
    ))?.id ?? resolveNotebookIdForPath(target.path, notebooks);
    if (notebookId) {
      const { openFolderCollectionFromFolder } = await import('@features/workspace/public/main-window-api');
      await openFolderCollectionFromFolder(notebookId, target.path, columnAtIndex(0));
      return;
    }
    await openWorkspaceSurface({
      index: 0,
      target: {
        kind: 'file-browser', activeFilePath: null, folderPath: target.path,
        notebookId: null, scopePath: null, fileTreeVisible: true, fileTreeWidth: 220,
      },
    });
    return;
  }
  const opened = await openWorkspaceSurface({
    index: 0,
    target: { kind: 'external', path: target.path, scopePath, transitionId: null },
  });
  publishHeadingAnchorRequest(target.path, opened.status === 'cancelled' ? null : opened.location, target.anchor);
}
