import { useShallow } from 'zustand/react/shallow';
import { useDocumentStore } from '@features/document/store/document-store';
import { useDocumentHistoryStore } from '@features/document/store/document-history-store';
import { getBuffer } from '../store/buffer-registry';
import type { DocumentIdentity } from '../store/document-identity';
import { captureLatestDocumentContent } from '@features/document/store';

export { resolveDocumentTitlebarTarget } from '../components/document-titlebar-model';
export {
  DOCUMENT_TITLEBAR_ICON_BUTTON_MAC,
  DOCUMENT_TITLEBAR_ICON_BUTTON_MAC_FRAMELESS,
  DOCUMENT_TITLEBAR_ICON_BUTTON_WIN,
  type DocumentTitlebarTarget,
  type DocumentTitlebarProps,
} from '../components/document-titlebar-model';
export { NoteColorPicker } from '../components/document-titlebar-controls';
export { MediaActions } from '../components/document-titlebar-controls';
export { DocumentTitlebarActions as ExternalDocumentActions } from '../components/document-titlebar-actions';
export { useDocumentTitlebarColors } from '../components/use-document-titlebar-colors';
export { DocumentTitlebarWin } from '@features/document/components/document-titlebar-win';
export { DocumentTitlebarMac } from '@features/document/components/document-titlebar-mac';
export { useDocumentCommands } from '@features/document/components/use-document-commands';
export {
  EXTERNAL_FILE_DROP_EVENT,
  type ExternalFileDropDetail,
  useExternalFileDrop,
} from '@features/document/components/use-external-file-drop';
export {
  AgentThreadCardFullscreenExitButton,
  AgentThreadCardFullscreenIdentity,
  AgentThreadCardFullscreenMoreMenu,
  useFullscreenAgentThreadCardInfo,
} from '@features/document/components/agent-thread-card-titlebar';
export {
  captureLatestDocumentContent,
  getDocumentEditorMode,
  setDocumentEditorMode,
  useDocumentEditorMode,
  type DocumentEditorMode,
} from '@features/document/store';
/** Read a host's freshest editor snapshot for path-based titlebar commands. */
export function readLatestDocumentContent(identity: DocumentIdentity, hostId: 'main-third' | 'browser-column'): string {
  captureLatestDocumentContent(identity, hostId);
  return getBuffer(identity)?.content ?? '';
}
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
