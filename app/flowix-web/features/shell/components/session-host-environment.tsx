import { createContext, useContext, type ReactNode } from 'react';
import type { WorkspaceSurfaceHost } from '@features/workspace/public/surface-api';

export interface SessionHostEnvironment {
  host: WorkspaceSurfaceHost;
  browserVisible: boolean;
  sidebarHidden: boolean;
  navigationVisible: boolean;
  onToggleSidebar: () => void;
}

const SessionHostContext = createContext<SessionHostEnvironment | null>(null);

export function SessionHostProvider({ value, children }: { value: SessionHostEnvironment; children: ReactNode }) {
  return <SessionHostContext.Provider value={value}>{children}</SessionHostContext.Provider>;
}

export function useSessionHostEnvironment() {
  return useContext(SessionHostContext);
}
