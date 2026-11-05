import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => localStorage.clear());

it('initializes focus in the visible column after restoring a swapped single-column layout', async () => {
  localStorage.setItem('flowix.workspace.session-placement', JSON.stringify({
    version: 6,
    state: {
      placement: { 0: 'column-2', 1: 'column-1' },
      browserLayout: { visible: false },
    },
  }));
  const { useWorkspaceFocusStore } = await import('./workspace-focus-store');
  expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-2');
  useWorkspaceFocusStore.getState().focusColumn('column-1');
  expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-2');
});

it('resets focus to index zero in the current layout', async () => {
  const { useWorkspaceSessionStore } = await import('./workspace-session-store');
  const { useWorkspaceFocusStore } = await import('./workspace-focus-store');
  useWorkspaceSessionStore.getState().swapColumnContents();
  useWorkspaceSessionStore.getState().setBrowserLayout({ visible: false });
  useWorkspaceFocusStore.getState().reset();
  expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-2');
});

it('keeps explicit focus bound to the same instance when columns exchange positions', async () => {
  const { useWorkspaceSessionStore } = await import('./workspace-session-store');
  const { useWorkspaceFocusStore } = await import('./workspace-focus-store');
  useWorkspaceSessionStore.getState().setBrowserLayout({ visible: true });
  useWorkspaceFocusStore.getState().focusColumn('column-2');
  useWorkspaceSessionStore.getState().swapColumnContents();
  expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-2');
});
