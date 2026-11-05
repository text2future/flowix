import { create } from 'zustand';
import type { WorkspaceColumnId } from '@features/workspace/public/host-api';
import { useWorkspaceSessionStore } from './workspace-session-store';

export type { WorkspaceColumnId } from '@features/workspace/public/host-api';

interface WorkspaceFocusState {
  focusedColumnId: WorkspaceColumnId;
  focusColumn: (hostId: WorkspaceColumnId) => void;
  reset: () => void;
}

const leftColumn = () => useWorkspaceSessionStore.getState().placement[0];

export const useWorkspaceFocusStore = create<WorkspaceFocusState>((set) => ({
  focusedColumnId: leftColumn(),
  focusColumn: (columnId) => {
    const { placement, browserLayout } = useWorkspaceSessionStore.getState();
    // Restoring a hidden column must not take keyboard/edit focus from the visible one.
    const focusedColumnId = browserLayout.visible ? columnId : placement[0];
    set((state) => state.focusedColumnId === focusedColumnId ? state : { focusedColumnId });
  },
  reset: () => set({ focusedColumnId: leftColumn() }),
}));
