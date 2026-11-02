import { createStoreFacade } from '@shared/create-store-facade';
import type { StoreApi, UseBoundStore } from 'zustand';
import { useWorkspaceSessionStore } from './workspace-session-store';
import { projectWorkNavigation, projectBrowserSession, fromBrowserEntry, projectDocumentStack, fromDocumentHistory } from './session-legacy-projections';
import { sessionTargetKey } from '../model/session-target-key';
import { emptySessionTransaction, type SessionCurrentEntry } from '../model/session-navigation';
import type { WorkspaceSession } from '../model/workspace-session';
import type { WorkColumnNavigationState } from './work-column-target';
import type { BrowserColumnSessionState } from '../model/browser-column-session';
import type { WorkspaceWebRuntime } from '../model/surface-contract';
import type { DocumentHistoryEntry } from '../model/legacy-document-history';
import { readLegacyPrimaryHistory } from './session-persistence';

type Initialize<T> = (set: (patch: Partial<T> | T | ((state: T) => Partial<T> | T)) => void, get: () => T) => T;

function currentFromWork(target: WorkColumnNavigationState['target'], previous: SessionCurrentEntry | null, requestedId?: string): SessionCurrentEntry | null {
  if (target.kind === 'empty') return null;
  if (previous?.target === target && (!requestedId || requestedId === previous.id)) return previous;
  const same = previous && sessionTargetKey(previous.target) === sessionTargetKey(target);
  return { id: requestedId ?? (same ? previous.id : 'surface:' + crypto.randomUUID()), target,
    title: same ? previous.title : '', icon: same ? previous.icon : null,
    openedAt: same ? previous.openedAt : Date.now() };
}

/** Old names are now projections/actions over the one session state source. */
export function createPrimaryNavigationFacade<T extends { navigation: WorkColumnNavigationState; notebookSwitchesInFlight: number }>(initialize: Initialize<T>) {
  return createStoreFacade(useWorkspaceSessionStore, initialize,
    (root, actions) => ({ ...actions, navigation: projectWorkNavigation(root.sessions['primary-session']),
      notebookSwitchesInFlight: root.sessions['primary-session'].notebookSwitchesInFlight }),
    (next, previous) => useWorkspaceSessionStore.getState().updateSession('primary-session', (session) => {
      if (next.navigation === previous.navigation && next.notebookSwitchesInFlight === previous.notebookSwitchesInFlight) return session;
      const { target, showWorkColumnLoading, ...legacyTransaction } = next.navigation;
      const transaction = { ...legacyTransaction, showBlockingLoading: showWorkColumnLoading };
      const requestedId = next.navigation.target !== previous.navigation.target && next.navigation.phase !== 'loading'
        ? session.navigation.transaction.entryId : undefined;
      const current = currentFromWork(target, session.navigation.current, requestedId);
      const legacyWeb = target.kind === 'web' ? session.viewStates[target.url] : null;
      const legacyHeader = target.kind === 'web' ? session.headerState[target.url] : null;
      return { ...session, notebookSwitchesInFlight: next.notebookSwitchesInFlight,
        viewStates: current && legacyWeb && !session.viewStates[current.id]
          ? { ...session.viewStates, [current.id]: legacyWeb } : session.viewStates,
        headerState: current && legacyHeader && !session.headerState[current.id]
          ? { ...session.headerState, [current.id]: legacyHeader } : session.headerState,
        navigation: next.navigation === previous.navigation ? session.navigation : {
          ...session.navigation, current, transaction: { ...transaction, entryId: session.navigation.transaction.entryId },
        } };
    }));
}

export function createSecondaryNavigationFacade<T extends BrowserColumnSessionState & { webRuntime: WorkspaceWebRuntime | null }>(initialize: Initialize<T>) {
  return createStoreFacade(useWorkspaceSessionStore, initialize,
    (root, actions) => ({ ...actions, ...projectBrowserSession(root.sessions['secondary-session']), ...root.browserLayout }),
    (next, previous) => useWorkspaceSessionStore.setState((root) => {
      const session = root.sessions['secondary-session'];
      const nav = session.navigation;
      const oldEntries = new Map([...(nav.current ? [nav.current] : []), ...nav.backStack, ...nav.forwardStack].map((entry) => [entry.id, entry]));
      const convert = (entry: NonNullable<BrowserColumnSessionState['current']>) => fromBrowserEntry(entry, oldEntries.get(entry.id));
      const current = next.current === previous.current ? nav.current : next.current ? convert(next.current) : null;
      const backStack = next.backStack === previous.backStack ? nav.backStack : next.backStack.map(convert);
      const forwardStack = next.forwardStack === previous.forwardStack ? nav.forwardStack : next.forwardStack.map(convert);
      const historyChanged = current !== nav.current || backStack !== nav.backStack || forwardStack !== nav.forwardStack;
      const runtimeChanged = next.webRuntime !== previous.webRuntime;
      const layoutChanged = next.visible !== previous.visible || next.splitRatio !== previous.splitRatio;
      if (!historyChanged && !runtimeChanged && !layoutChanged) return root;
      let viewStates = session.viewStates;
      if (current && (runtimeChanged || current !== nav.current)) {
        const replay = current.id !== nav.current?.id && oldEntries.has(current.id);
        const runtime = next.webRuntime ?? (replay ? session.viewStates[current.id]?.webRuntime ?? null : null);
        if (viewStates[current.id]?.webRuntime !== runtime) viewStates = {
          ...viewStates, [current.id]: { ...viewStates[current.id], webRuntime: runtime },
        };
      }
      const updated = !historyChanged && viewStates === session.viewStates ? session : {
        ...session, viewStates,
        navigation: historyChanged ? { current, backStack, forwardStack,
          transaction: { ...emptySessionTransaction(), requestId: nav.transaction.requestId + 1,
            phase: current ? 'committed' as const : 'idle' as const } } : nav,
      };
      return {
        sessions: updated === session ? root.sessions : { ...root.sessions, 'secondary-session': updated },
        browserLayout: layoutChanged ? { visible: next.visible, splitRatio: next.splitRatio } : root.browserLayout,
      };
    }));
}

export function createPrimaryHistoryFacade<T extends { backStack: DocumentHistoryEntry[]; forwardStack: DocumentHistoryEntry[] }>(initialize: Initialize<T>): UseBoundStore<StoreApi<T>> & { persist: { rehydrate: () => Promise<void> } } {
  const facade = createStoreFacade(useWorkspaceSessionStore, initialize,
    (root, actions) => ({ ...actions,
      backStack: projectDocumentStack(root.sessions['primary-session'].navigation.backStack),
      forwardStack: projectDocumentStack(root.sessions['primary-session'].navigation.forwardStack) }),
    (next, previous) => useWorkspaceSessionStore.getState().updateSession('primary-session', (session) => {
      if (next.backStack === previous.backStack && next.forwardStack === previous.forwardStack) return session;
      return { ...session, navigation: { ...session.navigation,
        backStack: next.backStack === previous.backStack ? session.navigation.backStack : next.backStack.map(fromDocumentHistory),
        forwardStack: next.forwardStack === previous.forwardStack ? session.navigation.forwardStack : next.forwardStack.map(fromDocumentHistory),
      } };
    }));
  return Object.assign(facade, { persist: { rehydrate: async () => {
    const history = readLegacyPrimaryHistory();
    facade.setState(history as Partial<T>);
  } } });
}

interface WebRuntimeProjection {
  runtimes: Record<string, WorkspaceWebRuntime>;
  setRuntime: (viewId: string, runtime: WorkspaceWebRuntime) => void;
}
const webSnapshots = new WeakMap<WorkspaceSession['viewStates'], Record<string, WorkspaceWebRuntime>>();
export function createPrimaryWebRuntimeFacade(initialize: Initialize<WebRuntimeProjection>) {
  return createStoreFacade(useWorkspaceSessionStore, initialize,
    (root, actions) => {
      const views = root.sessions['primary-session'].viewStates;
      let runtimes = webSnapshots.get(views);
      if (!runtimes) {
        runtimes = Object.fromEntries(Object.entries(views).flatMap(([id, state]) => state.webRuntime ? [[id, state.webRuntime]] : []));
        webSnapshots.set(views, runtimes);
      }
      return { ...actions, runtimes };
    },
    (next, previous) => useWorkspaceSessionStore.getState().updateSession('primary-session', (session) => {
      if (next.runtimes === previous.runtimes) return session;
      const current = session.navigation.current;
      const runtime = current ? next.runtimes[current.id] : null;
      const updateLocation = current?.target.kind === 'web' && runtime && current.target.url !== runtime.currentUrl;
      return { ...session,
        navigation: updateLocation ? { ...session.navigation, current: { ...current, target: { kind: 'web', url: runtime.currentUrl } } } : session.navigation,
        viewStates: Object.fromEntries([...Object.entries(session.viewStates).map(([id, state]) => [id, { ...state, webRuntime: next.runtimes[id] ?? null }]), ...Object.entries(next.runtimes).map(([id, webRuntime]) => [id, { ...session.viewStates[id], webRuntime }])]) };
    }));
}
