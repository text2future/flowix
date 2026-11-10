import { useShallow } from 'zustand/react/shallow';
import { preloadDocumentEditor } from '../components/lazy-document-editor';
import { useDocumentStore } from '@features/document/store/document-store';
import { useDocumentHistoryStore } from '@features/document/store/document-history-store';

export { resolveDocumentTitlebarTarget } from '../components/document-titlebar-model';
export {
  type DocumentTitlebarTarget,
  type DocumentTitlebarProps,
} from '../components/document-titlebar-model';
export { NoteColorPicker } from '../components/document-titlebar-controls';
export { MediaActions } from '../components/document-titlebar-controls';
export { ExternalTitlebarBadge, SurfaceHeaderIcon } from '../components/document-titlebar-controls';
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
export { readLatestDocumentContent } from './header-api';
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

/**
 * Warm the Markdown editor chunk while the workspace is idle.
 *
 * The editor module is the heaviest lazy chunk in the desktop window — TipTap,
 * ProseMirror, Shiki and the Phosphor icon barrel — and it is imported nowhere
 * in the startup graph on purpose (see the note in `main-window-effects.tsx`
 * about keeping Node views out of the shell). The first document open in a
 * session therefore pays for the whole download + compile *inside* the open:
 * measured 1.7 s in `vite dev` (195 module requests, 14 MB) on top of the
 * ~200 ms the editor itself needs.
 *
 * Startup stage 3 runs after the first workbench paint, which moves that cost
 * to a moment when the user is looking at the workspace instead of waiting for
 * a note. Idle scheduling keeps it out of the shell's critical path; the
 * timeout guarantees it still happens on a busy window.
 */
export function preloadEditorChunkOnIdle(): void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number },
    ) => number;
  };

  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(() => preloadDocumentEditor('preload'), { timeout: 2000 });
    return;
  }

  window.setTimeout(() => preloadDocumentEditor('preload'), 200);
}
