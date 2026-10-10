export { DocumentTitlebarWin } from '@features/document/components/document-titlebar-win';
export { DocumentTitlebarMac } from '@features/document/components/document-titlebar-mac';
export { NotePropertiesHost } from '@features/document/components/note-properties-host';
export { useDocumentCommands } from '@features/document/components/use-document-commands';
export {
  EXTERNAL_FILE_DROP_EVENT,
  type ExternalFileDropDetail,
  useExternalFileDrop,
} from '@features/document/components/use-external-file-drop';
export {
  AgentThreadCardFullscreenExitButton,
  useFullscreenAgentThreadCardInfo,
} from '@features/document/components/document-titlebar-shared';
export {
  captureLatestDocumentContent,
  getDocumentEditorMode,
  setDocumentEditorMode,
  useDocumentEditorMode,
  type DocumentEditorMode,
} from '@features/document/store';
export { navigateDocumentHistory } from '@features/document/use-cases/document-navigation';
export { documentIdentityFromFile } from '@features/document/store/document-identity';
export { documentHistoryEntryKey } from '@features/document/store/document-history-store';
export { localDocumentOperations } from '@features/document/use-cases/local-document-operations';
export {
  type DocumentHistoryEntry,
} from '@features/document/store';

export function useShellDocumentViewModel() {
  return useDocumentStore(useShallow((state) => ({
    currentDocumentPath: state.currentDocumentPath,
    currentDocumentSource: state.currentDocumentSource,
    activeAgentConversationId: state.activeAgentConversationId,
    activeExternalSession: state.activeExternalSession,
    isDocumentTransitioning: state.isDocumentTransitioning,
  })));
}

export function useShellDocumentHistory() {
  return useDocumentHistoryStore(useShallow((state) => ({
    backStack: state.backStack,
    forwardStack: state.forwardStack,
  })));
}
import { useShallow } from 'zustand/react/shallow';
import { useDocumentStore } from '@features/document/store/document-store';
import { useDocumentHistoryStore } from '@features/document/store/document-history-store';
