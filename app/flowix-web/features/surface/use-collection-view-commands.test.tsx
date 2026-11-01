import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useCollectionViewCommands } from './use-collection-view-commands';
import type { AddCollectionViewResult, FolderCollectionSummary } from '@features/collection/public/folder-api';
const io = vi.hoisted(() => ({ add: vi.fn(), rename: vi.fn(), remove: vi.fn() }));
vi.mock('@features/collection/public/folder-api', () => ({ addCollectionNoteView: io.add,
  renameCollectionView: io.rename, removeCollectionView: io.remove }));
let root: Root;
let api: ReturnType<typeof useCollectionViewCommands>;
const publish = vi.fn();
const summary = { collectionId: 'c1', domains: ['notes'], views: [] } as unknown as FolderCollectionSummary;
function Probe({ path = '/book/a.index.yaml', editable = true }: { path?: string; editable?: boolean }) {
  api = useCollectionViewCommands({ indexPath: path, notebookPath: '/book', currentFolderPath: null,
    folderName: '', editable, summary, onSummary: publish });
  return null;
}
afterEach(async () => { await act(async () => root?.unmount()); vi.clearAllMocks(); });
it('only one view command runs at a time; an old address cannot publish or select after navigation', async () => {
  let resolve!: (value: AddCollectionViewResult) => void;
  io.add.mockReturnValue(new Promise((done) => { resolve = done; }));
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
  let pending!: Promise<AddCollectionViewResult | null>;
  await act(async () => { pending = api.addNoteView('calendar'); });
  expect(api.busy).toBe(true);
  await act(async () => { expect(await api.renameView('v1', 'Renamed')).toBeNull(); });
  expect(io.rename).not.toHaveBeenCalled();
  await act(async () => root.render(<Probe path="/book/b.index.yaml" />));
  expect(api.busy).toBe(false);
  await act(async () => resolve({ summary, viewId: 'v2' }));
  expect(await pending).toBeNull();
  expect(publish).not.toHaveBeenCalled();
});
it('read-only collections reject all view commands without invoking file mutations', async () => {
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe editable={false} />));
  await act(async () => {
    expect(await api.addNoteView('table')).toBeNull();
    expect(await api.addAssetView('media')).toBeNull();
    expect(await api.renameView('v1', 'Renamed')).toBeNull();
    expect(await api.removeView('v1')).toBeNull();
  });
  expect(io.add).not.toHaveBeenCalled(); expect(io.rename).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
});
