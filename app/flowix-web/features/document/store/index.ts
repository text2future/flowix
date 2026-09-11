export {
  useDocumentStore,
  type MemoDocumentSession,
} from '@features/document/store/document-store';
export {
  useDocumentHistoryStore,
  type ArtifactHistoryEntry,
  type AgentConversationHistoryEntry,
  type DocumentHistoryEntry,
  type MemoHistoryEntry,
} from '@features/document/store/document-history-store';
export {
  getActiveDocumentDraft,
  getDocumentDraft,
  consumeSelfDocumentPathUpdate,
  markSelfDocumentPathUpdate,
  recordDocumentEdit,
  saveDocumentContent,
  flushDocumentPath,
  getDocumentBuffer,
  hasDocumentUnsavedChanges,
  discardDocumentDraft,
  applyLoadedDocumentContent,
  consumeStagedDocumentSnapshot,
  stageDocumentSnapshot,
  setActiveDocumentPath,
  rebaseActiveDocumentPath,
} from '@features/document/store/document-session-service';
export {
  documentIdentityKey,
  normalizeDocumentIdentity,
  type DocumentIdentity,
} from '@features/document/store/document-identity';
export type { DocumentBuffer } from '@features/document/store/document-buffer';
export { subscribeDocumentBufferChanges } from '@features/document/store/buffer-registry';
export { useDocumentMetricsStore } from '@features/document/store/document-metrics-store';
