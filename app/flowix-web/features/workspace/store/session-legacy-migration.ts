import { STORAGE_KEYS } from '@/lib/constants';
import { ensureCollectionDisplay } from '@/lib/collection-display-registry';
import { initialWorkspaceSessions } from '../model/workspace-session';
import { emptySessionTransaction } from '../model/session-navigation';
import { restoreWorkspaceWebRuntime } from '../model/web-navigation';
import type { DocumentHistoryEntry } from '../model/legacy-document-history';
import { BROWSER_COLUMN_DEFAULT_SPLIT_RATIO } from '../model/browser-column-layout';
import { restoreBrowserColumnSession } from './browser-column-persistence';
import { fromBrowserEntry, fromDocumentHistory } from './session-legacy-projections';
import { parseSessionTarget, record } from './session-persistence';

function readState(key: string): unknown {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return record(parsed) ? parsed.state : undefined;
  } catch { return undefined; }
}

function normalizeLegacyDocumentHistory(value: unknown): DocumentHistoryEntry[] {
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

function readLegacyPrimaryHistory() {
  const saved = readState('flowix.document-history.v1');
  return {
    backStack: normalizeLegacyDocumentHistory(record(saved) ? saved.backStack : undefined),
    forwardStack: normalizeLegacyDocumentHistory(record(saved) ? saved.forwardStack : undefined),
  };
}

/** Convert the retired browser and document stores into the canonical session shape. */
export function migrateLegacySessionData() {
  const sessions = initialWorkspaceSessions();
  const browser = restoreBrowserColumnSession<import('../model/browser-column-session').BrowserColumnSessionState>(
    readState(STORAGE_KEYS.BROWSER_COLUMN),
    { visible: false, splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, current: null, backStack: [], forwardStack: [] },
  );
  sessions['column-2'].navigation = {
    current: browser.current ? fromBrowserEntry(browser.current) : null,
    backStack: browser.backStack.map((entry) => fromBrowserEntry(entry)),
    forwardStack: browser.forwardStack.map((entry) => fromBrowserEntry(entry)),
    transaction: { ...emptySessionTransaction(), phase: browser.current ? 'committed' : 'idle' },
  };
  if (browser.current && browser.webRuntime) {
    sessions['column-2'].viewStates[browser.current.id] = { webRuntime: browser.webRuntime };
  }
  const oldRestore = readState(STORAGE_KEYS.WORKSPACE_RESTORE);
  const desired = record(oldRestore) ? parseSessionTarget(oldRestore.desiredTarget) : null;
  if (desired && desired.kind !== 'empty' && desired.kind !== 'collection-reference') {
    sessions['column-1'].navigation.current = {
      id: 'surface:' + crypto.randomUUID(),
      target: desired.kind === 'external' ? { ...desired, transitionId: null } : desired,
      title: '', icon: null, openedAt: 0,
    };
    sessions['column-1'].navigation.transaction.phase = 'committed';
  }
  const history = readLegacyPrimaryHistory();
  sessions['column-1'].navigation.backStack = history.backStack.map(fromDocumentHistory);
  sessions['column-1'].navigation.forwardStack = history.forwardStack.map(fromDocumentHistory);
  const web = readState('flowix.workspace.web-sessions');
  if (record(web) && record(web.runtimes)) {
    for (const [id, value] of Object.entries(web.runtimes).slice(-100)) {
      const runtime = restoreWorkspaceWebRuntime(value);
      if (runtime) sessions['column-1'].viewStates[id] = { webRuntime: runtime };
    }
  }
  const primary = sessions['column-1'];
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
