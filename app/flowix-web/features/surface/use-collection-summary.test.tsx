import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useCollectionSummary } from './use-collection-summary';
import type { FolderCollectionSummary } from '@features/collection/public/folder-api';
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
