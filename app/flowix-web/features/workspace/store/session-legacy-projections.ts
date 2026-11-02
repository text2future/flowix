import { ensureCollectionDisplay, findCollectionDisplayPath } from '@/lib/collection-display-registry';
import type { DocumentHistoryEntry } from '../model/legacy-document-history';
import type { BrowserColumnEntry, BrowserColumnSessionState } from '../model/browser-column-session';
import type { BrowserColumnTarget } from '../model/browser-column-target';
import type { SessionNavigationEntry, SessionCurrentEntry } from '../model/session-navigation';
import type { WorkspaceSurfaceOpenTarget } from '../model/surface-target';
import type { WorkColumnNavigationState } from './work-column-target';
import { EMPTY_WORK_COLUMN_TARGET } from './work-column-target';
import type { WorkspaceSession } from '../model/workspace-session';

const documentToSession = new WeakMap<object, SessionNavigationEntry>();
const sessionToDocument = new WeakMap<object, DocumentHistoryEntry>();
const browserTargetOrigins = new WeakMap<object, SessionCurrentEntry['target']>();
const browserToSession = new WeakMap<object, SessionCurrentEntry>();
const sessionToBrowser = new WeakMap<object, BrowserColumnEntry>();
const browserStacks = new WeakMap<object, BrowserColumnEntry[]>();
const documentStacks = new WeakMap<object, DocumentHistoryEntry[]>();
const transactions = new WeakMap<object, WeakMap<object, WorkColumnNavigationState>>();

export function fromDocumentHistory(entry: DocumentHistoryEntry): SessionNavigationEntry {
  const cached = documentToSession.get(entry);
  if (cached) return cached;
  let target: WorkspaceSurfaceOpenTarget;
  switch (entry.kind) {
    case 'collection': target = { ...entry, kind: 'collection-reference' }; break;
    case 'folder-collection': target = { ...entry, notebookPath: '', folderName: entry.folderPath.split('/').pop() ?? '' }; break;
    case 'document-list': target = {
      kind: 'folder-collection', notebookId: entry.scope.notebookId ?? '', notebookPath: entry.scope.notebookPath,
      folderPath: entry.scope.path, folderName: entry.scope.path.split('/').pop() ?? '',
    }; break;
    default: target = entry;
  }
  const canonicalTarget = Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'openedAt')) as WorkspaceSurfaceOpenTarget;
  const value = { id: crypto.randomUUID(), target: canonicalTarget, title: '', icon: null, openedAt: entry.openedAt };
  documentToSession.set(entry, value);
  sessionToDocument.set(value, entry);
  return value;
}

export function toDocumentHistory(entry: SessionNavigationEntry): DocumentHistoryEntry {
  const cached = sessionToDocument.get(entry);
  if (cached) return cached;
  const target = entry.target;
  let value: DocumentHistoryEntry;
  switch (target.kind) {
    case 'collection-reference': value = {
      kind: 'collection', notebookId: target.notebookId, collectionId: target.collectionId,
      displayId: target.displayId ?? '', viewId: target.viewId ?? null,
      ...(target.relativePathHint ? { relativePathHint: target.relativePathHint } : {}), openedAt: entry.openedAt,
    }; break;
    case 'collection': value = { kind: 'collection', notebookId: target.notebookId, collectionId: target.collectionId,
      displayId: target.displayId, viewId: target.viewId, openedAt: entry.openedAt }; break;
    case 'folder-collection': value = { kind: 'folder-collection', notebookId: target.notebookId,
      folderPath: target.folderPath, openedAt: entry.openedAt }; break;
    case 'external': value = { kind: 'external', path: target.path, scopePath: target.scopePath, openedAt: entry.openedAt }; break;
    case 'table': case 'media-library': value = { kind: 'external', path: target.filePath, scopePath: target.notebookPath, openedAt: entry.openedAt }; break;
    case 'plugin-workbench': case 'empty':
      // These did not exist in the old document-history API; new code consumes the canonical entry.
      value = { kind: 'external', path: '', scopePath: null, openedAt: entry.openedAt }; break;
    default: value = { ...target, openedAt: entry.openedAt };
  }
  sessionToDocument.set(entry, value);
  documentToSession.set(value, entry);
  return value;
}

export function projectDocumentStack(stack: readonly SessionNavigationEntry[]): DocumentHistoryEntry[] {
  let value = documentStacks.get(stack);
  if (!value) { value = stack.map(toDocumentHistory); documentStacks.set(stack, value); }
  return value;
}

function toCanonicalBrowserTarget(target: BrowserColumnTarget): SessionCurrentEntry['target'] {
  const origin = browserTargetOrigins.get(target);
  if (origin) return origin;
  return target.kind === 'agent_conversation' ? { kind: 'agent-conversation', instanceId: target.instanceId } : target;
}

export function fromBrowserEntry(entry: BrowserColumnEntry, previous?: SessionNavigationEntry): SessionCurrentEntry {
  const cached = browserToSession.get(entry);
  if (cached) return cached;
  const value: SessionCurrentEntry = {
    ...entry, target: toCanonicalBrowserTarget(entry.target), openedAt: previous?.openedAt ?? Date.now(),
  };
  browserToSession.set(entry, value);
  sessionToBrowser.set(value, entry);
  return value;
}

export function toBrowserEntry(entry: SessionNavigationEntry): BrowserColumnEntry {
  const cached = sessionToBrowser.get(entry);
  if (cached) return cached;
  const target = entry.target;
  let browserTarget: BrowserColumnTarget;
  switch (target.kind) {
    case 'agent-conversation': browserTarget = { kind: 'agent_conversation', instanceId: target.instanceId }; break;
    case 'external': browserTarget = {
      kind: 'file-browser', activeFilePath: target.path, folderPath: null,
      notebookId: null, scopePath: target.scopePath, fileTreeVisible: true, fileTreeWidth: 220, ...target.fileBrowser,
    }; break;
    case 'table': case 'media-library': case 'collection': browserTarget = {
      kind: 'file-browser', activeFilePath: target.filePath, folderPath: null,
      notebookId: target.notebookId, scopePath: target.notebookPath, fileTreeVisible: true, fileTreeWidth: 220,
      ...(target.kind === 'collection' ? { collectionDisplay: target, collectionType: target.collectionType }
        : target.kind === 'media-library' ? { collectionType: 'media_library' as const } : { collectionType: 'table' as const }),
    }; break;
    case 'collection-reference': {
      const display = ensureCollectionDisplay({
        notebookId: target.notebookId, collectionId: target.collectionId, viewId: target.viewId ?? null,
      }, target.displayId);
      browserTarget = {
        kind: 'file-browser', activeFilePath: target.filePath ?? findCollectionDisplayPath(display.displayId),
        folderPath: null, notebookId: target.notebookId, scopePath: null, fileTreeVisible: true, fileTreeWidth: 220,
        collectionDisplay: display, collectionType: target.collectionKind,
      };
      break;
    }
    case 'empty': throw new Error('Empty is a session state, not a history entry');
    default: browserTarget = target;
  }
  if (target.kind !== 'collection-reference') browserTargetOrigins.set(browserTarget, target.kind === 'external' ? { ...target, transitionId: target.transitionId ?? null } : target);
  const value = { id: entry.id, title: entry.title, icon: entry.icon, target: browserTarget };
  sessionToBrowser.set(entry, value);
  if (target.kind !== 'collection-reference' && (target.kind !== 'external' || target.transitionId !== undefined)) {
    browserToSession.set(value, entry as SessionCurrentEntry);
  }
  return value;
}

export function projectBrowserStack(stack: readonly SessionNavigationEntry[]): BrowserColumnEntry[] {
  let value = browserStacks.get(stack);
  if (!value) { value = stack.map(toBrowserEntry); browserStacks.set(stack, value); }
  return value;
}

export function projectWorkNavigation(session: WorkspaceSession): WorkColumnNavigationState {
  const navigation = session.navigation;
  let targets = transactions.get(navigation.transaction);
  if (!targets) { targets = new WeakMap(); transactions.set(navigation.transaction, targets); }
  const target = navigation.current?.target ?? EMPTY_WORK_COLUMN_TARGET;
  let value = targets.get(target);
  if (!value) {
    const { showBlockingLoading, ...transaction } = navigation.transaction;
    value = { ...transaction, target, showWorkColumnLoading: showBlockingLoading };
    targets.set(target, value);
  }
  return value;
}

export function projectBrowserSession(session: WorkspaceSession): Pick<BrowserColumnSessionState, 'current' | 'backStack' | 'forwardStack' | 'webRuntime'> {
  const navigation = session.navigation;
  return {
    current: navigation.current ? toBrowserEntry(navigation.current) : null,
    backStack: projectBrowserStack(navigation.backStack),
    forwardStack: projectBrowserStack(navigation.forwardStack),
    webRuntime: navigation.current ? session.viewStates[navigation.current.id]?.webRuntime ?? null : null,
  };
}
