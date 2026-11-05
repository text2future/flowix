import { useColumnNavigation, useColumnTarget } from '@features/workspace/store/column-navigation';

export {
  clearPluginWorkbenchTarget,
  closeAgentTarget,
  dismissNavigationFailure,
  prepareActiveWorkColumnDocumentLeave,
  openFolderCollection,
  openFolderCollectionFromFolder,
  reconcileDeletedNotebook,
  retryLastNavigation,
  selectNotebook,
} from '@features/workspace/use-cases/workspace-navigation';

/** Notes own column 1; the id is the only thing that identifies it. */
export function useWorkspaceNavigationPhase() {
  return useColumnNavigation('column-1', (navigation) => navigation.transaction.phase);
}

export function useWorkspaceNavigationFailure() {
  return useColumnNavigation('column-1', (navigation) => (
    navigation.transaction.phase === 'failed' ? navigation.transaction.failure : null
  ));
}

export function useWorkspaceTargetKind() {
  return useColumnTarget('column-1').kind;
}
