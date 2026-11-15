import { getDocumentResourceSnapshot } from '@features/document/public/resource-context';
import { prepareLocalLinkNavigation } from '@features/editor/public/link-navigation-api';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';
import { columnAtIndex } from '@features/workspace/public/session-api';
import { openPreparedWorkspaceSurface } from '@features/workspace/public/session-opening-api';
import { publishHeadingAnchorRequest } from '@features/document/use-cases/heading-anchor-publish';
import type { ResolvedEditorLocalLink } from '@features/editor/public/link-navigation-api';

/** Resolve editor path links once, then open them under the captured navigation intent. */
export async function openDocumentLocalLink(
  target: ResolvedEditorLocalLink,
  scopePath: string | null,
  documentPath?: string,
): Promise<void> {
  let path = target.path;
  const opened = await openPreparedWorkspaceSurface({
    columnId: columnAtIndex(0),
    target: { kind: 'external', path, scopePath, transitionId: null },
  }, async isCurrent => {
    const prepared = await prepareLocalLinkNavigation(target, documentPath, {
      notebooks: getDocumentResourceSnapshot().notebooks, isCurrent,
    });
    if (!prepared) throw new NavigationCancelledError('Local link navigation cancelled');
    const { location } = prepared;
    path = location.path;
    if (!location.isDirectory) {
      return {
        target: { kind: 'external', path, scopePath, transitionId: null },
        options: { markdownLocation: location },
      };
    }
    const { notebookId, notebookPath } = location;
    return {
      target: notebookId && notebookPath ? {
        kind: 'folder-collection', folderPath: path, notebookId,
        notebookPath, folderName: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
      } : {
        kind: 'file-browser', activeFilePath: null, folderPath: path,
        notebookId: null, scopePath: null, fileTreeVisible: true, fileTreeWidth: 220,
      },
    };
  });
  publishHeadingAnchorRequest(path, opened.status === 'cancelled' ? null : opened.location, target.anchor);
}
