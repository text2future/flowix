import { canonicalPath, isPathInDirectory } from '@/lib/path';
import { listDocumentSessions } from '../store/document-runtime-session';
import { captureLatestDocumentContent, recordDocumentEdit, scheduleDocumentSessionSave } from '../store/document-session-service';
import { notifyDocumentBufferChanged } from '../store/buffer-registry';

/** Reconcile source links in live bodies before exposing their new paths to editing. */
export async function rebaseWorkspaceDocumentLinkSources(
  previous: string,
  next: string,
  directory: boolean,
  batch: { id: string; through: number; rewriteSource: (content: string, path: string, applied: number) => Promise<string> },
): Promise<void> {
  for (const session of listDocumentSessions()) {
    const path = canonicalPath(session.identity.path);
    if (!session.loaded || !session.buffer || !/\.(?:md|markdown)$/i.test(path)) continue;
    if (path !== previous && !(directory && isPathInDirectory(path, previous))) continue;
    captureLatestDocumentContent(session.identity);
    const destination = next + path.slice(previous.length);
    const applied = session.linkRewriteStage?.batchId === batch.id ? session.linkRewriteStage.through : 0;
    const updated = await batch.rewriteSource(session.buffer.content, destination, applied);
    const bodyChanged = updated !== session.buffer.content;
    const edit = recordDocumentEdit(session.identity, updated);
    session.linkRewriteStage = { batchId: batch.id, through: batch.through, revision: edit.buffer.capturedRevision };
    if (edit.changed) {
      // The existing merged-content channel updates the editor synchronously,
      // before a subsequent capture or keystroke can restore the old body.
      if (bodyChanged) notifyDocumentBufferChanged(session.identity, 'merged');
      if (session.adapters.size || session.retainedAdapter) scheduleDocumentSessionSave(session.identity);
    }
  }
}

/** With a disk body, only acknowledge stages proven to be in that canonical save. */
export function getWorkspaceDocumentLinkStage(path: string, batchId: string, savedContent?: string): number | undefined {
  const session = listDocumentSessions().find(item => canonicalPath(item.identity.path) === canonicalPath(path));
  const stage = session?.linkRewriteStage;
  if (!stage || stage.batchId !== batchId || !session?.buffer) return undefined;
  if (savedContent !== undefined && (session.buffer.lastSavedContent !== savedContent
    || session.buffer.savedRevision < stage.revision)) return undefined;
  return stage.through;
}
