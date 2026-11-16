import type { SessionSurfaceTarget } from './session-target';

/**
 * The browser column renders a projected subset of session targets: files,
 * collections and web pages arrive wrapped in a file browser view.
 */
export type BrowserViewTarget = Extract<SessionSurfaceTarget, {
  kind: 'file-browser' | 'media' | 'web' | 'folder-collection' | 'plugin-workbench' | 'agent-conversation'
}>;

export interface BrowserColumnEntry {
  id: string;
  title: string;
  icon: string | null;
  target: BrowserViewTarget;
}

export interface BrowserColumnSessionState {
  webRuntime?: import('./surface-contract').WorkspaceWebRuntime | null;
  visible: boolean;
  splitRatio: number;
  current: BrowserColumnEntry | null;
  backStack: BrowserColumnEntry[];
  forwardStack: BrowserColumnEntry[];
}
