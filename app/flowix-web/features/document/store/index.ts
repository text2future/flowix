export {
  useDocumentStore,
  type DocumentStore,
  type MemoDocumentSession,
  type ExternalDocumentSession,
  type ActiveDocumentSession,
} from '@features/document/store/document-store';
export {
  useDocumentHistoryStore,
  type DocumentHistoryEntry,
  type MemoHistoryEntry,
  type ExternalHistoryEntry,
} from '@features/document/store/document-history-store';
export {
  getActiveDocumentDraft,
  consumeSelfDocumentPathUpdate,
  getCurrentIdentity,
  getCurrentPath,
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
  type DocumentDraftSnapshot,
  type DocumentEditResult,
  type SaveDocumentContentOptions,
} from '@features/document/store/document-session-service';
export {
  documentIdentityKey,
  normalizeDocumentIdentity,
  type DocumentIdentity,
} from '@features/document/store/document-identity';
export type { DocumentBuffer } from '@features/document/store/document-buffer';
