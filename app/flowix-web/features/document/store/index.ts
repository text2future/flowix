export {
  useDocumentStore,
  type MemoDocumentSession,
} from '@features/document/store/document-store';
export {
  useDocumentHistoryStore,
  type DocumentHistoryEntry,
  type MemoHistoryEntry,
} from '@features/document/store/document-history-store';
export {
  getActiveDocumentDraft,
  consumeSelfDocumentPathUpdate,
  isRecentSelfDocumentWrite,
  markSelfDocumentPathUpdate,
  markSelfDocumentWrite,
  recordDocumentEdit,
  saveDocumentContent,
  flushDocumentPath,
  getDocumentBuffer,
  hasDocumentUnsavedChanges,
  applyLoadedDocumentContent,
  setActiveDocumentPath,
} from '@features/document/store/document-session-service';
export {
  documentIdentityKey,
  normalizeDocumentIdentity,
  type DocumentIdentity,
} from '@features/document/store/document-identity';
export type { DocumentBuffer } from '@features/document/store/document-buffer';
