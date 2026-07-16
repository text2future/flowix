import type { DocumentIdentity } from '@features/document/store/document-identity';

export interface MemoContentUpdatedEvent {
  id: string;
  path: string;
}

interface HandleSiblingWindowContentUpdateOptions {
  event: MemoContentUpdatedEvent;
  identity: DocumentIdentity;
  isDirty: boolean;
  onConflict: () => void;
  clearSaveTimer: () => void;
  reloadDocument: (path: string, options: {
    preservePending: boolean;
    showLoading: boolean;
  }) => Promise<void>;
}

export type SiblingWindowContentUpdateResult = 'ignored' | 'conflict' | 'reloaded';

export async function handleSiblingWindowContentUpdate({
  event,
  identity,
  isDirty,
  onConflict,
  clearSaveTimer,
  reloadDocument,
}: HandleSiblingWindowContentUpdateOptions): Promise<SiblingWindowContentUpdateResult> {
  if (identity.kind !== 'memo' || event.id !== identity.id || !event.path) {
    return 'ignored';
  }

  if (isDirty) {
    onConflict();
    return 'conflict';
  }

  clearSaveTimer();
  await reloadDocument(event.path, { preservePending: false, showLoading: false });
  return 'reloaded';
}
