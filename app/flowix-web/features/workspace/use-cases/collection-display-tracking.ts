import { updateWorkColumnTargets } from '../store/session-mutations';
import { parseCollectionDocumentV2 } from '@features/collection/model';
import { collections, externalDocuments, notebooks, type CollectionChangedEvent, type CollectionIndexItem } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { canonicalDirectoryPath } from '@/lib/path';
import { bindCollectionDisplayPath, collectionDisplays, findCollectionDisplayPath } from '@/lib/collection-display-registry';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceRestoreStore } from '../store/workspace-restore-store';
import type { WorkColumnTarget } from '../store/work-column-target';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { subscribeLocalCollectionChanges } from '@features/collection/events';
import { findFileDisplayId } from '@/lib/file-display-registry';
import { replaceWorkspaceDocumentPath } from '@features/document/public/workspace-api';
import { getBrowserColumnEntries, useBrowserColumnStore } from '../store/browser-column-store';

interface CollectionChange extends Partial<CollectionChangedEvent> { notebookId: string; kind?: string; changeId?: string }
const appliedSequences = new Map<string, number>();
const sequences = new Map<string, number>();
let started = false;

function replaceLiveFilePath(previousPath: string, path: string): void {
  const displayId = findFileDisplayId(previousPath);
  if (displayId && !replaceWorkspaceDocumentPath({ kind: 'md', path: previousPath, displayId }, path)) return;
  useWorkColumnStore.getState().replaceExternalPath(previousPath, path);
  useBrowserColumnStore.getState().replaceExternalPath(previousPath, path);
}

async function resolveNotebookPath(notebookId: string): Promise<string | null> {
  const memo = getWorkspaceMemoState();
  const notebook = memo.notebooks.find((candidate) => candidate.id === notebookId)
    ?? (memo.selectedNotebook?.id === notebookId ? memo.selectedNotebook : null)
    ?? (await notebooks.getAll()).find((candidate) => candidate.id === notebookId);
  return notebook?.path ?? null;
}

function applyCollectionIndexItemAtRoot(
  notebookId: string,
  item: CollectionIndexItem,
  rootPath: string,
  sequence?: number,
  previousPath?: string,
): void {
  if (!item.collectionId) return;
  const key = JSON.stringify([notebookId, item.collectionId]);
  const incomingSequence = sequence ?? item.indexSequence;
  if (incomingSequence < (appliedSequences.get(key) ?? -1)) return;
  appliedSequences.set(key, incomingSequence);
  const root = canonicalDirectoryPath(rootPath);
  const path = `${root}/${item.relativePath}`;
  const previousPaths = new Set(previousPath ? [previousPath] : []);
  for (const descriptor of collectionDisplays(notebookId, item.collectionId)) {
    const oldPath = findCollectionDisplayPath(descriptor.displayId);
    if (!bindCollectionDisplayPath(descriptor.displayId, path, incomingSequence)) continue;
    if (oldPath && oldPath !== path) previousPaths.add(oldPath);
  }
  for (const oldPath of previousPaths) if (oldPath !== path) replaceLiveFilePath(oldPath, path);
  const browser = useBrowserColumnStore.getState();
  browser.updateEntries((tab) => tab.target.kind === 'file-browser' && tab.target.collectionDisplay?.notebookId === notebookId && tab.target.collectionDisplay.collectionId === item.collectionId
    ? { ...tab, title: item.name ?? tab.title, target: { ...tab.target, activeFilePath: path, scopePath: root, collectionType: item.collectionType, collectionUnavailableReason: item.identityConflict ? '集合身份冲突，请先修复副本' : item.parseState !== 'valid' ? '集合文件格式或版本暂不可用' : undefined } } : tab.target.kind === 'collection' && tab.target.notebookId === notebookId && tab.target.collectionId === item.collectionId
    ? { ...tab, title: item.name ?? tab.title, target: { ...tab.target, filePath: path, notebookPath: root, name: item.name ?? tab.target.name, unavailableReason: item.identityConflict ? '集合身份冲突，请先修复副本' : item.parseState !== 'valid' ? '集合文件格式或版本暂不可用' : undefined } } : tab);
  const update = <T extends WorkColumnTarget | null>(target: T): T => {
    if (target?.kind !== 'collection' || target.notebookId !== notebookId || target.collectionId !== item.collectionId) return target;
    const { unavailableReason: _previousError, ...rest } = target;
    const unavailableReason = item.identityConflict ? '集合身份冲突，请先修复副本' : item.parseState !== 'valid' ? '集合文件格式或版本暂不可用' : undefined;
    return { ...rest, filePath: path, notebookPath: root, name: item.name, ...(unavailableReason ? { unavailableReason } : {}) } as T;
  };
  const state = useWorkColumnStore.getState();
  const navigation = state.navigation;
  if ([navigation.target, navigation.pendingTarget, navigation.previousTarget].some((target) => target?.kind === 'collection' && target.notebookId === notebookId && target.collectionId === item.collectionId)) {
    updateWorkColumnTargets(update);
  }
  const desired = useWorkspaceRestoreStore.getState().desiredTarget;
  if (desired?.kind === 'collection' && desired.notebookId === notebookId && desired.collectionId === item.collectionId) {
    useWorkspaceRestoreStore.getState().setDesiredTarget(update(desired));
  }
}

export function applyCollectionIndexItem(notebookId: string, item: CollectionIndexItem, sequence?: number, previousPath?: string): void {
  const memo = getWorkspaceMemoState();
  const notebook = memo.notebooks.find((candidate) => candidate.id === notebookId)
    ?? (memo.selectedNotebook?.id === notebookId ? memo.selectedNotebook : null);
  if (!notebook) return;
  applyCollectionIndexItemAtRoot(notebookId, item, notebook.path, sequence, previousPath);
}

function setCollectionUnavailable(notebookId: string, collectionId: string, reason: string, viewId?: string | null): void {
  const matches = (descriptor: { notebookId: string; collectionId: string; viewId: string | null }) => descriptor.notebookId === notebookId && descriptor.collectionId === collectionId && (viewId === undefined || descriptor.viewId === viewId);
  const browser = useBrowserColumnStore.getState();
  browser.updateEntries((tab) => tab.target.kind === 'file-browser' && tab.target.collectionDisplay && matches(tab.target.collectionDisplay)
    ? { ...tab, target: { ...tab.target, collectionUnavailableReason: reason } } : tab.target.kind === 'collection' && matches(tab.target)
      ? { ...tab, target: { ...tab.target, unavailableReason: reason } } : tab);
  const update = (target: WorkColumnTarget | null) => target?.kind === 'collection' && matches(target) ? { ...target, unavailableReason: reason } : target;
  updateWorkColumnTargets((target) => update(target)!);
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
      // Selected views belong to live targets, not the shared display identity.
      const navigation = useWorkColumnStore.getState().navigation;
      const selections = [navigation.target, navigation.pendingTarget, useWorkspaceRestoreStore.getState().desiredTarget,
        ...getBrowserColumnEntries(useBrowserColumnStore.getState()).map((tab) => tab.target.kind === 'file-browser' ? tab.target.collectionDisplay : null)]
        .filter((target): target is NonNullable<typeof target> & { notebookId: string; collectionId: string; viewId: string | null } =>
          Boolean(target && 'collectionId' in target && target.notebookId === event.notebookId && target.collectionId === id));
      // Memo may not have loaded its notebook list yet during startup.
      const notebookPath = await resolveNotebookPath(event.notebookId);
      if (!notebookPath) continue;
      const notebookRoot = canonicalDirectoryPath(notebookPath);
      let viewIds: Set<string> | null = null;
      if (selections.some((selection) => selection.viewId)) {
        const envelope = parseCollectionDocumentV2(await externalDocuments.read(`${notebookRoot}/${item.relativePath}`, notebookRoot));
        if (envelope.collection.id !== id) throw new Error('COLLECTION_IDENTITY_CHANGED');
        const views = envelope.payload.views.items as Array<{ id: string }>;
        viewIds = new Set(views.map((view) => view.id));
      }
      if (sequences.get(key) !== generation) return;
      applyCollectionIndexItemAtRoot(event.notebookId, item, notebookPath);
      for (const selection of selections) if (item.collectionType !== 'table' && selection.viewId && viewIds && !viewIds.has(selection.viewId)) setCollectionUnavailable(event.notebookId, id, '此视图已不存在，请重新选择视图', selection.viewId);
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
  for (const tab of getBrowserColumnEntries(useBrowserColumnStore.getState())) {
    if (tab.target.kind === 'file-browser' && tab.target.collectionDisplay) {
      const display = tab.target.collectionDisplay;
      void refreshCollectionDisplays({ notebookId: display.notebookId, collectionId: display.collectionId });
    }
  }
  subscribe<CollectionChangedEvent>('collection-changed', (event) => {
    void refreshCollectionDisplays(event.directoryMove ? { notebookId: event.notebookId } : event);
  });
  subscribeNotebookChanges((event) => {
    const collectionMutation = event.changeId?.startsWith(`collection:${event.notebookId}:`);
    if (!collectionMutation && (!event.relativePath || (event.kind === 'path-moved' && event.directory) || /(?:\.(table|lib)\.ya?ml|\.index\.yaml)$/i.test(event.relativePath))) {
      void refreshCollectionDisplays({ notebookId: event.notebookId });
    }
  });
  subscribe<CollectionChange>('file-management-changed', (event) => {
    if (event.notebookId && !event.operationId) void refreshCollectionDisplays(event);
  });
}
