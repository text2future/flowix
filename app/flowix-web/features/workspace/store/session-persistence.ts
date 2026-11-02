import { restoreViewRecovery } from '../model/session-view-state';
import { STORAGE_KEYS } from '@/lib/constants';
import { ensureCollectionDisplay } from '@/lib/collection-display-registry';
import { initialWorkspaceSessions, type WorkspaceSession } from '../model/workspace-session';
import { emptySessionTransaction, type SessionNavigationEntry, type SessionCurrentEntry } from '../model/session-navigation';
import { restoreWorkspaceWebRuntime } from '../model/web-navigation';
import type { WorkspaceSurfaceOpenTarget } from '../model/surface-target';
import type { DocumentHistoryEntry } from '../model/legacy-document-history';
import { restoreBrowserColumnSession } from './browser-column-persistence';
import { fromBrowserEntry, fromDocumentHistory } from './session-legacy-projections';
import { BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, clampSplitRatio } from '../model/browser-column-layout';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readState(key: string): unknown {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return record(parsed) ? parsed.state : undefined;
  } catch { return undefined; }
}

export function parseSessionTarget(value: unknown): WorkspaceSurfaceOpenTarget | null {
  if (!record(value)) return null;
  const text = (key: string) => typeof value[key] === 'string' && Boolean(value[key]);
  switch (value.kind) {
    case 'empty': return { kind: 'empty' };
    case 'web': if (!text('url')) return null; break;
    case 'external': if (!text('path')) return null; break;
    case 'agent-conversation': if (!text('instanceId')) return null; break;
    case 'file-browser':
      if (!(text('folderPath') || text('activeFilePath')) || typeof value.fileTreeVisible !== 'boolean'
        || typeof value.fileTreeWidth !== 'number') return null;
      break;
    case 'folder-collection': if (!text('notebookId') || !text('folderPath')) return null; break;
    case 'media': if (!text('filePath') || (value.resourceKind !== 'image' && value.resourceKind !== 'video')) return null; break;
    case 'table': case 'media-library': if (!text('filePath')) return null; break;
    case 'collection':
      if (!text('notebookId') || !text('collectionId') || !text('displayId') || !text('filePath')
        || !text('notebookPath') || !['table', 'media_library', 'work_documents'].includes(String(value.collectionType))) return null;
      break;
    case 'collection-reference': if (!text('notebookId') || !text('collectionId')) return null; break;
    case 'plugin-workbench':
      if (!record(value.plugin) || !record(value.plugin.manifest)
        || typeof value.plugin.manifest.id !== 'string' || typeof value.plugin.manifest.name !== 'string') return null;
      break;
    default: return null;
  }
  // Serialized targets are the sole legacy/JSON boundary. Runtime handlers are never deserialized.
  return value as unknown as WorkspaceSurfaceOpenTarget;
}

export function normalizeLegacyDocumentHistory(value: unknown): DocumentHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const result: DocumentHistoryEntry[] = [];
  const keys: string[] = [];
  for (const candidate of value) {
    if (!record(candidate) || typeof candidate.openedAt !== 'number') continue;
    let entry: DocumentHistoryEntry;
    let key: string;
    if (candidate.kind === 'collection' && typeof candidate.notebookId === 'string'
      && typeof candidate.collectionId === 'string' && typeof candidate.displayId === 'string') {
      const display = ensureCollectionDisplay({ notebookId: candidate.notebookId, collectionId: candidate.collectionId,
        viewId: typeof candidate.viewId === 'string' ? candidate.viewId : null }, candidate.displayId);
      entry = { ...candidate, kind: 'collection', ...display, openedAt: candidate.openedAt };
      key = display.displayId;
    } else if (candidate.kind === 'document-list' && record(candidate.scope) && typeof candidate.scope.path === 'string') {
      entry = candidate as unknown as DocumentHistoryEntry;
      key = String(candidate.displayId);
    } else {
      if (!parseSessionTarget(candidate)) continue;
      entry = candidate as unknown as DocumentHistoryEntry;
      key = JSON.stringify([candidate.kind, candidate.path ?? candidate.filePath ?? candidate.folderPath ?? candidate.instanceId ?? candidate.url]);
    }
    if (keys[keys.length - 1] === key) result[result.length - 1] = entry;
    else { keys.push(key); result.push(entry); }
  }
  return result.slice(-100);
}

export function readLegacyPrimaryHistory() {
  const saved = readState('flowix.document-history.v1');
  return {
    backStack: normalizeLegacyDocumentHistory(record(saved) ? saved.backStack : undefined),
    forwardStack: normalizeLegacyDocumentHistory(record(saved) ? saved.forwardStack : undefined),
  };
}

export function migrateLegacySessionData() {
  const sessions = initialWorkspaceSessions();
  const browser = restoreBrowserColumnSession<import('../model/browser-column-session').BrowserColumnSessionState>(readState(STORAGE_KEYS.BROWSER_COLUMN), {
    visible: false, splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, current: null, backStack: [], forwardStack: [],
  });
  sessions['secondary-session'].navigation = {
    current: browser.current ? fromBrowserEntry(browser.current) : null,
    backStack: browser.backStack.map((entry) => fromBrowserEntry(entry)),
    forwardStack: browser.forwardStack.map((entry) => fromBrowserEntry(entry)),
    transaction: { ...emptySessionTransaction(), phase: browser.current ? 'committed' : 'idle' },
  };
  if (browser.current && browser.webRuntime) {
    sessions['secondary-session'].viewStates[browser.current.id] = { webRuntime: browser.webRuntime };
  }
  const oldRestore = readState(STORAGE_KEYS.WORKSPACE_RESTORE);
  const desired = record(oldRestore) ? parseSessionTarget(oldRestore.desiredTarget) : null;
  if (desired && desired.kind !== 'empty' && desired.kind !== 'collection-reference') {
    sessions['primary-session'].navigation.current = {
      id: 'surface:' + crypto.randomUUID(),
      target: desired.kind === 'external' ? { ...desired, transitionId: null } : desired,
      title: '', icon: null, openedAt: 0,
    };
    sessions['primary-session'].navigation.transaction.phase = 'committed';
  }
  const history = readLegacyPrimaryHistory();
  sessions['primary-session'].navigation.backStack = history.backStack.map(fromDocumentHistory);
  sessions['primary-session'].navigation.forwardStack = history.forwardStack.map(fromDocumentHistory);
  const web = readState('flowix.workspace.web-sessions');
  if (record(web) && record(web.runtimes)) {
    for (const [id, value] of Object.entries(web.runtimes).slice(-100)) {
      const runtime = restoreWorkspaceWebRuntime(value);
      if (runtime) sessions['primary-session'].viewStates[id] = { webRuntime: runtime };
    }
  }
  const primary = sessions['primary-session'];
  const current = primary.navigation.current;
  if (current?.target.kind === 'web') {
    const runtime = primary.viewStates[current.target.url]?.webRuntime;
    if (runtime) {
      primary.viewStates[current.id] = { webRuntime: runtime };
      primary.navigation.current = { ...current, target: { kind: 'web', url: runtime.currentUrl } };
    }
  }
  return { sessions, browserLayout: { visible: browser.visible, splitRatio: browser.splitRatio } };
}

function parseEntry(value: unknown): SessionNavigationEntry | null {
  if (!record(value) || typeof value.id !== 'string' || !value.id) return null;
  const target = parseSessionTarget(value.target);
  if (!target || target.kind === 'empty') return null;
  return { id: value.id, target, title: typeof value.title === 'string' ? value.title : '',
    icon: typeof value.icon === 'string' ? value.icon : null,
    openedAt: typeof value.openedAt === 'number' ? value.openedAt : 0 };
}

export function restoreCanonicalSession(value: unknown, fallback: WorkspaceSession): WorkspaceSession {
  if (!record(value)) return fallback;
  let navigation = fallback.navigation;
  if ('navigation' in value) {
    const saved = record(value.navigation) ? value.navigation : {};
    const parsed = parseEntry(saved.current);
    const current: SessionCurrentEntry | null = parsed && parsed.target.kind !== 'collection-reference'
      ? { ...parsed, target: parsed.target.kind === 'external'
        ? { ...parsed.target, transitionId: null } : parsed.target } : null;
    const stack = (items: unknown) => Array.isArray(items)
      ? items.flatMap((entry) => { const next = parseEntry(entry); return next ? [next] : []; }).slice(-100) : [];
    navigation = { current, backStack: stack(saved.backStack), forwardStack: stack(saved.forwardStack),
      transaction: { ...emptySessionTransaction(), phase: current ? 'committed' : 'idle' } };
  }
  const headerState: WorkspaceSession['headerState'] = {};
  if (record(value.headerState)) {
    for (const [key, state] of Object.entries(value.headerState).slice(-200)) {
      if (record(state) && typeof state.addressBarVisible === 'boolean') {
        Object.defineProperty(headerState, key, { enumerable: true, value: { addressBarVisible: state.addressBarVisible } });
      }
    }
  }
  const current = navigation.current;
  if (current && !headerState[current.id]) {
    const activeRuntime = fallback.viewStates[current.id]?.webRuntime;
    const key = Object.keys(headerState).find((id) => activeRuntime && fallback.viewStates[id]?.webRuntime === activeRuntime);
    if (key) headerState[current.id] = headerState[key];
  }
  const viewStates: WorkspaceSession['viewStates'] = {};
  if (record(value.viewStates)) {
    for (const [key, state] of Object.entries(value.viewStates).slice(-200)) {
      const runtime = record(state) ? restoreWorkspaceWebRuntime(state.webRuntime) : null;
      const recovery = record(state) ? restoreViewRecovery(state.recovery) : undefined;
      if (runtime || recovery) Object.defineProperty(viewStates, key, { enumerable: true, value: { ...(runtime ? { webRuntime: runtime } : {}), ...(recovery ? { recovery } : {}) } });
    }
  }
  return { ...fallback, navigation, headerState,
    viewStates: 'viewStates' in value ? viewStates : fallback.viewStates, notebookSwitchesInFlight: 0 };
}

export function restoreBrowserLayout(value: unknown, fallback: { visible: boolean; splitRatio: number }) {
  return record(value) ? {
    visible: typeof value.visible === 'boolean' ? value.visible : fallback.visible,
    splitRatio: typeof value.splitRatio === 'number' ? clampSplitRatio(value.splitRatio) : fallback.splitRatio,
  } : fallback;
}
