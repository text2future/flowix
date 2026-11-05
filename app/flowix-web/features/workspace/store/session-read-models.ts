import { createStoreView } from '@shared/create-store-view';
import { sessionFor } from '../model/workspace-session';
import { useWorkspaceSessionStore, type WorkspaceSessionState } from './workspace-session-store';
import { projectWorkNavigation, projectBrowserSession } from './session-legacy-projections';
import type { WorkColumnNavigationState } from './work-column-target';
import type { BrowserColumnSessionState } from '../model/browser-column-session';
import type { WorkspaceWebRuntime } from '../model/surface-contract';

export function createWorkColumnView<T extends { navigation: WorkColumnNavigationState; notebookSwitchesInFlight: number }>(actions: T) {
  return createStoreView<T, WorkspaceSessionState>(useWorkspaceSessionStore, (root, previous) => ({ ...(previous ?? actions),
    navigation: projectWorkNavigation(sessionFor(root, 'column-1')),
    notebookSwitchesInFlight: sessionFor(root, 'column-1').notebookSwitchesInFlight,
  }));
}
export function createBrowserColumnView<T extends BrowserColumnSessionState & { webRuntime: WorkspaceWebRuntime | null }>(actions: T) {
  return createStoreView<T, WorkspaceSessionState>(useWorkspaceSessionStore, (root, previous) => ({ ...(previous ?? actions),
    ...projectBrowserSession(sessionFor(root, 'column-2')), ...root.browserLayout,
  }));
}
