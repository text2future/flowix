import { SESSION_HISTORY_LIMIT } from '../model/session-limits';
import { restoreWorkspaceWebRuntime } from '../model/web-navigation';
import type { CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { canonicalUrl } from '../model/surface-identity';
import { browserColumnTargetKey, type BrowserColumnTarget } from '../model/browser-column-target';
import type { BrowserColumnEntry, BrowserColumnSessionState } from '../model/browser-column-session';
import { BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH, clampFileTreeWidth, clampSplitRatio } from '../model/browser-column-layout';

const LEGACY_SPLIT_RATIO_STORAGE_KEY = 'flowix.workspace.fourth-column.split-ratio';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseCollectionDisplay(value: unknown): CollectionDisplayDescriptor | null {
  if (!isRecord(value) || !nonEmptyString(value.collectionId)
    || !nonEmptyString(value.displayId) || !nonEmptyString(value.notebookId)) return null;
  return { collectionId: value.collectionId, displayId: value.displayId,
    notebookId: value.notebookId, viewId: nonEmptyString(value.viewId) ? value.viewId : null };
}

function parseBrowserColumnTarget(value: unknown): BrowserColumnTarget | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;

  switch (value.kind) {
    case 'folder-collection':
      return nonEmptyString(value.folderPath) && nonEmptyString(value.notebookId)
        && nonEmptyString(value.notebookPath) && typeof value.folderName === 'string'
        ? { kind: 'folder-collection', folderPath: value.folderPath, notebookId: value.notebookId,
            notebookPath: value.notebookPath, folderName: value.folderName,
            ...(value.viewMode === 'work-documents' ? { viewMode: value.viewMode } : {}) }
        : null;
    case 'media':
      return nonEmptyString(value.filePath)
        && (value.notebookId === null || typeof value.notebookId === 'string')
        && (value.notebookPath === null || nonEmptyString(value.notebookPath))
        && (value.resourceKind === 'image' || value.resourceKind === 'video')
        ? {
            kind: 'media',
            filePath: value.filePath,
            notebookId: value.notebookId,
            notebookPath: value.notebookPath,
            resourceKind: value.resourceKind,
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
    case 'file-browser': {
      const collectionDisplay = parseCollectionDisplay(value.collectionDisplay);
      return nonEmptyString(value.folderPath) || nonEmptyString(value.activeFilePath)
        ? {
            kind: 'file-browser',
            ...(value.collectionType === 'table' || value.collectionType === 'media_library' || value.collectionType === 'work_documents' || value.collectionType === 'hybrid' ? { collectionType: value.collectionType } : {}),
            ...(collectionDisplay ? { collectionDisplay } : {}),
            folderPath: nonEmptyString(value.folderPath) ? value.folderPath : null,
            notebookId: nonEmptyString(value.notebookId) ? value.notebookId : null,
            ...(nonEmptyString(value.notebookContextPath) && value.notebookContextPath === value.activeFilePath
              ? { notebookContextPath: value.notebookContextPath } : {}),
            ...(value.restoreNotebookContext === true || !('notebookId' in value) ? { restoreNotebookContext: true } : {}),
            scopePath: nonEmptyString(value.scopePath) ? value.scopePath : nonEmptyString(value.folderPath) ? value.folderPath : null,
            activeFilePath: typeof value.activeFilePath === 'string' ? value.activeFilePath : null,
            fileTreeVisible: typeof value.fileTreeVisible === 'boolean'
              ? value.fileTreeVisible
              : true,
            fileTreeWidth: clampFileTreeWidth(
              typeof value.fileTreeWidth === 'number'
                ? value.fileTreeWidth
                : BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH,
            ),
          }
        : null;
    }
    case 'web':
    case 'external_webpage': {
      const url = typeof value.url === 'string' ? canonicalUrl(value.url) : null;
      return url ? { kind: 'web', url } : null;
    }
    case 'agent_conversation':
      return nonEmptyString(value.instanceId)
        ? { kind: 'agent_conversation', instanceId: value.instanceId }
        : null;
    default:
      return null;
  }
}

function parseBrowserColumnEntry(value: unknown): BrowserColumnEntry | null {
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

function normalizePersistedTabs(value: unknown, activeTabId: unknown): BrowserColumnEntry[] {
  if (!Array.isArray(value)) return [];

  const tabs: BrowserColumnEntry[] = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  for (const candidate of value) {
    const tab = parseBrowserColumnEntry(candidate);
    if (!tab || seenIds.has(tab.id)) continue;
    const filePath = tab.target.kind === 'file-browser' ? tab.target.activeFilePath : null;
    // Keep agent configuration out of automatic session restoration.
    if (filePath?.split(/[\\/]/).pop() === 'AGENTS.md') continue;
    const targetKey = browserColumnTargetKey(tab.target);
    if (!targetKey) continue;
    seenIds.add(tab.id);
    if (seenKeys.has(targetKey)) {
      // Keep the active duplicate's context and tree preferences at the old slot.
      if (tab.id === activeTabId) {
        const index = tabs.findIndex((candidate) => browserColumnTargetKey(candidate.target) === targetKey);
        tabs[index] = tab;
      }
      continue;
    }
    seenKeys.add(targetKey);
    tabs.push(tab);
  }
  return tabs;
}

function normalizeHistory(value: unknown): BrowserColumnEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const tab = parseBrowserColumnEntry(item);
    return tab && !(tab.target.kind === 'file-browser' && tab.target.activeFilePath?.split(/[\\/]/).pop() === 'AGENTS.md') ? [tab] : [];
  }).slice(-SESSION_HISTORY_LIMIT);
}

function readLegacySplitRatio(): number | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LEGACY_SPLIT_RATIO_STORAGE_KEY);
    if (raw === null || !raw.trim()) return null;
    const ratio = Number(raw);
    return Number.isFinite(ratio) ? clampSplitRatio(ratio) : null;
  } catch {
    return null;
  }
}

export function restoreBrowserColumnSession<T extends BrowserColumnSessionState>(
  persisted: unknown,
  current: T,
): T {
  if (!isRecord(persisted)) {
    const legacySplitRatio = readLegacySplitRatio();
    return legacySplitRatio === null
      ? current
      : { ...current, splitRatio: legacySplitRatio };
  }

  // v5/v6 stored tab arrays; only their selected surface becomes current.
  const legacy = normalizePersistedTabs(persisted.tabs, persisted.activeTabId);
  const selected = legacy.find((entry) => entry.id === persisted.activeTabId) ?? legacy[0] ?? null;
  const currentEntry = 'current' in persisted ? normalizeHistory([persisted.current])[0] ?? null : selected;

  return {
    ...current,
    visible: currentEntry !== null && persisted.visible !== false,
    splitRatio: clampSplitRatio(
      typeof persisted.splitRatio === 'number'
        ? persisted.splitRatio
        : readLegacySplitRatio() ?? BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
    ),
    webRuntime: currentEntry?.target.kind === 'web'
      ? restoreWorkspaceWebRuntime(persisted.webRuntime) : null,
    current: currentEntry,
    backStack: normalizeHistory(persisted.backStack),
    forwardStack: normalizeHistory(persisted.forwardStack),
  };
}
