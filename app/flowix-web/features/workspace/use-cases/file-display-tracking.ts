import { reconcileCollectionDisplays, type CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { getWorkspaceDocumentHistory, subscribeWorkspaceDocumentHistory } from '@features/document/public/workspace-api';
import { useWorkspaceRestoreStore } from '../store/workspace-restore-store';
import { ensureCollectionDisplayTrackingStarted } from './collection-display-tracking';
import { reconcileFileDisplays } from '@/lib/file-display-registry';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { getWorkspaceDocumentPaths, subscribeWorkspaceDocumentPaths } from '@features/document/public/workspace-api';

/** Keep one runtime identity while an open document session or surface owns a local file. */
function startFileDisplayTracking(): () => void {
  const synchronize = () => {
    const files = new Map<string, { path: string }>();
    const addFile = (path: string | null | undefined) => {
      if (!path) return;
      files.set(path, { path });
    };
    const navigation = useWorkColumnStore.getState().navigation;
    const workTargets = [
      navigation.target,
      navigation.phase === 'loading' ? navigation.pendingTarget : null,
    ];
    for (const target of workTargets) {
      if (target?.kind === 'external') addFile(target.path);
      if (target?.kind === 'table') addFile(target.filePath);
      if (target?.kind === 'media-library') addFile(target.filePath);
      if (target?.kind === 'media') addFile(target.filePath);
    }
    for (const tab of useBrowserColumnStore.getState().tabs) {
      if (tab.target.kind === 'media') addFile(tab.target.filePath);
      if (tab.target.kind === 'file-browser' && tab.target.activeFilePath) {
        addFile(tab.target.activeFilePath);
      }
    }
    for (const path of getWorkspaceDocumentPaths()) addFile(path);
    reconcileFileDisplays(files.values());
    const retained: CollectionDisplayDescriptor[] = [];
    for (const target of [...workTargets, navigation.previousTarget, useWorkspaceRestoreStore.getState().desiredTarget,
      ...getWorkspaceDocumentHistory()]) {
      if (target?.kind === 'collection') retained.push(target);
    }
    for (const tab of useBrowserColumnStore.getState().tabs) {
      if (tab.target.kind === 'file-browser' && tab.target.collectionDisplay) retained.push(tab.target.collectionDisplay);
    }
    reconcileCollectionDisplays(retained);
  };

  const unsubscribeWorkColumn = useWorkColumnStore.subscribe(synchronize);
  const unsubscribeBrowserColumn = useBrowserColumnStore.subscribe(synchronize);
  const unsubscribeHistory = subscribeWorkspaceDocumentHistory(synchronize);
  const unsubscribeRestore = useWorkspaceRestoreStore.subscribe(synchronize);
  const unsubscribeDocument = subscribeWorkspaceDocumentPaths(synchronize);
  synchronize();

  return () => {
    unsubscribeWorkColumn();
    unsubscribeBrowserColumn();
    unsubscribeDocument();
    unsubscribeHistory();
    unsubscribeRestore();
  };
}

let stopGlobalTracking: (() => void) | null = null;

/** Initialize before the first surface render; persisted browser tabs are already hydrated then. */
export function ensureFileDisplayTrackingStarted(): void {
  ensureCollectionDisplayTrackingStarted();
  if (!stopGlobalTracking) stopGlobalTracking = startFileDisplayTracking();
}
