export {
  useDocumentStore,
} from '@features/document/store/document-store';
export {
  useDocumentHistoryStore,
  type AgentConversationHistoryEntry,
  type DocumentHistoryEntry,
  type MediaHistoryEntry,
  type WebHistoryEntry,
} from '@features/document/store/document-history-store';
export {
  getActiveDocumentDraft,
  getDocumentDraft,
  recordDocumentEdit,
  registerDocumentCapture,
  captureLatestDocumentContent,
  protectDocumentDraft,
  applyRecoveryDraftContent,
  prepareDocumentLeave,
  saveDocumentContent,
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
  documentLocator,
  documentLocatorKey,
  normalizeDocumentIdentity,
  type DocumentIdentity,
  type DocumentLocator,
} from '@features/document/store/document-identity';
export {
  documentEditorViewKey,
  getDocumentEditorMode,
  setDocumentEditorMode,
  clearDocumentEditorViews,
  useDocumentEditorMode,
  useDocumentEditorViewStore,
  type DocumentEditorMode,
} from '@features/document/store/document-editor-view-store';
export type { DocumentBuffer } from '@features/document/store/document-buffer';
export { subscribeDocumentBufferChanges } from '@features/document/store/buffer-registry';
export {
  readRecoveryDraft,
  listRecoveryDrafts,
  type RecoveryDraft,
} from '@features/document/store/recovery-draft-store';
