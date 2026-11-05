import { createContext, useContext, type ReactNode } from 'react';

export interface ColumnEnvironment {
  index: 0 | 1;
  browserVisible: boolean;
  sidebarHidden: boolean;
  navigationVisible: boolean;
  onToggleSidebar: () => void;
}

const SessionHostContext = createContext<ColumnEnvironment | null>(null);

export function ColumnProvider({ value, children }: { value: ColumnEnvironment; children: ReactNode }) {
  return <SessionHostContext.Provider value={value}>{children}</SessionHostContext.Provider>;
}

export function useColumnEnvironment() {
  return useContext(SessionHostContext);
}
