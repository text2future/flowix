import { useCallback } from 'react';
import { toast } from '@/lib/toast';
import { useShallow } from 'zustand/react/shallow';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
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
export function getVisibleWorkspaceSurfaceHosts(): ('main-third' | 'browser-column')[] {
  const hosts: ('main-third' | 'browser-column')[] = ['main-third'];
  const browser = useBrowserColumnStore.getState();
  if (browser.visible && browser.current) hosts.push('browser-column');
  return hosts;
}

export function getWorkspaceNavigationRevision(): number {
  return useWorkColumnStore.getState().navigation.requestId;
}

export function getWorkColumnStartupIdentity(): string {
  return JSON.stringify(useWorkColumnStore.getState().navigation.target);
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
    focusWorkspaceHost: state.focusHost,
    focusedHostId: state.focusedHostId,
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
    return openWorkspaceSurface({ host: 'browser-column', target }).catch((error: unknown) => {
      toast.error('无法在右栏打开', { description: error instanceof Error ? error.message : String(error) });
      return null;
    });
  }, [target]);
  return { canOpenInBrowserColumn, openInBrowserColumn };
}
