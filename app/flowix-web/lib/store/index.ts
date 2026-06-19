// Store exports
export {
  useMemoStore,
  MEMO_COLORS,
  MEMO_COLOR_HEX,
  type MemoStore,
  type Notebook,
  type MemoMeta,
  type TodoItem,
} from './memo-store';
export { type MemoItem, type MemoColor } from '../../types/memo-item';
export {
  useDocumentStore,
  type DocumentStore,
  type MemoDocumentSession,
  type ExternalDocumentSession,
  type ActiveDocumentSession,
} from './document-store';
export {
  useDocumentHistoryStore,
  type DocumentHistoryEntry,
  type MemoHistoryEntry,
  type ExternalHistoryEntry,
} from './document-history-store';
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
} from './document-session-service';
export {
  documentIdentityKey,
  normalizeDocumentIdentity,
  type DocumentIdentity,
} from './document-identity';
export { useTagStore, type MemoTagItem } from './tag-store';
export { useSettingsStore, type SettingsStore, type AppViewState, type AppViewMode } from './settings-store';
export {
  useAgentAccessStore,
  type AgentAccessState,
} from './agent-access-store';
