import { deleteExternalDocument, getWorkspaceDocumentState } from '@features/document/public/workspace-api';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { clearWorkspaceDocument } from './workspace-navigation';
import { samePath } from '@/lib/path';

export async function deleteMainExternalDocument(expectedFilePath?: string): Promise<'deleted' | 'unsaved' | 'missing' | 'different-file'> {
  const session = getWorkspaceDocumentState().activeExternalSession;
  if (!session) return 'missing';
  if (expectedFilePath && !samePath(session.fileIdentity.path, expectedFilePath)) return 'different-file';
  if (!await deleteExternalDocument(session)) return 'unsaved';
  useBrowserColumnStore.getState().clearExternalPath(session.fileIdentity.path);
  if (getWorkspaceDocumentState().activeExternalSession?.fileIdentity.displayId === session.fileIdentity.displayId) {
    await clearWorkspaceDocument();
  }
  return 'deleted';
}
