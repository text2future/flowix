import { findWorkspaceContentLocations } from './workspace-content-activation';
import { openWorkspaceSurface } from '../public/open-surface-api';

/** Background notifications must not reactivate or duplicate an open document. */
export async function openExternallyCreatedNote(
  path: string,
  notebookPath: string,
  notebookId: string,
): Promise<void> {
  const locations = findWorkspaceContentLocations({ kind: 'external', path });
  if (locations.workColumn || locations.browserColumn) return;

  await openWorkspaceSurface({
    index: 1,
    target: { kind: 'external', path, scopePath: notebookPath, transitionId: null },
    options: { notebookId },
  });
}

/** A deliberate card action uses normal navigation, including activating an existing tab. */
export async function openCreatedDocumentFromNotice(path: string, notebookPath: string, notebookId: string): Promise<boolean> {
  const result = await openWorkspaceSurface({
    index: 1,
    target: { kind: 'external', path, scopePath: notebookPath, transitionId: null },
    options: { notebookId },
  });
  return result.status !== 'cancelled';
}
