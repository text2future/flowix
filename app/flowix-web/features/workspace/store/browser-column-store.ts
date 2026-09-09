import type { FileBrowserContext, FileBrowserTarget } from './file-browser-target';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { STORAGE_KEYS } from '@/lib/constants';
import { canonicalPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import {
  normalizePluginArtifactRenderer,
  type PluginArtifactRendererId,
} from '@features/plugin/plugin-note';
import { canonicalUrl, contentIdentityKey } from './workspace-content-identity';
import { useWorkspaceFocusStore } from './workspace-focus-store';

export type BrowserColumnTarget =
  | {
      kind: 'memo';
      memoId: string;
      notebookId: string;
      notebookPath: string;
      filePath: string;
    }
  | FileBrowserTarget
  | {
      kind: 'web';
      url: string;
    }
  | {
      kind: 'artifact';
      pointerMemoId: string;
      renderer: PluginArtifactRendererId | null;
    }
  | {
      kind: 'agent_conversation';
      instanceId: string;
    };

/** Only targets with a usable work-column surface can be moved there. */
export function canMoveBrowserColumnTargetToWorkColumn(target: BrowserColumnTarget): boolean {
  return target.kind !== 'web'
    && (target.kind !== 'file-browser' || Boolean(target.activeFilePath));
}

export interface BrowserColumnTab {
  id: string;
  title: string;
  icon: string | null;
  target: BrowserColumnTarget;
}

/** Runtime-only state for a web tab. It is intentionally not persisted with tabs. */
export interface BrowserColumnWebRuntime {
  currentUrl: string;
  history: string[];
  historyIndex: number;
  reloadToken: number;
  isLoading: boolean;
  error: string | null;
}

export type BrowserColumnWebNavigationPhase = 'navigating' | 'started' | 'finished';

export type BrowserColumnOpenDisposition = 'focus-existing' | 'replace-active' | 'open-in-column';

interface BrowserColumnState {
  visible: boolean;
  splitRatio: number;
  tabs: BrowserColumnTab[];
  activeTabId: string | null;
  webRuntimes: Record<string, BrowserColumnWebRuntime>;
  setVisible: (visible: boolean) => void;
  setSplitRatio: (ratio: number) => void;
  updateFileBrowserContext: (tabId: string, patch: Partial<FileBrowserContext>) => void;
  selectFileBrowserFile: (tabId: string, filePath: string | null) => void;
  switchFileBrowserFolder: (tabId: string, folderPath: string) => void;
  setFileBrowserTreeVisible: (tabId: string, visible: boolean) => void;
  setFileBrowserTreeWidth: (tabId: string, width: number) => void;
  openTab: (tab: BrowserColumnTab, disposition?: BrowserColumnOpenDisposition) => string;
  commitTab: (tabId: string) => void;
  closeTab: (tabId: string) => string | null;
  closeOtherTabs: (tabId: string) => string | null;
  closeTabsToRight: (tabId: string) => string | null;
  closeAllTabs: () => void;
  replaceMemoPath: (memoId: string, path: string) => void;
  removeTabsByMemoId: (memoId: string) => string[];
  reorderTab: (tabId: string, beforeTabId: string | null) => void;
  updateTabMetadata: (tabId: string, metadata: Partial<Pick<BrowserColumnTab, 'title' | 'icon'>>) => void;
  setWebRuntime: (tabId: string, runtime: BrowserColumnWebRuntime) => void;
  syncWebTabNavigation: (
    tabId: string,
    url: string,
    phase: BrowserColumnWebNavigationPhase,
  ) => boolean;
  navigateWebTab: (tabId: string, url: string) => boolean;
  goBackWebTab: (tabId: string) => boolean;
  goForwardWebTab: (tabId: string) => boolean;
  reloadWebTab: (tabId: string) => boolean;
  reset: () => void;
}

/** The main and browser document panes share the same minimum width. */
export const BROWSER_COLUMN_MIN_WIDTH = 360;
export const BROWSER_COLUMN_DEFAULT_SPLIT_RATIO = 0.5;
export const BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH = 220;
export const BROWSER_COLUMN_FILE_TREE_MIN_WIDTH = 200;
export const BROWSER_COLUMN_FILE_TREE_MAX_WIDTH = 420;

export function browserColumnTargetKey(target: BrowserColumnTarget): string | null {
  switch (target.kind) {
    case 'memo': return contentIdentityKey({ kind: 'memo', memoId: target.memoId });
    case 'file-browser': return target.activeFilePath
      ? contentIdentityKey({ kind: 'external', path: target.activeFilePath })
      : target.folderPath ? `file-browser:${canonicalPath(target.folderPath)}` : null;
    case 'web': return contentIdentityKey({ kind: 'web', url: target.url });
    case 'artifact': return contentIdentityKey({ kind: 'artifact', pointerMemoId: target.pointerMemoId });
    case 'agent_conversation': return contentIdentityKey({
      kind: 'agent-conversation',
      instanceId: target.instanceId,
    });
  }
}

function adjacentTabId(tabs: BrowserColumnTab[], closingTabId: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === closingTabId);
  if (index < 0) return null;
  return tabs[index - 1]?.id ?? tabs[index + 1]?.id ?? null;
}

const BROWSER_COLUMN_MIN_RATIO = 0.05;
const BROWSER_COLUMN_MAX_RATIO = 0.95;
const LEGACY_BROWSER_COLUMN_STORAGE_KEY = 'flowix-fourth-column-storage';
const LEGACY_SPLIT_RATIO_STORAGE_KEY = 'flowix.workspace.fourth-column.split-ratio';

function clampSplitRatio(splitRatio: number): number {
  return Number.isFinite(splitRatio)
    ? Math.min(BROWSER_COLUMN_MAX_RATIO, Math.max(BROWSER_COLUMN_MIN_RATIO, splitRatio))
    : BROWSER_COLUMN_DEFAULT_SPLIT_RATIO;
}

function clampFileTreeWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.min(BROWSER_COLUMN_FILE_TREE_MAX_WIDTH, Math.max(BROWSER_COLUMN_FILE_TREE_MIN_WIDTH, width))
    : BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH;
}

function initialWebRuntime(url: string): BrowserColumnWebRuntime {
  return {
    currentUrl: url,
    history: [url],
    historyIndex: 0,
    reloadToken: 0,
    isLoading: false,
    error: null,
  };
}

function isWebTab(tab: BrowserColumnTab | undefined): tab is BrowserColumnTab & {
  target: Extract<BrowserColumnTarget, { kind: 'web' }>;
} {
  return tab?.target.kind === 'web';
}

function withWebRuntime(
  runtimes: Record<string, BrowserColumnWebRuntime>,
  tab: BrowserColumnTab | undefined,
): BrowserColumnWebRuntime | null {
  if (!isWebTab(tab)) return null;
  return runtimes[tab.id] ?? initialWebRuntime(tab.target.url);
}

function updateWebTabTarget(
  tabs: BrowserColumnTab[],
  tabId: string,
  url: string,
): BrowserColumnTab[] {
  return tabs.map((tab) => tab.id === tabId && isWebTab(tab)
    ? { ...tab, target: { ...tab.target, url } }
    : tab);
}

function updateFileBrowserTabTarget(
  tabs: BrowserColumnTab[],
  tabId: string,
  filePath: string | null,
): BrowserColumnTab[] {
  return tabs.map((tab) => tab.id === tabId && tab.target.kind === 'file-browser'
    ? { ...tab, title: filePath ? displayTitleFromFilename(filePath.split(/[\\/]/).pop() ?? filePath) : tab.title, target: { ...tab.target, activeFilePath: filePath } }
    : tab);
}

function updateFileBrowserTabFolder(
  tabs: BrowserColumnTab[],
  tabId: string,
  folderPath: string,
): BrowserColumnTab[] {
  const folderName = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folderPath;
  return tabs.map((tab) => tab.id === tabId && tab.target.kind === 'file-browser'
    ? {
        ...tab,
        title: folderName || tab.title,
        target: {
          ...tab.target,
          folderPath,
          scopePath: folderPath,
          activeFilePath: null,
        },
      }
    : tab);
}

function updateFileBrowserTabTree(
  tabs: BrowserColumnTab[],
  tabId: string,
  patch: Partial<Extract<BrowserColumnTarget, { kind: 'file-browser' }>>,
): BrowserColumnTab[] {
  return tabs.map((tab) => tab.id === tabId && tab.target.kind === 'file-browser'
    ? { ...tab, target: { ...tab.target, ...patch } }
    : tab);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseBrowserColumnTarget(value: unknown): BrowserColumnTarget | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;

  switch (value.kind) {
    case 'memo':
      return nonEmptyString(value.memoId)
        && typeof value.notebookId === 'string'
        && typeof value.notebookPath === 'string'
        && nonEmptyString(value.filePath)
        ? {
            kind: 'memo',
            memoId: value.memoId,
            notebookId: value.notebookId,
            notebookPath: value.notebookPath,
            filePath: value.filePath,
          }
        : null;
    case 'file':
    case 'external_markdown':
    case 'external_text': {
      if (!nonEmptyString(value.filePath)) return null;
      return {
        kind: 'file-browser',
        activeFilePath: value.filePath,
        folderPath: null,
        notebookId: null,
        restoreNotebookContext: true,
        fileTreeVisible: true,
        fileTreeWidth: BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH,
        scopePath: typeof value.scopePath === 'string' && value.scopePath.trim()
          ? value.scopePath
          : null,
      };
    }
    case 'file-browser':
      return nonEmptyString(value.folderPath) || nonEmptyString(value.activeFilePath)
        ? {
            kind: 'file-browser',
            folderPath: nonEmptyString(value.folderPath) ? value.folderPath : null,
            notebookId: nonEmptyString(value.notebookId) ? value.notebookId : null,
            ...(value.restoreNotebookContext === true || !('notebookId' in value) ? { restoreNotebookContext: true } : {}),
            scopePath: nonEmptyString(value.scopePath) ? value.scopePath : nonEmptyString(value.folderPath) ? value.folderPath : null,
            activeFilePath: typeof value.activeFilePath === 'string' ? value.activeFilePath : null,
            fileTreeVisible: value.fileTreeVisible !== false,
            fileTreeWidth: clampFileTreeWidth(
              typeof value.fileTreeWidth === 'number'
                ? value.fileTreeWidth
                : BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH,
            ),
          }
        : null;
    case 'web':
    case 'external_webpage': {
      const url = typeof value.url === 'string' ? canonicalUrl(value.url) : null;
      return url ? { kind: 'web', url } : null;
    }
    case 'artifact':
      {
        const renderer = value.renderer === null
          ? null
          : normalizePluginArtifactRenderer(value.renderer);
        return nonEmptyString(value.pointerMemoId)
          && (value.renderer === null || renderer !== null)
          ? {
              kind: 'artifact',
              pointerMemoId: value.pointerMemoId,
              renderer,
            }
          : null;
      }
    case 'agent_conversation':
      return nonEmptyString(value.instanceId)
        ? { kind: 'agent_conversation', instanceId: value.instanceId }
        : null;
    default:
      return null;
  }
}

function parseBrowserColumnTab(value: unknown): BrowserColumnTab | null {
  if (!isRecord(value) || !nonEmptyString(value.id) || typeof value.title !== 'string') {
    return null;
  }
  if (value.icon !== null && typeof value.icon !== 'string') return null;
  const target = parseBrowserColumnTarget(value.target);
  if (!target) return null;
  return {
    id: value.id,
    title: value.title,
    icon: value.icon,
    target,
  };
}

function normalizePersistedTabs(value: unknown, activeTabId: unknown): BrowserColumnTab[] {
  if (!Array.isArray(value)) return [];

  const tabs: BrowserColumnTab[] = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  for (const candidate of value) {
    const tab = parseBrowserColumnTab(candidate);
    if (!tab || seenIds.has(tab.id)) continue;
    const targetKey = browserColumnTargetKey(tab.target);
    if (!targetKey) continue;
    if (seenKeys.has(targetKey)) {
      // Keep the active duplicate's context and tree preferences at the old slot.
      if (tab.id === activeTabId) {
        const index = tabs.findIndex((candidate) => browserColumnTargetKey(candidate.target) === targetKey);
        tabs[index] = tab;
      }
      continue;
    }
    seenIds.add(tab.id);
    seenKeys.add(targetKey);
    tabs.push(tab);
  }
  return tabs;
}

function readLegacySplitRatio(): number | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const ratio = Number(localStorage.getItem(LEGACY_SPLIT_RATIO_STORAGE_KEY));
    return Number.isFinite(ratio) ? clampSplitRatio(ratio) : null;
  } catch {
    return null;
  }
}

const browserColumnStorage = createJSONStorage(() => ({
  getItem: (name: string) => {
    if (typeof localStorage === 'undefined') return null;
    const current = localStorage.getItem(name);
    if (current !== null || name !== STORAGE_KEYS.BROWSER_COLUMN) return current;
    return localStorage.getItem(LEGACY_BROWSER_COLUMN_STORAGE_KEY);
  },
  setItem: (name: string, value: string) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(name, value);
  },
  removeItem: (name: string) => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(name);
  },
}));

type PersistedBrowserColumnState = Pick<
  BrowserColumnState,
  'visible' | 'splitRatio' | 'tabs' | 'activeTabId'
>;

function mergePersistedBrowserColumnState(
  persisted: unknown,
  current: BrowserColumnState,
): BrowserColumnState {
  if (!isRecord(persisted)) {
    const legacySplitRatio = readLegacySplitRatio();
    return legacySplitRatio === null
      ? current
      : { ...current, splitRatio: legacySplitRatio };
  }

  const tabs = normalizePersistedTabs(persisted.tabs, persisted.activeTabId);
  const requestedActiveTabId = typeof persisted.activeTabId === 'string'
    ? persisted.activeTabId
    : null;
  const activeTabId = tabs.some((tab) => tab.id === requestedActiveTabId)
    ? requestedActiveTabId
    : tabs[0]?.id ?? null;

  return {
    ...current,
    visible: tabs.length > 0 && persisted.visible !== false,
    splitRatio: clampSplitRatio(
      typeof persisted.splitRatio === 'number'
        ? persisted.splitRatio
        : readLegacySplitRatio() ?? BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
    ),
    tabs,
    activeTabId,
    // WebView instances and their history are process-local. Rehydrating a
    // durable tab list must always start them from the target URL.
    webRuntimes: {},
  };
}

export const useBrowserColumnStore = create<BrowserColumnState>()(
  persist(
  (set, get) => ({
      visible: false,
      splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
      tabs: [],
      activeTabId: null,
      webRuntimes: {},
      setVisible: (visible) => {
        const focus = useWorkspaceFocusStore.getState();
        if (visible) focus.focusHost('browser-column');
        else if (focus.focusedHostId === 'browser-column') focus.focusHost('main-third');
        set({ visible });
      },
      setSplitRatio: (splitRatio) => set({ splitRatio: clampSplitRatio(splitRatio) }),
      updateFileBrowserContext: (tabId, patch) => {
        set({ tabs: updateFileBrowserTabTree(get().tabs, tabId, patch) });
      },
      selectFileBrowserFile: (tabId, filePath) => {
        const tab = get().tabs.find((candidate) => candidate.id === tabId);
        if (!tab || tab.target.kind !== 'file-browser') return;
        set({ tabs: updateFileBrowserTabTarget(get().tabs, tabId, filePath) });
      },
      switchFileBrowserFolder: (tabId, folderPath) => {
        if (!folderPath.trim()) return;
        const tab = get().tabs.find((candidate) => candidate.id === tabId);
        if (!tab || tab.target.kind !== 'file-browser') return;
        set({ tabs: updateFileBrowserTabFolder(get().tabs, tabId, folderPath) });
      },
      setFileBrowserTreeVisible: (tabId, visible) => {
        set({ tabs: updateFileBrowserTabTree(get().tabs, tabId, { fileTreeVisible: visible }) });
      },
      setFileBrowserTreeWidth: (tabId, width) => {
        set({ tabs: updateFileBrowserTabTree(get().tabs, tabId, { fileTreeWidth: clampFileTreeWidth(width) }) });
      },
      openTab: (incoming, disposition = 'focus-existing') => {
        const state = get();
        const incomingKey = browserColumnTargetKey(incoming.target);
        const existing = incomingKey
          ? state.tabs.find((tab) => browserColumnTargetKey(tab.target) === incomingKey)
          : undefined;
        if (existing) {
          const updatedTabs = state.tabs.map((candidate) => candidate.id === existing.id
            ? { ...candidate, ...incoming, id: existing.id }
            : candidate);
          const tabs = disposition === 'replace-active'
            && state.activeTabId
            && state.activeTabId !== existing.id
            ? updatedTabs.filter((tab) => tab.id !== state.activeTabId)
            : updatedTabs;
          const webRuntimes = { ...state.webRuntimes };
          if (isWebTab(existing)) {
            webRuntimes[existing.id] ??= initialWebRuntime(existing.target.url);
          } else {
            delete webRuntimes[existing.id];
          }
          useWorkspaceFocusStore.getState().focusHost('browser-column');
          set({ visible: true, tabs, activeTabId: existing.id, webRuntimes });
          return existing.id;
        }

        // A tab keeps its ID when its selected file changes. A later open of
        // the original file must not reuse that occupied ID.
        const id = state.tabs.some((tab) => tab.id === incoming.id)
          ? `${incoming.id}:${crypto.randomUUID()}`
          : incoming.id;
        const tab = { ...incoming, id };
        const tabs = disposition === 'replace-active' && state.activeTabId
          ? state.tabs.map((candidate) => candidate.id === state.activeTabId ? tab : candidate)
          : [...state.tabs, tab];
        const webRuntimes = { ...state.webRuntimes };
        if (state.activeTabId && disposition === 'replace-active') {
          delete webRuntimes[state.activeTabId];
        }
        if (isWebTab(tab)) {
          webRuntimes[id] = initialWebRuntime(tab.target.url);
        }
        useWorkspaceFocusStore.getState().focusHost('browser-column');
        set({
          visible: true,
          tabs,
          activeTabId: id,
          webRuntimes,
        });
        return id;
      },
      commitTab: (tabId) => {
        if (!get().tabs.some((tab) => tab.id === tabId)) return;
        useWorkspaceFocusStore.getState().focusHost('browser-column');
        set({ visible: true, activeTabId: tabId });
      },
      closeTab: (tabId) => {
        const state = get();
        if (!state.tabs.some((tab) => tab.id === tabId)) return state.activeTabId;
        const nextActiveTabId = state.activeTabId === tabId
          ? adjacentTabId(state.tabs, tabId)
          : state.activeTabId;
        const tabs = state.tabs.filter((tab) => tab.id !== tabId);
        const webRuntimes = { ...state.webRuntimes };
        delete webRuntimes[tabId];
        useWorkspaceFocusStore.getState().focusHost(tabs.length > 0 ? 'browser-column' : 'main-third');
        set({
          tabs,
          activeTabId: nextActiveTabId,
          visible: tabs.length > 0,
          webRuntimes,
        });
        return nextActiveTabId;
      },
      closeOtherTabs: (tabId) => {
        const state = get();
        if (!state.tabs.some((tab) => tab.id === tabId)) return state.activeTabId;
        const tabs = state.tabs.filter((tab) => tab.id === tabId);
        const webRuntimes = state.webRuntimes[tabId]
          ? { [tabId]: state.webRuntimes[tabId] }
          : {};
        useWorkspaceFocusStore.getState().focusHost('browser-column');
        set({
          tabs,
          activeTabId: tabId,
          visible: true,
          webRuntimes,
        });
        return tabId;
      },
      closeTabsToRight: (tabId) => {
        const state = get();
        const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex < 0) return state.activeTabId;
        const tabs = state.tabs.slice(0, tabIndex + 1);
        const activeTabIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
        const activeTabId = activeTabIndex < 0 || activeTabIndex > tabIndex
          ? tabId
          : state.activeTabId;
        const webRuntimes = Object.fromEntries(
          tabs
            .filter((tab) => state.webRuntimes[tab.id])
            .map((tab) => [tab.id, state.webRuntimes[tab.id]]),
        );
        useWorkspaceFocusStore.getState().focusHost('browser-column');
        set({
          tabs,
          activeTabId,
          visible: true,
          webRuntimes,
        });
        return activeTabId;
      },
      closeAllTabs: () => {
        useWorkspaceFocusStore.getState().focusHost('main-third');
        set({
          tabs: [],
          activeTabId: null,
          visible: false,
          webRuntimes: {},
        });
      },
      replaceMemoPath: (memoId, path) => {
        if (!memoId || !path) return;
        const filename = path.split(/[\\/]/).pop() ?? path;
        set((state) => ({
          tabs: state.tabs.map((tab) => tab.target.kind === 'memo' && tab.target.memoId === memoId
            ? {
                ...tab,
                title: displayTitleFromFilename(filename),
                target: { ...tab.target, filePath: path },
              }
            : tab),
        }));
      },
      removeTabsByMemoId: (memoId) => {
        if (!memoId) return [];
        const state = get();
        const removedIds = state.tabs
          .filter((tab) => (
            (tab.target.kind === 'memo' && tab.target.memoId === memoId)
            || (tab.target.kind === 'artifact' && tab.target.pointerMemoId === memoId)
          ))
          .map((tab) => tab.id);
        if (removedIds.length === 0) return [];

        const removed = new Set(removedIds);
        const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
        const tabs = state.tabs.filter((tab) => !removed.has(tab.id));
        const activeWasRemoved = state.activeTabId !== null && removed.has(state.activeTabId);
        const activeTabId = activeWasRemoved
          ? tabs[activeIndex - 1]?.id ?? tabs[activeIndex]?.id ?? null
          : state.activeTabId;
        const webRuntimes = Object.fromEntries(
          tabs
            .filter((tab) => state.webRuntimes[tab.id])
            .map((tab) => [tab.id, state.webRuntimes[tab.id]]),
        );
        useWorkspaceFocusStore.getState().focusHost(
          tabs.length > 0 ? 'browser-column' : 'main-third',
        );
        set({
          tabs,
          activeTabId,
          visible: tabs.length > 0,
          webRuntimes,
        });
        return removedIds;
      },
      reorderTab: (tabId, beforeTabId) => set((state) => {
        const sourceIndex = state.tabs.findIndex((tab) => tab.id === tabId);
        if (sourceIndex < 0 || beforeTabId === tabId) return state;
        const tabs = [...state.tabs];
        const [tab] = tabs.splice(sourceIndex, 1);
        const targetIndex = beforeTabId
          ? tabs.findIndex((candidate) => candidate.id === beforeTabId)
          : tabs.length;
        tabs.splice(targetIndex < 0 ? tabs.length : targetIndex, 0, tab);
        return { tabs };
      }),
      updateTabMetadata: (tabId, metadata) => set((state) => {
        if (!state.tabs.some((tab) => tab.id === tabId)) return state;
        return {
          tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, ...metadata } : tab),
        };
      }),
      setWebRuntime: (tabId, runtime) => set((state) => {
        if (!isWebTab(state.tabs.find((tab) => tab.id === tabId))) return state;
        return {
          tabs: updateWebTabTarget(state.tabs, tabId, runtime.currentUrl),
          webRuntimes: { ...state.webRuntimes, [tabId]: runtime },
        };
      }),
      syncWebTabNavigation: (tabId, url, phase) => {
        const normalized = canonicalUrl(url);
        if (!normalized) return false;
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        const current = withWebRuntime(state.webRuntimes, tab);
        if (!current || !isWebTab(tab)) return false;

        let history = current.history;
        let historyIndex = current.historyIndex;
        if (history[historyIndex] !== normalized) {
          const adjacentIndex = history.findIndex(
            (candidate, index) => Math.abs(index - historyIndex) === 1 && candidate === normalized,
          );
          if (adjacentIndex >= 0) {
            historyIndex = adjacentIndex;
          } else {
            history = history.slice(0, historyIndex + 1);
            history.push(normalized);
            historyIndex = history.length - 1;
          }
        }

        set({
          tabs: updateWebTabTarget(state.tabs, tabId, normalized),
          webRuntimes: {
            ...state.webRuntimes,
            [tabId]: {
              ...current,
              currentUrl: normalized,
              history,
              historyIndex,
              isLoading: phase !== 'finished',
              error: null,
            },
          },
        });
        return true;
      },
      navigateWebTab: (tabId, url) => {
        const normalized = canonicalUrl(url);
        if (!normalized) return false;
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        const current = withWebRuntime(state.webRuntimes, tab);
        if (!current || !isWebTab(tab)) return false;
        const history = current.history.slice(0, current.historyIndex + 1);
        if (history[history.length - 1] !== normalized) history.push(normalized);
        set({
          tabs: updateWebTabTarget(state.tabs, tabId, normalized),
          webRuntimes: {
            ...state.webRuntimes,
            [tabId]: {
              ...current,
              currentUrl: normalized,
              history,
              historyIndex: history.length - 1,
              reloadToken: current.reloadToken + 1,
              isLoading: true,
              error: null,
            },
          },
        });
        return true;
      },
      goBackWebTab: (tabId) => {
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        const current = withWebRuntime(state.webRuntimes, tab);
        if (!current || current.historyIndex <= 0) return false;
        const historyIndex = current.historyIndex - 1;
        set({
          tabs: updateWebTabTarget(state.tabs, tabId, current.history[historyIndex]),
          webRuntimes: {
            ...state.webRuntimes,
            [tabId]: {
              ...current,
              currentUrl: current.history[historyIndex],
              historyIndex,
              reloadToken: current.reloadToken + 1,
              isLoading: true,
              error: null,
            },
          },
        });
        return true;
      },
      goForwardWebTab: (tabId) => {
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        const current = withWebRuntime(state.webRuntimes, tab);
        if (!current || current.historyIndex >= current.history.length - 1) return false;
        const historyIndex = current.historyIndex + 1;
        set({
          tabs: updateWebTabTarget(state.tabs, tabId, current.history[historyIndex]),
          webRuntimes: {
            ...state.webRuntimes,
            [tabId]: {
              ...current,
              currentUrl: current.history[historyIndex],
              historyIndex,
              reloadToken: current.reloadToken + 1,
              isLoading: true,
              error: null,
            },
          },
        });
        return true;
      },
      reloadWebTab: (tabId) => {
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        const current = withWebRuntime(state.webRuntimes, tab);
        if (!current) return false;
        set({
          webRuntimes: {
            ...state.webRuntimes,
            [tabId]: {
              ...current,
              reloadToken: current.reloadToken + 1,
              isLoading: true,
              error: null,
            },
          },
        });
        return true;
      },
      reset: () => {
        useWorkspaceFocusStore.getState().reset();
        set({
          visible: false,
          splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
          tabs: [],
          activeTabId: null,
          webRuntimes: {},
        });
      },
    }),
    {
      name: STORAGE_KEYS.BROWSER_COLUMN,
      version: 3,
      migrate: (persisted) => persisted as PersistedBrowserColumnState,
      storage: browserColumnStorage,
      partialize: (state): PersistedBrowserColumnState => ({
        visible: state.visible,
        splitRatio: state.splitRatio,
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
      merge: (persisted, current) => mergePersistedBrowserColumnState(persisted, current),
    },
  ),
);
