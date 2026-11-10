import { canSwapSessions } from '../model/column-swap';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { useWorkspaceFocusStore } from '../store/workspace-focus-store';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';

export { openWorkspaceSurface } from './open-surface-api';
export type { OpenWorkspaceSurfaceRequest, BrowserWorkspaceSurfaceRequest } from './open-surface-api';
export { createFileBrowserTarget, removeBrowserColumnContentByPath, selectBrowserColumnFile, navigateBrowserColumnHistory } from '../use-cases/browser-column-navigation';
export { openBrowserColumnContentInWorkColumn } from '../use-cases/surface-opening';
export { BROWSER_COLUMN_MIN_WIDTH, canOpenBrowserColumnTargetInWorkColumn } from '../store/browser-column-store';
export type { BrowserColumnEntry, BrowserColumnTarget, BrowserColumnWebRuntime } from '../store/browser-column-store';
export { closeBrowserColumnContent, clearBrowserColumnSession } from '../use-cases/browser-column-closing';

export function useBrowserColumnViewModel() {
  return useBrowserColumnStore(useShallow((state) => ({
    current: state.current,
    webRuntime: state.webRuntime,
    canNavigateBack: state.backStack.length > 0,
    canNavigateForward: state.forwardStack.length > 0,
  })));
}

export function useBrowserColumnFocusViewModel() {
  const isFocused = useWorkspaceFocusStore((state) => state.focusedColumnId === 'column-2');
  const focusColumn = useWorkspaceFocusStore((state) => state.focusColumn);
  const focusBrowserColumn = useCallback(() => focusColumn('column-2'), [focusColumn]);
  return { isFocused, focusBrowserColumn };
}

export function hideBrowserColumn(): void {
  useBrowserColumnStore.getState().setVisible(false);
}

/** Drop a restored conversation target after its provisional instance is confirmed missing. */
export function clearMissingBrowserConversation(instanceId: string): boolean {
  return useBrowserColumnStore.getState().clearMissingConversation(instanceId);
}

export function useBrowserColumnVisible(): boolean {
  return useBrowserColumnStore((state) => state.visible);
}

export function toggleBrowserColumn(): void {
  const state = useBrowserColumnStore.getState();
  state.setVisible(!state.visible);
}

export { swapColumnContents } from '../use-cases/swap-column-contents';

/** Enabled when both sessions are idle, including when the second column is hidden. */
export function useCanSwapColumnContents(): boolean {
  return useWorkspaceSessionStore((state) => canSwapSessions(state.sessions));
}


/** Compatibility port for the secondary session renderer. */
export function browserSessionRuntime() {
  return useBrowserColumnStore.getState();
}
