import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useCollectionSummary } from './use-collection-summary';
import type { FolderCollectionSummary } from '@features/collection/public/folder-api';
import { publishLocalCollectionChange, type LocalCollectionChange } from '@features/collection/events';
const io = vi.hoisted(() => ({ read: vi.fn(), events: new Set<(event: unknown) => void>() }));
vi.mock('@features/collection/public/folder-api', () => ({ readCollectionSummary: io.read }));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: (_: string, handler: (event: unknown) => void) => {
  io.events.add(handler); return () => io.events.delete(handler);
} }));
const summary = (revision: number) => ({ collectionId: 'c1', revision, views: [] } as unknown as FolderCollectionSummary);
let root: Root;
let node: HTMLDivElement;
function Probe({ id, path = '/book/a.index.yaml' }: { id: string; path?: string }) {
  const [snapshot] = useCollectionSummary(path, '/book', 'book');
  return <span data-id={id}>{snapshot && snapshot !== 'missing' ? snapshot.revision : String(snapshot)}</span>;
}
afterEach(async () => { await act(async () => root?.unmount()); node?.remove(); io.read.mockReset(); });
async function render(children: React.ReactNode) {
  node = document.createElement('div'); root = createRoot(node);
  await act(async () => root.render(children));
}
it('two hosts share one subscription and refresh together on collection changes', async () => {
  io.read.mockResolvedValue(summary(1));
  await render(<><Probe id="main" /><Probe id="browser" /></>);
  expect(io.read).toHaveBeenCalledTimes(1);
  expect(io.events.size).toBe(1);
  io.read.mockResolvedValue(summary(2));
  await act(async () => { for (const handler of io.events) handler({ notebookId: 'book', collectionId: 'c1' }); });
  expect(node.textContent).toBe('22');
  await act(async () => root.unmount());
  expect(io.events.size).toBe(0);
});
it('an older read cannot overwrite the latest refresh, and unrelated events do not refresh', async () => {
  let resolveOld!: (value: FolderCollectionSummary) => void;
  io.read.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue(summary(3));
  await render(<Probe id="main" />);
  await act(async () => { for (const handler of io.events) handler({ notebookId: 'other', collectionId: 'c1' }); });
  expect(io.read).toHaveBeenCalledTimes(1);
  await act(async () => { for (const handler of io.events) handler({ notebookId: 'book', relativePath: 'a.index.yaml', collectionId: 'c1' }); });
  expect(node.textContent).toBe('3');
  await act(async () => resolveOld(summary(1)));
  expect(node.textContent).toBe('3');
});
it('changing collection addresses ignores a pending response from the previous address', async () => {
  let resolveOld!: (value: FolderCollectionSummary) => void;
  io.read.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue(summary(9));
  await render(<Probe id="main" />);
  await act(async () => root.render(<Probe id="main" path="/book/b.index.yaml" />));
  await act(async () => resolveOld(summary(1)));
  expect(node.textContent).toBe('9');
});

it('keeps the loaded summary during a local rename while revalidating the new address', async () => {
  io.read.mockResolvedValue(summary(1));
  await render(<Probe id="main" />);
  let finishRead!: (value: FolderCollectionSummary) => void;
  io.read.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
  publishLocalCollectionChange({
    notebookId: 'book', previousPath: '/book/a.index.yaml',
    item: { collectionId: 'c1', relativePath: 'renamed.index.yaml' },
  } as LocalCollectionChange);
  await act(async () => root.render(<Probe id="main" path="/book/renamed.index.yaml" />));
  expect(node.textContent).toBe('1');
  await act(async () => finishRead(summary(2)));
  expect(node.textContent).toBe('2');
});

it('releases a renamed cache when its last owner closes without following the new address', async () => {
  io.read.mockResolvedValue(summary(1));
  await render(<Probe id="main" />);
  io.read.mockReturnValue(new Promise(() => {}));
  publishLocalCollectionChange({ notebookId: 'book', previousPath: '/book/a.index.yaml',
    item: { collectionId: 'c1', relativePath: 'unvisited.index.yaml' },
  } as LocalCollectionChange);
  await act(async () => root.render(null));
  expect(io.events.size).toBe(0);
  await act(async () => root.render(<Probe id="main" path="/book/unvisited.index.yaml" />));
  expect(node.textContent).toBe('null');
});

it('follows a desktop rename event before the local mutation response and ignores the old read', async () => {
  io.read.mockResolvedValue(summary(1));
  await render(<Probe id="main" />);
  let finishOld!: (value: FolderCollectionSummary | null) => void;
  io.read.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  await act(async () => { for (const handler of io.events) handler({ notebookId: 'book', collectionId: 'c1' }); });
  io.read.mockResolvedValue(summary(2));
  await act(async () => { for (const handler of io.events) handler({ notebookId: 'book', collectionId: 'c1', relativePath: 'desktop-renamed.index.yaml', revision: 2 }); });
  expect(io.read.mock.lastCall).toEqual(['/book/desktop-renamed.index.yaml', '/book']);
  await act(async () => finishOld(null));
  expect(node.textContent).toBe('2');
  const reads = io.read.mock.calls.length;
  await act(async () => { for (const handler of io.events) handler({ notebookId: 'book', collectionId: 'c1', relativePath: 'a.index.yaml', revision: 1 }); });
  expect(io.read).toHaveBeenCalledTimes(reads);
  await act(async () => root.render(<Probe id="main" path="/book/desktop-renamed.index.yaml" />));
  expect(node.textContent).toBe('2');
});
