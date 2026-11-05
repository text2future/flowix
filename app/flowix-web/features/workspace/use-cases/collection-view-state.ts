import { updateWorkColumnTargets } from '../store/session-mutations';
import { ensureCollectionDisplay, type CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceRestoreStore } from '../store/workspace-restore-store';
import { useBrowserColumnStore } from '../store/browser-column-store';

/** Update presentation state in place. Never start navigation or reload data. */
export function setCollectionActiveView(
  location: { host: 'column-1' } | { host: 'column-2'; surfaceId: string },
  expected: Pick<CollectionDisplayDescriptor, 'notebookId' | 'collectionId'>,
  viewId: string | null,
): boolean {
  const matches = (target: Pick<CollectionDisplayDescriptor, 'notebookId' | 'collectionId'>) =>
    target.notebookId === expected.notebookId && target.collectionId === expected.collectionId;
  if (location.host === 'column-1') {
    const state = useWorkColumnStore.getState();
    const target = state.navigation.target;
    if (state.navigation.phase === 'loading' || target.kind !== 'collection' || !matches(target)) return false;
    if (target.unavailableReason && target.unavailableReason !== '此视图已不存在，请重新选择视图') return false;
    if (target.viewId === viewId) return true;
    ensureCollectionDisplay({ ...target, viewId }, target.displayId);
    const { unavailableReason: _reason, ...rest } = target;
    const next = { ...rest, viewId };
    updateWorkColumnTargets((current) => current === target ? next : current);
    useWorkspaceRestoreStore.getState().setDesiredTarget(next);
    return true;
  }
  const state = useBrowserColumnStore.getState();
  const entry = (state.current?.id === location.surfaceId ? state.current : null);
  if (entry?.target.kind !== 'file-browser' || !entry.target.collectionDisplay || !matches(entry.target.collectionDisplay)) return false;
  if (entry.target.collectionUnavailableReason && entry.target.collectionUnavailableReason !== '此视图已不存在，请重新选择视图') return false;
  if (entry.target.collectionDisplay.viewId === viewId) return true;
  ensureCollectionDisplay({ ...entry.target.collectionDisplay, viewId }, entry.target.collectionDisplay.displayId);
  const target = entry.target;
  state.updateFileBrowserContext(entry.id, {
    collectionDisplay: { ...target.collectionDisplay!, viewId }, collectionUnavailableReason: undefined,
  });
  return true;
}
