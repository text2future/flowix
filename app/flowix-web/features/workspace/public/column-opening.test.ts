import { beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { useWorkColumnStore } from '../store/work-column-store';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { openWorkspaceSurface as openAtIndex } from './open-surface-api';
import { openWorkspaceSurface as openInColumn } from './session-opening-api';
import type { OpenWorkspaceSurfaceRequest } from '../model/surface-opening';

const io = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../use-cases/surface-opening', () => ({ openWorkspaceSurface: io.open }));
const target = { kind: 'web' as const, url: 'https://example.com/' };

beforeEach(() => {
  useWorkspaceSessionStore.getState().reset();
  io.open.mockReset().mockImplementation(async (request: OpenWorkspaceSurfaceRequest) => {
    if (request.target.kind !== 'web') throw new Error('Expected a web target');
    useWorkspaceSessionStore.getState().commitTarget(request.host, request.target);
    return { status: 'opened', host: request.host };
  });
});

it('resolves both opening indices to the columns currently occupying them', async () => {
  useWorkspaceSessionStore.getState().swapColumnContents();
  await openAtIndex({ index: 0, target });
  expect(io.open).toHaveBeenLastCalledWith({ host: 'column-2', target });
  expect(useWorkspaceSessionStore.getState().browserLayout.visible).toBe(false);
  await openAtIndex({ index: 1, target });
  expect(io.open).toHaveBeenLastCalledWith({ host: 'column-1', target });
  expect(useWorkspaceSessionStore.getState().browserLayout.visible).toBe(true);
});

it('keeps an asynchronous open attached to the column captured before a swap', async () => {
  let finish!: () => void;
  io.open.mockImplementationOnce((request: OpenWorkspaceSurfaceRequest) => new Promise((resolve) => {
    finish = () => {
      if (request.target.kind !== 'web') throw new Error('Expected a web target');
      useWorkspaceSessionStore.getState().commitTarget(request.host, request.target);
      resolve({ status: 'opened', host: request.host });
    };
  }));
  const pending = openAtIndex({ index: 0, target });
  useWorkspaceSessionStore.getState().swapColumnContents();
  finish();
  await pending;
  const state = useWorkspaceSessionStore.getState();
  expect(state.sessions['column-1'].navigation.current?.target).toEqual(target);
  expect(state.sessions['column-2'].navigation.current).toBeNull();
  expect(state.placement[1]).toBe('column-1');
});

it('keeps column-local opening bound to the instance and reveals it when on the right', async () => {
  useWorkspaceSessionStore.getState().swapColumnContents();
  await openInColumn({ columnId: 'column-1', target });
  expect(io.open).toHaveBeenLastCalledWith({ host: 'column-1', target });
  expect(useWorkspaceSessionStore.getState().browserLayout.visible).toBe(true);
});

it('leaves both runtime snapshots and navigation entries intact when indices exchange', () => {
  const store = useWorkspaceSessionStore.getState();
  store.commitTarget('column-1', target);
  store.commitTarget('column-2', { ...target, url: 'https://other.example/' });
  const first = useWorkColumnStore.getState();
  const second = useBrowserColumnStore.getState();
  const columns = useWorkspaceSessionStore.getState().sessions;
  store.swapColumnContents();
  expect(useWorkColumnStore.getState()).toBe(first);
  expect(useBrowserColumnStore.getState()).toBe(second);
  expect(useWorkspaceSessionStore.getState().sessions).toBe(columns);
});
