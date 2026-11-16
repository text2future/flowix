import { createStoreView } from '@shared/create-store-view';
import { sessionFor } from '../model/workspace-session';
import { useWorkspaceSessionStore, type WorkspaceSessionState } from './workspace-session-store';
import { projectMainColumnNavigation, projectBrowserSession } from './session-legacy-projections';
import type { MainColumnNavigationState } from './session-legacy-projections';
import type { BrowserColumnSessionState } from '../model/browser-column-session';
import type { WorkspaceWebRuntime } from '../model/surface-contract';

export function createMainColumnView<T extends { navigation: MainColumnNavigationState; notebookSwitchesInFlight: number }>(actions: T) {
  return createStoreView<T, WorkspaceSessionState>(useWorkspaceSessionStore, (root, previous) => ({ ...(previous ?? actions),
    navigation: projectMainColumnNavigation(sessionFor(root, 'column-1')),
    notebookSwitchesInFlight: sessionFor(root, 'column-1').notebookSwitchesInFlight,
  }));
}
export function createBrowserColumnView<T extends BrowserColumnSessionState & { webRuntime: WorkspaceWebRuntime | null }>(actions: T) {
  return createStoreView<T, WorkspaceSessionState>(useWorkspaceSessionStore, (root, previous) => ({ ...(previous ?? actions),
    ...projectBrowserSession(sessionFor(root, 'column-2')), ...root.browserLayout,
  }));
}
