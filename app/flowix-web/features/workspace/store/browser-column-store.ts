import { fromBrowserEntry } from './session-legacy-projections';
import { useWorkspaceSessionStore, getHostForSessionRuntime, getSessionRuntimeAtHost } from './workspace-session-store';
import { resolveWorkspaceFileSurfaceKind, workspaceSurfaceSupportsHost } from '../surface-registry';
import { createWorkspaceWebRuntime, navigateWorkspaceWebRuntime, moveWorkspaceWebHistory, reloadWorkspaceWebRuntime } from '../model/web-navigation';
import type { FileBrowserContext, FileBrowserTarget } from './file-browser-target';
import { createSecondaryNavigationFacade } from './session-compatibility';
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
    if (!target.activeFilePath) return workspaceSurfaceSupportsHost('file-browser', 'main-third');
    const fileKind = target.collectionType === 'table' ? 'table'
      : target.collectionType === 'media_library' ? 'media-library'
      : target.collectionType === 'work_documents' ? 'work-documents'
      : resolveWorkspaceFileSurfaceKind(target.activeFilePath);
    return workspaceSurfaceSupportsHost(`file-${fileKind}`, 'main-third');
  }
  return workspaceSurfaceSupportsHost(target.kind === 'agent_conversation' ? 'agent-conversation'
    : target.kind === 'folder-collection' ? 'collection' : target.kind, 'main-third');
}

export type { BrowserColumnEntry } from '../model/browser-column-session';
export type { WorkspaceWebRuntime as BrowserColumnWebRuntime } from '../model/surface-contract';

interface BrowserColumnState extends BrowserColumnSessionState {
  webRuntime: BrowserColumnWebRuntime | null;
  updateEntries: (transform: (entry: BrowserColumnEntry) => BrowserColumnEntry | null) => void;
  setVisible: (visible: boolean) => void;
  setSplitRatio: (ratio: number) => void;
  openContent: (entry: BrowserColumnEntry, options?: { history?: 'push' | 'skip' }) => string;
  focusContent: (surfaceId: string) => void;
  clearContent: () => void;
  clearSession: () => void;
  restoreHistoryEntry: (entry: BrowserColumnEntry, direction: 'back' | 'forward') => void;
  updateFileBrowserContext: (surfaceId: string, patch: Partial<FileBrowserContext>) => void;
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

function targetPaths(target: BrowserColumnTarget): string[] {
  if (target.kind === 'file-browser') return [target.activeFilePath, target.folderPath].filter((path): path is string => !!path);
  if (target.kind === 'media') return [target.filePath];
  if (target.kind === 'folder-collection') return [target.folderPath];
  return [];
}

function usesPath(entry: BrowserColumnEntry, path: string): boolean {
  return targetPaths(entry.target).some((candidate) => canonicalPath(candidate) === path);
}

function releaseBrowserFocus(): void {
  const focus = useWorkspaceFocusStore.getState();
  if (focus.focusedHostId === getSessionRuntimeAtHost('browser-column')) focus.focusHost(getSessionRuntimeAtHost('main-third'));
}

export function getBrowserColumnEntries(state: BrowserColumnSessionState): BrowserColumnEntry[] {
  return [...(state.current ? [state.current] : []), ...state.backStack, ...state.forwardStack];
}

/** Transform current content and both histories in one atomic store update. */
function transformEntries(
  state: BrowserColumnState,
  transform: (entry: BrowserColumnEntry) => BrowserColumnEntry | null,
): Partial<BrowserColumnState> {
  const current = state.current ? transform(state.current) : null;
  if (state.current && !current) releaseBrowserFocus();
  const mapStack = (stack: BrowserColumnEntry[]) => {
    const next = stack.flatMap((entry) => { const value = transform(entry); return value ? [value] : []; });
    return next.length === stack.length && next.every((entry, index) => entry === stack[index]) ? stack : next;
  };
  const backStack = mapStack(state.backStack);
  const forwardStack = mapStack(state.forwardStack);
  if (current === state.current && backStack === state.backStack && forwardStack === state.forwardStack) return state;
  return {
    current, backStack, forwardStack,
    visible: getHostForSessionRuntime('browser-column') === 'browser-column' ? state.visible && current !== null : state.visible,
    webRuntime: current?.target.kind === 'web' ? state.webRuntime : null,
  };
}

const emptySession = (): BrowserColumnSessionState => ({
  visible: false, splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
  current: null, backStack: [], forwardStack: [],
});

export const useBrowserColumnStore = createSecondaryNavigationFacade<BrowserColumnState>((set, get) => {
    const updateEntries = (transform: (entry: BrowserColumnEntry) => BrowserColumnEntry | null) => set((state) => transformEntries(state, transform));
    const updateContext = (surfaceId: string, patch: Partial<FileBrowserContext>) => set((state) => {
      const entry = state.current;
      if (entry?.id !== surfaceId || entry.target.kind !== 'file-browser') return state;
      return { current: { ...entry, target: { ...entry.target, ...patch } } };
    });
    const changeWeb = (surfaceId: string, change: (runtime: BrowserColumnWebRuntime) => BrowserColumnWebRuntime | null): boolean => {
      const state = get();
      const entry = state.current;
      if (entry?.id !== surfaceId || entry.target.kind !== 'web') return false;
      const runtime = change(state.webRuntime ?? createWorkspaceWebRuntime(entry.target.url));
      if (!runtime) return false;
      set({ current: runtime.currentUrl === entry.target.url ? entry : { ...entry, target: { ...entry.target, url: runtime.currentUrl } }, webRuntime: runtime });
      return true;
    };
    return {
      ...emptySession(),
      webRuntime: null,
      updateEntries,
      setVisible: (visible) => {
        if (visible) useWorkspaceFocusStore.getState().focusHost(getSessionRuntimeAtHost('browser-column'));
        else releaseBrowserFocus();
        set({ visible });
      },
      setSplitRatio: (ratio) => set({ splitRatio: clampSplitRatio(ratio) }),
      openContent: (incoming, options) => {
        const state = get();
        const current = state.current;
        const same = current && browserColumnTargetKey(current.target) === browserColumnTargetKey(incoming.target);
        const target = same && current.target.kind === 'file-browser' && incoming.target.kind === 'file-browser'
          ? { ...incoming.target, fileTreeVisible: current.target.fileTreeVisible, fileTreeWidth: current.target.fileTreeWidth }
          : incoming.target;
        const occupied = [current, ...state.backStack, ...state.forwardStack].some((entry) => entry?.id === incoming.id);
        const entry = { ...incoming, target, id: same ? current.id : options?.history === 'skip' ? incoming.id : occupied ? `browser:${crypto.randomUUID()}` : incoming.id };
        const canonical = fromBrowserEntry(entry);
        useWorkspaceSessionStore.getState().commitTarget('secondary-session', canonical.target, {
          entryId: entry.id, title: entry.title, icon: entry.icon, history: options?.history ?? 'push',
        });
        if (getHostForSessionRuntime('browser-column') === 'browser-column') {
          useWorkspaceSessionStore.getState().setBrowserLayout({ visible: true });
        }
        useWorkspaceFocusStore.getState().focusHost('browser-column');
        return useWorkspaceSessionStore.getState().sessions['secondary-session'].navigation.current!.id;
      },
      focusContent: (surfaceId) => {
        if (get().current?.id !== surfaceId) return;
        set({ visible: getHostForSessionRuntime('browser-column') === 'browser-column' ? true : get().visible });
        useWorkspaceFocusStore.getState().focusHost('browser-column');
      },
      clearContent: () => {
        set({ current: null, visible: getHostForSessionRuntime('browser-column') === 'browser-column' ? false : get().visible, webRuntime: null });
        releaseBrowserFocus();
      },
      clearSession: () => {
        set({ current: null, backStack: [], forwardStack: [], visible: getHostForSessionRuntime('browser-column') === 'browser-column' ? false : get().visible, webRuntime: null });
        releaseBrowserFocus();
      },
      restoreHistoryEntry: (entry, direction) => {
        const state = get();
        const current = state.current;
        set({ current: entry, visible: getHostForSessionRuntime('browser-column') === 'browser-column' ? true : state.visible, webRuntime: null,
          backStack: direction === 'back' ? state.backStack.slice(0, -1) : current ? [...state.backStack, current].slice(-100) : state.backStack,
          forwardStack: direction === 'forward' ? state.forwardStack.slice(0, -1) : current ? [...state.forwardStack, current].slice(-100) : state.forwardStack });
        useWorkspaceFocusStore.getState().focusHost('browser-column');
      },
      updateFileBrowserContext: updateContext,
      setFileBrowserTreeVisible: (id, visible) => updateContext(id, { fileTreeVisible: visible }),
      setFileBrowserTreeWidth: (id, width) => updateContext(id, { fileTreeWidth: clampFileTreeWidth(width) }),
      selectFileBrowserFile: (id, path, display, type, reason) => {
        const entry = get().current;
        if (entry?.id !== id || entry.target.kind !== 'file-browser') return;
        const name = (path ?? entry.target.folderPath)?.split(/[\\/]/).filter(Boolean).pop() ?? '';
        get().openContent({ ...entry, title: displayTitleFromFilename(name), target: { ...entry.target,
          activeFilePath: path, collectionDisplay: display, collectionType: type, collectionUnavailableReason: reason } });
      },
      replaceExternalPath: (previousPath, path) => {
        const previous = canonicalPath(previousPath);
        const next = canonicalPath(path);
        const previousParent = previous.replace(/\/[^/]*$/, '');
        const nextParent = next.replace(/\/[^/]*$/, '');
        set((state) => transformEntries(state, (entry) => {
          const target = entry.target;
          if (target.kind === 'file-browser' && target.activeFilePath && canonicalPath(target.activeFilePath) === previous) {
            return { ...entry, title: displayTitleFromFilename(next.split('/').pop() ?? next), target: { ...target, activeFilePath: next,
              folderPath: target.folderPath && canonicalPath(target.folderPath) === previousParent ? nextParent : target.folderPath } };
          }
          if (target.kind === 'media' && canonicalPath(target.filePath) === previous) {
            return { ...entry, title: next.split('/').pop() ?? next, target: { ...target, filePath: next } };
          }
          return entry;
        }));
      },
      clearExternalPath: (path) => {
        const wanted = canonicalPath(path);
        set((state) => ({
          ...transformEntries(state, (entry) => {
            if (!usesPath(entry, wanted)) return entry;
            const target = entry.target;
            if (entry !== state.current || target.kind !== 'file-browser') return null;
            return { ...entry, title: displayTitleFromFilename(target.folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? ''), target: { ...target,
              activeFilePath: null, collectionDisplay: undefined, collectionType: undefined, collectionUnavailableReason: undefined } };
          }),
        }));
      },
      clearTargetsUnderDirectory: (directoryPath) => {
        const directory = canonicalDirectoryPath(directoryPath);
        set((state) => transformEntries(state, (entry) => {
          if (!targetPaths(entry.target).some((path) => isPathInDirectory(path, directory))) return entry;
          const target = entry.target;
          if (entry !== state.current || target.kind !== 'file-browser') return null;
          const folderRemoved = !!target.folderPath && isPathInDirectory(target.folderPath, directory);
          const fileRemoved = !!target.activeFilePath && isPathInDirectory(target.activeFilePath, directory);
          const folderPath = folderRemoved ? parentDirectoryPath(directory, directory) : target.folderPath;
          return { ...entry, title: displayTitleFromFilename(folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? ''), target: { ...target,
            folderPath, activeFilePath: fileRemoved ? null : target.activeFilePath,
            collectionDisplay: fileRemoved ? undefined : target.collectionDisplay,
            collectionType: fileRemoved ? undefined : target.collectionType,
            collectionUnavailableReason: fileRemoved ? undefined : target.collectionUnavailableReason } };
        }));
      },
      removeContentByFilePath: (path) => {
        const wanted = canonicalPath(path);
        if (!wanted) return [];
        const current = get().current;
        const removed = current && usesPath(current, wanted) ? [current.id] : [];
        set((state) => transformEntries(state, (entry) => usesPath(entry, wanted) ? null : entry));
        return removed;
      },
      updateContentMetadata: (id, metadata) => set((state) => {
        const entry = state.current;
        if (entry?.id !== id || Object.entries(metadata).every(([key, value]) => entry[key as keyof typeof metadata] === value)) return state;
        return { current: { ...entry, ...metadata } };
      }),
      setWebRuntime: (id, runtime) => { changeWeb(id, () => runtime); },
      navigateWeb: (id, url) => {
        const normalized = canonicalUrl(url);
        return normalized ? changeWeb(id, (runtime) => navigateWorkspaceWebRuntime(runtime, normalized)) : false;
      },
      goBackWeb: (id) => changeWeb(id, (runtime) => moveWorkspaceWebHistory(runtime, -1)),
      goForwardWeb: (id) => changeWeb(id, (runtime) => moveWorkspaceWebHistory(runtime, 1)),
      reloadWeb: (id) => changeWeb(id, reloadWorkspaceWebRuntime),
      reset: () => {
        useWorkspaceFocusStore.getState().reset();
        set({ ...emptySession(), webRuntime: null });
      },
    };
  });
