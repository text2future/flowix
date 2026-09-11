import { useWorkColumnStore } from '@features/workspace/store/work-column-store';

export {
  clearPluginWorkbenchTarget,
  dismissNavigationFailure,
  flushWorkspaceDocument,
  openPluginWorkbench,
  reconcileDeletedNotebook,
  retryLastNavigation,
  selectNotebook,
} from '@features/workspace/use-cases/workspace-navigation';

export function useWorkspaceNavigationPhase() {
  return useWorkColumnStore((state) => state.navigation.phase);
}

export function useWorkspaceNavigationFailure() {
  return useWorkColumnStore((state) => (
    state.navigation.phase === 'failed' ? state.navigation.failure : null
  ));
}

export function useWorkspaceTargetKind() {
  return useWorkColumnStore((state) => state.navigation.target.kind);
}
