import { usePropertyPresetStore } from '@features/properties/property-preset-store';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { addCalendarDateView, createTableDocument, serializeTableDocument } from './model';
import { publishCollectionContent } from '@features/collection/public/content-events-api';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({
  externalDocuments: { read: mocks.read, write: mocks.write },
  notes: { list: vi.fn(async () => []) },
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('./parse-table-document', async () => {
  const { parseTableDocument } = await import('./model');
  return { parseTableDocumentAsync: async (source: string) => parseTableDocument(source) };
});
import { useTableSession } from './use-table-session';
beforeEach(() => usePropertyPresetStore.setState({ loaded: true, registry: { fields: [] } }));

it('reports external write failures, clears them for retry, and ignores stale session failures', async () => {
  const source = serializeTableDocument(createTableDocument());
  mocks.read.mockResolvedValue(source);
  mocks.write.mockImplementation(async ({ content }: { content: string }) => ({ status: 'saved', content }));
  let session!: ReturnType<typeof useTableSession>;
  function Probe() {
    session = useTableSession({ filePath: '/notebook/table.table.yaml', notebookPath: '/notebook', notebookId: 'nb' });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    expect(session.document).toBeTruthy();
    const sequence = session.loadSequenceRef.current;
    act(() => session.setSaving(true));
    const failedFlush = session.flush();
    let completed = false;
    void failedFlush.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    act(() => session.reportSaveFailure(sequence));
    act(() => session.setSaving(true));
    expect(session.saveFailed).toBe(true);
    act(() => session.setSaving(false));
    expect(session.saveFailed).toBe(true);
    expect(session.saving).toBe(false);
    await expect(failedFlush).resolves.toBe(false);
    await expect(session.flush()).resolves.toBe(false);

    act(() => session.setSaving(true));
    expect(session.saveFailed).toBe(false);
    expect(session.saving).toBe(true);
    act(() => session.setSaving(false));
    await act(async () => { expect(await session.save(session.document!)).toBe(true); });
    expect(session.saveFailed).toBe(false);
    expect(session.saving).toBe(false);
    await expect(session.flush()).resolves.toBe(true);

    await act(async () => session.load());
    act(() => session.reportSaveFailure(sequence));
    expect(session.saveFailed).toBe(false);
    act(() => session.reportSaveFailure(session.loadSequenceRef.current));
    expect(session.saveFailed).toBe(true);
  } finally { act(() => root.unmount()); }
});

it('retains data and pending writes across views, but reloads for another collection', async () => {
  mocks.read.mockClear();
  mocks.read.mockResolvedValue(serializeTableDocument(createTableDocument()));
  let session!: ReturnType<typeof useTableSession>;
  function Probe({ displayId, collectionId }: { displayId: string; collectionId: string }) {
    session = useTableSession({ filePath: '/notebook/table.table.yaml', fileIdentity: { path: '/notebook/table.table.yaml', displayId }, notebookPath: '/notebook', notebookId: 'nb', expectedCollectionId: collectionId });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe displayId="table-view" collectionId="collection-a" />));
    const loaded = session.document;
    const generation = session.loadSequenceRef.current;
    act(() => session.setSaving(true));
    await act(async () => root.render(<Probe displayId="gallery-view" collectionId="collection-a" />));
    expect(session.document).toBe(loaded);
    expect(session.loadSequenceRef.current).toBe(generation);
    expect(session.saving).toBe(true);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    act(() => session.reportSaveFailure(generation));
    expect(session.saveFailed).toBe(true);
    const previousFlush = session.flush();
    await act(async () => root.render(<Probe displayId="other-view" collectionId="collection-b" />));
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(session.loadSequenceRef.current).toBeGreaterThan(generation);
    expect(session.saveFailed).toBe(false);
    await expect(previousFlush).resolves.toBe(false);
    await expect(session.flush()).resolves.toBe(true);
  } finally { act(() => root.unmount()); }
});

it('adopts a view added by another entry without waiting for a reload', async () => {
  const original = createTableDocument();
  mocks.read.mockResolvedValue(serializeTableDocument(original));
  let session!: ReturnType<typeof useTableSession>;
  function Probe() {
    session = useTableSession({ filePath: '/notebook/collection.index.yaml', notebookPath: '/notebook', notebookId: 'nb' });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    const readsBefore = mocks.read.mock.calls.length;
    const added = addCalendarDateView(original);
    const nextSource = serializeTableDocument(added.document);

    // 外壳（tab 条「···」→ 日历）写盘后广播内容：文档立刻跟上，不重读、不等刷新。
    await act(async () => {
      publishCollectionContent({ indexPath: '/notebook/collection.index.yaml', notebookPath: '/notebook', content: nextSource });
    });

    expect(session.document?.views.items.some((view) => view.id === added.view.id)).toBe(true);
    expect(mocks.read.mock.calls.length).toBe(readsBefore);
  } finally { act(() => root.unmount()); }
});

it('ignores broadcasts for another collection file', async () => {
  const original = createTableDocument();
  mocks.read.mockResolvedValue(serializeTableDocument(original));
  let session!: ReturnType<typeof useTableSession>;
  function Probe() {
    session = useTableSession({ filePath: '/notebook/collection.index.yaml', notebookPath: '/notebook', notebookId: 'nb' });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    const loaded = session.document;
    const added = addCalendarDateView(original);
    await act(async () => {
      publishCollectionContent({
        indexPath: '/notebook/other.index.yaml', notebookPath: '/notebook',
        content: serializeTableDocument(added.document),
      });
    });
    expect(session.document).toBe(loaded);
  } finally { act(() => root.unmount()); }
});
