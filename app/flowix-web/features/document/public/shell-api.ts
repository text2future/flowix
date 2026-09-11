export { DocumentTitlebarWin } from '@features/document/components/document-titlebar-win';
export { DocumentTitlebarMac } from '@features/document/components/document-titlebar-mac';
export { useDocumentCommands } from '@features/document/components/use-document-commands';
export {
  markdownPaths,
  useMarkdownFileDrop,
} from '@features/document/components/use-markdown-file-drop';
export {
  AgentThreadCardFullscreenExitButton,
  useFullscreenAgentThreadCardInfo,
} from '@features/document/components/document-titlebar-shared';
export { navigateDocumentHistory } from '@features/document/use-cases/document-navigation';
export {
  type DocumentHistoryEntry,
  type MemoDocumentSession,
} from '@features/document/store';

export function useShellDocumentViewModel() {
  return useDocumentStore(useShallow((state) => ({
    currentDocumentPath: state.currentDocumentPath,
    currentDocumentSource: state.currentDocumentSource,
    activeAgentConversationId: state.activeAgentConversationId,
    activeMemoSession: state.activeMemoSession,
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
