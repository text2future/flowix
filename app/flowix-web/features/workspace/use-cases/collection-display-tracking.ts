import { parseCollectionEnvelope } from '@features/collection/model';
import { collections, externalDocuments, type CollectionIndexItem } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { canonicalDirectoryPath } from '@/lib/path';
import { bindCollectionDisplayPath, collectionDisplays, findCollectionDisplayPath } from '@/lib/collection-display-registry';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceRestoreStore } from '../store/workspace-restore-store';
import type { WorkColumnTarget } from '../store/work-column-target';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { subscribeLocalCollectionChanges } from '@features/collection/events';
import { findFileDisplayId } from '@/lib/file-display-registry';
import { replaceWorkspaceDocumentPath } from '@features/document/public/workspace-api';
import { useBrowserColumnStore } from '../store/browser-column-store';

interface CollectionChange { notebookId: string; collectionId?: string; indexSequence?: number; relativePath?: string; kind?: string }
const appliedSequences = new Map<string, number>();
const sequences = new Map<string, number>();
let started = false;

function replaceLiveFilePath(previousPath: string, path: string): void {
  const displayId = findFileDisplayId(previousPath);
  if (displayId) replaceWorkspaceDocumentPath({ kind: 'md', path: previousPath, displayId }, path);
  useWorkColumnStore.getState().replaceExternalPath(previousPath, path);
  useBrowserColumnStore.getState().replaceExternalPath(previousPath, path);
}

export function applyCollectionIndexItem(notebookId: string, item: CollectionIndexItem, sequence?: number, previousPath?: string): void {
  if (!item.collectionId) return;
  const key = JSON.stringify([notebookId, item.collectionId]);
  const incomingSequence = sequence ?? item.indexSequence;
  if (incomingSequence < (appliedSequences.get(key) ?? -1)) return;
  appliedSequences.set(key, incomingSequence);
  const notebook = getWorkspaceMemoState().notebooks.find((candidate) => candidate.id === notebookId)
    ?? (getWorkspaceMemoState().selectedNotebook?.id === notebookId ? getWorkspaceMemoState().selectedNotebook : null);
  if (!notebook) return;
  const root = canonicalDirectoryPath(notebook.path);
  const path = `${root}/${item.relativePath}`;
  const previousPaths = new Set(previousPath ? [previousPath] : []);
  for (const descriptor of collectionDisplays(notebookId, item.collectionId)) {
    const oldPath = findCollectionDisplayPath(descriptor.displayId);
    if (!bindCollectionDisplayPath(descriptor.displayId, path, incomingSequence)) continue;
    if (oldPath && oldPath !== path) previousPaths.add(oldPath);
  }
  for (const oldPath of previousPaths) if (oldPath !== path) replaceLiveFilePath(oldPath, path);
  const browser = useBrowserColumnStore.getState();
  const tabs = browser.tabs.map((tab) => tab.target.kind === 'file-browser' && tab.target.collectionDisplay?.notebookId === notebookId && tab.target.collectionDisplay.collectionId === item.collectionId
    ? { ...tab, title: item.name ?? tab.title, target: { ...tab.target, activeFilePath: path, scopePath: root, collectionUnavailableReason: item.identityConflict ? '集合身份冲突，请先修复副本' : item.parseState !== 'valid' ? '集合文件格式或版本暂不可用' : undefined } } : tab);
  if (tabs.some((tab, index) => tab !== browser.tabs[index])) useBrowserColumnStore.setState({ tabs });
  const update = <T extends WorkColumnTarget | null>(target: T): T => {
    if (target?.kind !== 'collection' || target.notebookId !== notebookId || target.collectionId !== item.collectionId) return target;
    const { unavailableReason: _previousError, ...rest } = target;
    const unavailableReason = item.identityConflict ? '集合身份冲突，请先修复副本' : item.parseState !== 'valid' ? '集合文件格式或版本暂不可用' : undefined;
    return { ...rest, filePath: path, notebookPath: root, name: item.name, ...(unavailableReason ? { unavailableReason } : {}) } as T;
  };
  const state = useWorkColumnStore.getState();
  const navigation = state.navigation;
  if ([navigation.target, navigation.pendingTarget, navigation.previousTarget].some((target) => target?.kind === 'collection' && target.notebookId === notebookId && target.collectionId === item.collectionId)) {
    useWorkColumnStore.setState({ navigation: { ...navigation, target: update(navigation.target), pendingTarget: update(navigation.pendingTarget), previousTarget: update(navigation.previousTarget) } });
  }
  const desired = useWorkspaceRestoreStore.getState().desiredTarget;
  if (desired?.kind === 'collection' && desired.notebookId === notebookId && desired.collectionId === item.collectionId) {
    useWorkspaceRestoreStore.getState().setDesiredTarget(update(desired));
  }
}

function setCollectionUnavailable(notebookId: string, collectionId: string, reason: string, viewId?: string | null): void {
  const matches = (descriptor: { notebookId: string; collectionId: string; viewId: string | null }) => descriptor.notebookId === notebookId && descriptor.collectionId === collectionId && (viewId === undefined || descriptor.viewId === viewId);
  const browser = useBrowserColumnStore.getState();
  const tabs = browser.tabs.map((tab) => tab.target.kind === 'file-browser' && tab.target.collectionDisplay && matches(tab.target.collectionDisplay)
    ? { ...tab, target: { ...tab.target, collectionUnavailableReason: reason } } : tab);
  if (tabs.some((tab, index) => tab !== browser.tabs[index])) useBrowserColumnStore.setState({ tabs });
  const state = useWorkColumnStore.getState();
  const update = (target: WorkColumnTarget | null) => target?.kind === 'collection' && matches(target) ? { ...target, unavailableReason: reason } : target;
  useWorkColumnStore.setState({ navigation: { ...state.navigation, target: update(state.navigation.target)!, pendingTarget: update(state.navigation.pendingTarget), previousTarget: update(state.navigation.previousTarget) } });
  const desired = useWorkspaceRestoreStore.getState().desiredTarget;
  if (desired?.kind === 'collection' && matches(desired)) useWorkspaceRestoreStore.getState().setDesiredTarget({ ...desired, unavailableReason: reason });
}

/** Resolve only affected IDs. Renames never reload the collection list. */
export async function refreshCollectionDisplays(event: CollectionChange): Promise<void> {
  const ids = event.collectionId ? [event.collectionId] : [...new Set(collectionDisplays(event.notebookId).map((display) => display.collectionId))];
  for (const id of ids) {
    const key = JSON.stringify([event.notebookId, id]);
    const generation = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, generation);
    try {
      const item = await collections.resolve(event.notebookId, id);
      if (sequences.get(key) !== generation) return;
      if (item.identityConflict || item.parseState !== 'valid') {
        setCollectionUnavailable(event.notebookId, id, '集合身份冲突或格式暂不可用');
        continue;
      }
      const displays = collectionDisplays(event.notebookId, id);
      let viewIds: Set<string> | null = null;
      if (displays.some((display) => display.viewId)) {
        const notebook = getWorkspaceMemoState().notebooks.find((candidate) => candidate.id === event.notebookId);
        if (notebook) {
          const notebookRoot = canonicalDirectoryPath(notebook.path);
          const envelope = parseCollectionEnvelope(await externalDocuments.read(`${notebookRoot}/${item.relativePath}`, notebookRoot));
          if (envelope.collection.id !== id) throw new Error('COLLECTION_IDENTITY_CHANGED');
          const views = item.collectionType === 'table' ? (envelope.payload.table as { views: Array<{ id: string }> }).views : [envelope.payload.view as { id: string }];
          viewIds = new Set(views.map((view) => view.id));
        }
      }
      if (sequences.get(key) !== generation) return;
      applyCollectionIndexItem(event.notebookId, item);
      for (const display of displays) if (display.viewId && viewIds && !viewIds.has(display.viewId)) setCollectionUnavailable(event.notebookId, id, '此视图已不存在，请重新选择视图', display.viewId);
    } catch (error) {
      if (sequences.get(key) !== generation) return;
      if (/COLLECTION_(NOT_FOUND|IDENTITY_CONFLICT|IDENTITY_CHANGED)/.test(String(error))) setCollectionUnavailable(event.notebookId, id, '集合不存在或身份冲突');
    }
  }
}
export function ensureCollectionDisplayTrackingStarted(): void {
  if (started) return;
  started = true;
  subscribeLocalCollectionChanges((change) => {
    applyCollectionIndexItem(change.notebookId, change.item, change.indexSequence, change.previousPath);
  });
  for (const tab of useBrowserColumnStore.getState().tabs) {
    if (tab.target.kind === 'file-browser' && tab.target.collectionDisplay) void refreshCollectionDisplays({ notebookId: tab.target.collectionDisplay.notebookId });
  }
  subscribe<CollectionChange>('collection-changed', (event) => { void refreshCollectionDisplays(event); });
  subscribe<CollectionChange>('flowix:path-note-changed', (event) => {
    if (event.notebookId && (!event.relativePath || /\.(table|lib)\.ya?ml$/i.test(event.relativePath))) void refreshCollectionDisplays(event);
  });
  subscribe<CollectionChange>('file-management-changed', (event) => { if (event.notebookId) void refreshCollectionDisplays(event); });
}
