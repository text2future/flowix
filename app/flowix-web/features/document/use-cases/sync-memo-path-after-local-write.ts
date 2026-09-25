import { markSelfDocumentPathUpdate } from '@features/document/store/document-session-service';
import { replaceBrowserColumnMemoPath } from '@features/workspace/use-cases/browser-column-navigation';
import { replaceActiveMemoPath } from '@features/workspace/use-cases/workspace-navigation';

export function syncMemoPathAfterLocalWrite(memoId: string, path: string): void {
  replaceBrowserColumnMemoPath(memoId, path);
  markSelfDocumentPathUpdate(memoId, path);
  replaceActiveMemoPath(memoId, path);
}
