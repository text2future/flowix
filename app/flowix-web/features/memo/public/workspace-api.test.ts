import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setCurrent: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ notebooks: { setCurrent: mocks.setCurrent } }));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: Object.assign(vi.fn(), { getState: vi.fn() }),
}));

import { getLastPersistedWorkspaceNotebookId, needsWorkspaceNotebookPersistence, setCurrentWorkspaceNotebook } from './workspace-api';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  mocks.setCurrent.mockReset();
});

it('serializes a return-to-origin request behind an in-flight native notebook change', async () => {
  const first = deferred();
  const second = deferred();
  mocks.setCurrent.mockImplementation((notebookId: string | null) => {
    if (notebookId === 'notebook-a') return first.promise;
    if (notebookId === 'notebook-original') return second.promise;
    return Promise.resolve();
  });

  const switchToA = setCurrentWorkspaceNotebook('notebook-a');
  await vi.waitFor(() => expect(mocks.setCurrent).toHaveBeenCalledTimes(1));
  expect(needsWorkspaceNotebookPersistence('notebook-original')).toBe(true);
  const returnToOriginal = setCurrentWorkspaceNotebook('notebook-original');
  expect(mocks.setCurrent.mock.calls.map(([id]) => id)).toEqual(['notebook-a']);

  first.resolve();
  await switchToA;
  await vi.waitFor(() => expect(mocks.setCurrent).toHaveBeenCalledTimes(2));
  expect(mocks.setCurrent.mock.calls.map(([id]) => id)).toEqual(['notebook-a', 'notebook-original']);

  second.resolve();
  await returnToOriginal;
  expect(getLastPersistedWorkspaceNotebookId()).toBe('notebook-original');
  expect(needsWorkspaceNotebookPersistence('notebook-original')).toBe(false);
});
