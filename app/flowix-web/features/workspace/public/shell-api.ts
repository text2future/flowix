import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { useCallback } from 'react';
import { toast } from '@/lib/toast';
import { useShallow } from 'zustand/react/shallow';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { columnRequestId, columnTarget } from '@features/workspace/store/column-navigation';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { openWorkspaceSurface } from './open-surface-api';

export { selectNotebook } from '@features/workspace/use-cases/workspace-navigation';
export {
  clearWorkspaceTargetForDeletedFile,
  clearWorkspaceTargetsForDeletedDirectory,
  historyEntryFromWorkColumnTarget,
} from '@features/workspace/use-cases/workspace-navigation';
export { openWorkspaceSurface } from './open-surface-api';
export type { OpenWorkspaceSurfaceRequest } from './open-surface-api';
export { deleteMainExternalDocument } from '@features/workspace/use-cases/delete-main-external-document';
export { renameWorkspaceFile } from '../use-cases/rename-workspace-file';

export function clearBrowserColumnExternalPath(path: string): void {
  useBrowserColumnStore.getState().clearExternalPath(path);
}

export {
  BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
  BROWSER_COLUMN_MIN_WIDTH,
} from '@features/workspace/store/browser-column-store';
export type { WorkColumnTarget } from '@features/workspace/store/work-column-target';

/** Hosts with content visible in the current workspace layout. */
export function getVisibleWorkspaceColumnIds(): ('column-1' | 'column-2')[] {
  const state = useWorkspaceSessionStore.getState();
  return state.browserLayout.visible ? [state.placement[0], state.placement[1]] : [state.placement[0]];
}

export function getWorkspaceNavigationRevision(): number {
  return columnRequestId('column-1');
}

export function getWorkColumnStartupIdentity(): string {
  return JSON.stringify(columnTarget('column-1'));
}

export function useShellWorkspaceViewModel() {
  const { navigation, notebookSwitchesInFlight } = useWorkColumnStore(useShallow((state) => ({
    navigation: state.navigation,
    notebookSwitchesInFlight: state.notebookSwitchesInFlight,
  })));
  const browser = useBrowserColumnStore(useShallow((state) => ({
    browserColumnVisible: state.visible,
    browserColumnSplitRatio: state.splitRatio,
    setBrowserColumnSplitRatio: state.setSplitRatio,
  })));
  const focus = useWorkspaceFocusStore(useShallow((state) => ({
    focusWorkspaceColumn: state.focusColumn,
    focusedColumnId: state.focusedColumnId,
  })));
  return {
    navigation,
    notebookSwitching: notebookSwitchesInFlight > 0,
    ...browser,
    ...focus,
  };
}

export function useWorkColumnTransferViewModel() {
  const target = useWorkColumnStore((state) => state.navigation.target);
  const canOpenInBrowserColumn = target.kind !== 'empty'
    && target.kind !== 'plugin-workbench';
  const openInBrowserColumn = useCallback(() => {
    if (target.kind === 'empty' || target.kind === 'plugin-workbench') {
      return Promise.resolve(null);
    }
    return openWorkspaceSurface({ index: 1, target }).catch((error: unknown) => {
      toast.error('无法在右栏打开', { description: error instanceof Error ? error.message : String(error) });
      return null;
    });
  }, [target]);
  return { canOpenInBrowserColumn, openInBrowserColumn };
}
