import { SESSION_HISTORY_LIMIT } from '../model/session-limits';
import { sessionFor } from '../model/workspace-session';
import { toBrowserEntry } from './session-legacy-projections';
import { mapSessionEntries } from './session-mutations';
import type { SessionNavigationEntry } from '../model/session-navigation';
import { emptySessionTransaction } from '../model/session-navigation';
import type { WorkspaceSurfaceOpenTarget } from '../model/surface-target';
import { useWorkspaceSessionStore } from './workspace-session-store';
import { resolveWorkspaceFileSurfaceKind, workspaceSurfaceSupportsHost } from '../surface-registry';
import { createWorkspaceWebRuntime, navigateWorkspaceWebRuntime, moveWorkspaceWebHistory, reloadWorkspaceWebRuntime } from '../model/web-navigation';
import type { FileBrowserTarget } from './file-browser-target';
import { createBrowserColumnView } from './session-read-models';
import { canonicalPath, canonicalDirectoryPath, isPathInDirectory, parentDirectoryPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { canonicalUrl } from '../model/surface-identity';
import { useWorkspaceFocusStore } from './workspace-focus-store';
import { BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, clampFileTreeWidth, clampSplitRatio } from '../model/browser-column-layout';
import { browserColumnTargetKey, type BrowserColumnTarget } from '../model/browser-column-target';
import type { BrowserColumnEntry, BrowserColumnSessionState } from '../model/browser-column-session';
import type { WorkspaceWebRuntime as BrowserColumnWebRuntime } from '../model/surface-contract';

export { BROWSER_COLUMN_MIN_WIDTH, BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH,
  BROWSER_COLUMN_FILE_TREE_MIN_WIDTH, BROWSER_COLUMN_FILE_TREE_MAX_WIDTH } from '../model/browser-column-layout';

export type { BrowserColumnTarget } from '../model/browser-column-target';
export { browserColumnTargetIdentity, browserColumnTargetKey } from '../model/browser-column-target';

/** Opening in Work uses the same public support declaration as normal navigation. */
export function canOpenBrowserColumnTargetInWorkColumn(target: BrowserColumnTarget): boolean {
  if (target.kind === 'file-browser') {
    if (!target.activeFilePath) return workspaceSurfaceSupportsHost('file-browser', 'column-1');
    const fileKind = target.collectionType === 'table' ? 'table'
      : target.collectionType === 'media_library' ? 'media-library'
      : target.collectionType === 'work_documents' ? 'work-documents'
      : resolveWorkspaceFileSurfaceKind(target.activeFilePath);
    return workspaceSurfaceSupportsHost(`file-${fileKind}`, 'column-1');
  }
  return workspaceSurfaceSupportsHost(target.kind === 'agent_conversation' ? 'agent-conversation'
    : target.kind === 'folder-collection' ? 'collection' : target.kind, 'column-1');
}

export type { BrowserColumnEntry } from '../model/browser-column-session';
export type { WorkspaceWebRuntime as BrowserColumnWebRuntime } from '../model/surface-contract';

interface BrowserColumnState extends BrowserColumnSessionState {
  webRuntime: BrowserColumnWebRuntime | null;
  updateEntries: (transform: (entry: SessionNavigationEntry) => SessionNavigationEntry | null) => void;
  setVisible: (visible: boolean) => void;
  setSplitRatio: (ratio: number) => void;
  openContent: (entry: BrowserColumnEntry, options?: { history?: 'push' | 'skip' }) => string;
  focusContent: (surfaceId: string) => void;
  clearContent: () => void;
  clearMissingConversation: (instanceId: string) => boolean;
  clearSession: () => void;
  restoreHistoryEntry: (entry: BrowserColumnEntry, direction: 'back' | 'forward') => void;
  updateFileBrowserContext: (surfaceId: string, patch: Partial<Omit<FileBrowserTarget, 'kind'>>) => void;
  selectFileBrowserFile: (surfaceId: string, path: string | null, display?: FileBrowserTarget['collectionDisplay'], type?: FileBrowserTarget['collectionType'], reason?: string) => void;
  setFileBrowserTreeVisible: (surfaceId: string, visible: boolean) => void;
  setFileBrowserTreeWidth: (surfaceId: string, width: number) => void;
  replaceExternalPath: (previousPath: string, path: string) => void;
  clearExternalPath: (path: string) => void;
  clearTargetsUnderDirectory: (path: string) => void;
  removeContentByFilePath: (path: string) => string[];
  updateContentMetadata: (surfaceId: string, metadata: Partial<Pick<BrowserColumnEntry, 'title' | 'icon'>>) => void;
  setWebRuntime: (surfaceId: string, runtime: BrowserColumnWebRuntime) => void;
  navigateWeb: (surfaceId: string, url: string) => boolean;
  goBackWeb: (surfaceId: string) => boolean;
  goForwardWeb: (surfaceId: string) => boolean;
  reloadWeb: (surfaceId: string) => boolean;
  reset: () => void;
}

function targetPaths(target: WorkspaceSurfaceOpenTarget): string[] {
  switch (target.kind) {
    case 'file-browser': return [target.activeFilePath, target.folderPath].filter((path): path is string => !!path);
    case 'external': return [target.path];
    case 'media': case 'table': case 'media-library': case 'collection': return [target.filePath];
    case 'folder-collection': return [target.folderPath];
    default: return [];
  }
}
function usesPath(entry: SessionNavigationEntry, path: string): boolean {
  return targetPaths(entry.target).some((candidate) => canonicalPath(candidate) === path);
}
function releaseBrowserFocus(): void {
  const focus = useWorkspaceFocusStore.getState();
  const left = useWorkspaceSessionStore.getState().placement[0];
  if (focus.focusedColumnId !== left) focus.focusColumn(left);
}
export function getBrowserColumnEntries(state: BrowserColumnSessionState): BrowserColumnEntry[] {
  return [...(state.current ? [state.current] : []), ...state.backStack, ...state.forwardStack];
}
function session() { return sessionFor(useWorkspaceSessionStore.getState(), 'column-2'); }
function updateEntries(transform: (entry: SessionNavigationEntry) => SessionNavigationEntry | null) {
  const before = session().navigation.current;
  mapSessionEntries(session().id, transform);
  if (before && !session().navigation.current) {
    if (useWorkspaceSessionStore.getState().placement[1] === 'column-2') useWorkspaceSessionStore.getState().setBrowserLayout({ visible: false });
    releaseBrowserFocus();
  }
}
function updateContext(surfaceId: string, patch: Partial<Omit<FileBrowserTarget, 'kind'>>) {
  useWorkspaceSessionStore.getState().updateSession(session().id, (currentSession) => {
    const entry = currentSession.navigation.current;
    if (entry?.id !== surfaceId) return currentSession;
    let target = entry.target;
    if (target.kind === 'file-browser') target = { ...target, ...patch };
    else if (target.kind === 'external') {
      const view = toBrowserEntry(entry).target;
      if (view.kind !== 'file-browser') return currentSession;
      const context = { ...view, ...patch };
      target = { ...target, scopePath: context.scopePath, fileBrowser: {
        folderPath: context.folderPath, notebookId: context.notebookId, scopePath: context.scopePath,
        fileTreeVisible: context.fileTreeVisible, fileTreeWidth: context.fileTreeWidth,
        restoreNotebookContext: context.restoreNotebookContext, notebookContextPath: context.notebookContextPath,
      } };
    } else if (target.kind === 'collection') {
      target = { ...target, ...(patch.collectionDisplay ? { viewId: patch.collectionDisplay.viewId } : {}),
        ...('collectionUnavailableReason' in patch ? { unavailableReason: patch.collectionUnavailableReason } : {}) };
    } else return currentSession;
    return { ...currentSession, navigation: { ...currentSession.navigation, current: { ...entry, target } } };
  });
}
function changeWeb(id: string, change: (runtime: BrowserColumnWebRuntime) => BrowserColumnWebRuntime | null): boolean {
  const owner = session();
  const entry = owner.navigation.current;
  if (entry?.id !== id || entry.target.kind !== 'web') return false;
  const runtime = change(owner.viewStates[id]?.webRuntime ?? createWorkspaceWebRuntime(entry.target.url));
  if (!runtime) return false;
  useWorkspaceSessionStore.getState().updateSession(owner.id, (current) => ({ ...current,
    navigation: { ...current.navigation, current: { ...entry, target: { kind: 'web', url: runtime.currentUrl } } },
    viewStates: { ...current.viewStates, [id]: { ...current.viewStates[id], webRuntime: runtime } },
  }));
  return true;
}
function clearSession(history: boolean) {
  useWorkspaceSessionStore.getState().updateSession(session().id, (current) => ({ ...current,
    navigation: { ...current.navigation, current: null,
      backStack: history ? [] : current.navigation.backStack,
      forwardStack: history ? [] : current.navigation.forwardStack,
      transaction: { ...emptySessionTransaction(), requestId: current.navigation.transaction.requestId + 1 } },
  }));
  if (useWorkspaceSessionStore.getState().placement[1] === 'column-2') useWorkspaceSessionStore.getState().setBrowserLayout({ visible: false });
  releaseBrowserFocus();
}
function emptyFileBrowser(entry: SessionNavigationEntry, folderPath?: string | null): SessionNavigationEntry | null {
  const view = toBrowserEntry(entry).target;
  if (view.kind !== 'file-browser') return null;
  const folder = folderPath === undefined ? view.folderPath : folderPath;
  return { ...entry, title: displayTitleFromFilename(folder?.split(/[\\/]/).filter(Boolean).pop() ?? ''),
    target: { ...view, folderPath: folder, activeFilePath: null,
      collectionDisplay: undefined, collectionType: undefined, collectionUnavailableReason: undefined } };
}

export const useBrowserColumnStore = createBrowserColumnView<BrowserColumnState>({
  visible: false, splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
  current: null, backStack: [], forwardStack: [], webRuntime: null,
  updateEntries,
  setVisible: (visible) => {
    if (visible) useWorkspaceFocusStore.getState().focusColumn(useWorkspaceSessionStore.getState().placement[1]); else releaseBrowserFocus();
    useWorkspaceSessionStore.getState().setBrowserLayout({ visible });
  },
  setSplitRatio: (ratio) => useWorkspaceSessionStore.getState().setBrowserLayout({ splitRatio: clampSplitRatio(ratio) }),
  openContent: (incoming, options) => {
    const state = useBrowserColumnStore.getState();
    const current = state.current;
    const same = current && browserColumnTargetKey(current.target) === browserColumnTargetKey(incoming.target);
    const input = same && current.target.kind === 'file-browser' && incoming.target.kind === 'file-browser'
      ? { ...incoming.target, fileTreeVisible: current.target.fileTreeVisible, fileTreeWidth: current.target.fileTreeWidth }
      : incoming.target;
    const occupied = [current, ...state.backStack, ...state.forwardStack].some((entry) => entry?.id === incoming.id);
    const id = same ? current.id : options?.history === 'skip' ? incoming.id : occupied ? `browser:${crypto.randomUUID()}` : incoming.id;
    // Only the explicit open request accepts the old agent discriminant.
    const target = input.kind === 'agent_conversation' ? { kind: 'agent-conversation' as const, instanceId: input.instanceId } : input;
    useWorkspaceSessionStore.getState().commitTarget(session().id, target, {
      entryId: id, title: incoming.title, icon: incoming.icon, history: options?.history ?? 'push',
    });
    if (useWorkspaceSessionStore.getState().placement[1] === 'column-2') useWorkspaceSessionStore.getState().setBrowserLayout({ visible: true });
    useWorkspaceFocusStore.getState().focusColumn('column-2');
    return session().navigation.current!.id;
  },
  focusContent: (id) => {
    if (session().navigation.current?.id !== id) return;
    if (useWorkspaceSessionStore.getState().placement[1] === 'column-2') useWorkspaceSessionStore.getState().setBrowserLayout({ visible: true });
    useWorkspaceFocusStore.getState().focusColumn('column-2');
  },
  clearContent: () => clearSession(false),
  clearMissingConversation: (instanceId) => {
    const owner = session();
    const current = owner.navigation.current;
    if (current?.target.kind !== 'agent-conversation' || current.target.instanceId !== instanceId) return false;
    useWorkspaceSessionStore.getState().updateSession(owner.id, (state) => ({ ...state,
      navigation: { ...state.navigation, current: null,
        transaction: { ...emptySessionTransaction(), requestId: state.navigation.transaction.requestId + 1 } },
    }));
    return true;
  },
  clearSession: () => clearSession(true),
  restoreHistoryEntry: (entry, direction) => {
    useWorkspaceSessionStore.getState().updateSession(session().id, (current) => {
      const navigation = current.navigation;
      const retained = [...navigation.backStack, ...navigation.forwardStack].find((item) => item.id === entry.id);
      if (!retained || retained.target.kind === 'collection-reference') return current;
      const append = (stack: SessionNavigationEntry[]) => navigation.current ? [...stack, navigation.current].slice(-SESSION_HISTORY_LIMIT) : stack;
      return { ...current, navigation: { current: retained as typeof navigation.current,
        backStack: direction === 'back' ? navigation.backStack.slice(0, -1) : append(navigation.backStack),
        forwardStack: direction === 'forward' ? navigation.forwardStack.slice(0, -1) : append(navigation.forwardStack),
        transaction: { ...emptySessionTransaction(), phase: 'committed', requestId: navigation.transaction.requestId + 1 } } };
    });
    if (useWorkspaceSessionStore.getState().placement[1] === 'column-2') useWorkspaceSessionStore.getState().setBrowserLayout({ visible: true });
    useWorkspaceFocusStore.getState().focusColumn('column-2');
  },
  updateFileBrowserContext: updateContext,
  setFileBrowserTreeVisible: (id, visible) => updateContext(id, { fileTreeVisible: visible }),
  setFileBrowserTreeWidth: (id, width) => updateContext(id, { fileTreeWidth: clampFileTreeWidth(width) }),
  selectFileBrowserFile: (id, path, display, type, reason) => {
    const entry = useBrowserColumnStore.getState().current;
    if (entry?.id !== id || entry.target.kind !== 'file-browser') return;
    const name = (path ?? entry.target.folderPath)?.split(/[\\/]/).filter(Boolean).pop() ?? '';
    useBrowserColumnStore.getState().openContent({ ...entry, title: displayTitleFromFilename(name), target: { ...entry.target,
      activeFilePath: path, collectionDisplay: display, collectionType: type, collectionUnavailableReason: reason } });
  },
  replaceExternalPath: (previousPath, path) => {
    const previous = canonicalPath(previousPath), next = canonicalPath(path);
    const previousParent = previous.replace(/\/[^/]*$/, ''), nextParent = next.replace(/\/[^/]*$/, '');
    updateEntries((entry) => {
      const target = entry.target;
      if (target.kind === 'external' && canonicalPath(target.path) === previous) return { ...entry,
        title: displayTitleFromFilename(next.split('/').pop() ?? next), target: { ...target, path: next,
          fileBrowser: target.fileBrowser ? { ...target.fileBrowser, folderPath: target.fileBrowser.folderPath && canonicalPath(target.fileBrowser.folderPath) === previousParent ? nextParent : target.fileBrowser.folderPath } : undefined } };
      if (target.kind === 'file-browser' && target.activeFilePath && canonicalPath(target.activeFilePath) === previous) return { ...entry,
        title: displayTitleFromFilename(next.split('/').pop() ?? next), target: { ...target, activeFilePath: next,
          folderPath: target.folderPath && canonicalPath(target.folderPath) === previousParent ? nextParent : target.folderPath } };
      if ((target.kind === 'media' || target.kind === 'table' || target.kind === 'media-library' || target.kind === 'collection') && canonicalPath(target.filePath) === previous)
        return { ...entry, title: displayTitleFromFilename(next.split('/').pop() ?? next), target: { ...target, filePath: next } };
      return entry;
    });
  },
  clearExternalPath: (path) => {
    const wanted = canonicalPath(path), currentId = session().navigation.current?.id;
    updateEntries((entry) => !usesPath(entry, wanted) ? entry : entry.id === currentId ? emptyFileBrowser(entry) : null);
  },
  clearTargetsUnderDirectory: (directoryPath) => {
    const directory = canonicalDirectoryPath(directoryPath), currentId = session().navigation.current?.id;
    updateEntries((entry) => {
      if (!targetPaths(entry.target).some((path) => isPathInDirectory(path, directory))) return entry;
      if (entry.id !== currentId) return null;
      const view = toBrowserEntry(entry).target;
      if (view.kind !== 'file-browser') return null;
      const folderRemoved = !!view.folderPath && isPathInDirectory(view.folderPath, directory);
      const fileRemoved = !!view.activeFilePath && isPathInDirectory(view.activeFilePath, directory);
      const folderPath = folderRemoved ? parentDirectoryPath(directory, directory) : view.folderPath;
      return fileRemoved ? emptyFileBrowser(entry, folderPath) : { ...entry, target: { ...view, folderPath } };
    });
  },
  removeContentByFilePath: (path) => {
    const wanted = canonicalPath(path);
    if (!wanted) return [];
    const current = session().navigation.current;
    const removed = current && usesPath(current, wanted) ? [current.id] : [];
    updateEntries((entry) => usesPath(entry, wanted) ? null : entry);
    return removed;
  },
  updateContentMetadata: (id, metadata) => {
    useWorkspaceSessionStore.getState().updateSession(session().id, (current) => {
      const entry = current.navigation.current;
      if (entry?.id !== id || Object.entries(metadata).every(([key, value]) => entry[key as keyof typeof metadata] === value)) return current;
      return { ...current, navigation: { ...current.navigation, current: { ...entry, ...metadata } } };
    });
  },
  setWebRuntime: (id, runtime) => { changeWeb(id, () => runtime); },
  navigateWeb: (id, url) => { const normalized = canonicalUrl(url); return normalized ? changeWeb(id, (runtime) => navigateWorkspaceWebRuntime(runtime, normalized)) : false; },
  goBackWeb: (id) => changeWeb(id, (runtime) => moveWorkspaceWebHistory(runtime, -1)),
  goForwardWeb: (id) => changeWeb(id, (runtime) => moveWorkspaceWebHistory(runtime, 1)),
  reloadWeb: (id) => changeWeb(id, reloadWorkspaceWebRuntime),
  reset: () => {
    useWorkspaceFocusStore.getState().reset(); clearSession(true);
    useWorkspaceSessionStore.getState().setBrowserLayout({ splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO });
  },
});
