import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { useWorkColumnStore } from '../store/work-column-store';
import { resolveSessionDocumentContext } from './session-document-context';
import { deleteExternalDocument, getWorkspaceDocumentState } from '@features/document/public/workspace-api';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { clearWorkspaceDocument, clearWorkspaceTargetForDeletedFile } from './workspace-navigation';
import { samePath } from '@/lib/path';

export async function deleteMainExternalDocument(expectedFilePath?: string): Promise<'deleted' | 'unsaved' | 'missing' | 'different-file'> {
  const loaded = getWorkspaceDocumentState().activeExternalSession;
  const target = useWorkColumnStore.getState().navigation.target;
  const session = target.kind === 'external'
    ? resolveSessionDocumentContext(target, loaded, getWorkspaceMemoState().notebooks) : loaded;
  if (!session) return 'missing';
  if (expectedFilePath && !samePath(session.fileIdentity.path, expectedFilePath)) return 'different-file';
  if (!await deleteExternalDocument(session)) return 'unsaved';
  useBrowserColumnStore.getState().clearExternalPath(session.fileIdentity.path);
  if (getWorkspaceDocumentState().activeExternalSession?.fileIdentity.displayId === session.fileIdentity.displayId) {
    await clearWorkspaceDocument();
  } else {
    await clearWorkspaceTargetForDeletedFile(session.fileIdentity.path);
  }
  return 'deleted';
}
