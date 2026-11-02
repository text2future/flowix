import type { BrowserColumnTarget } from './browser-column-target';

export interface BrowserColumnEntry {
  id: string;
  title: string;
  icon: string | null;
  target: BrowserColumnTarget;
}

export interface BrowserColumnSessionState {
  webRuntime?: import('./surface-contract').WorkspaceWebRuntime | null;
  visible: boolean;
  splitRatio: number;
  current: BrowserColumnEntry | null;
  backStack: BrowserColumnEntry[];
  forwardStack: BrowserColumnEntry[];
}
