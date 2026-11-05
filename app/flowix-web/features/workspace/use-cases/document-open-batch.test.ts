import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(), importFile: vi.fn(), selectFiles: vi.fn(), resolveContext: vi.fn(), resolveLocation: vi.fn(),
}));
vi.mock('@platform/tauri/client', () => ({
  files: { importFile: mocks.importFile, resolveLocation: mocks.resolveLocation }, dialogs: { selectFiles: mocks.selectFiles },
}));
vi.mock('./surface-opening', () => ({ openWorkspaceSurface: mocks.open }));
vi.mock('./file-browser-context', () => ({ resolveFileBrowserContext: mocks.resolveContext }));

import { createDocumentOpenBatch, executeDocumentOpenBatch, selectDocumentsToOpen } from './document-open-batch';
import { FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT } from '@platform/open-target/types';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue({ status: 'opened' });
  mocks.resolveLocation.mockImplementation(async (path: string) => ({ path, notebookId: null, notebookPath: null }));
  mocks.importFile.mockImplementation(async (path: string, root: string) => `${root}/${path.split('/').pop()}`);
  mocks.resolveContext.mockImplementation((path: string, context: object) => ({
    ...context, notebookId: path.startsWith('/notes/') ? 'notes' : null,
    scopePath: path.startsWith('/notes/') ? '/notes' : null,
  }));
});

it('keeps mixed file batches, deduplicates paths, and retains Work/Browser destinations', () => {
  const filePaths = ['/notes/a.md', '/outside/b.pdf', '/outside/c', '/notes/a.md'];
  expect(createDocumentOpenBatch({ filePaths }).map(({ path, index }) => [path, index])).toEqual([
    ['/notes/a.md', 0], ['/outside/b.pdf', 1], ['/outside/c', 1],
  ]);
  expect(createDocumentOpenBatch({ filePaths, destination: 1 }).every((item) => item.index === 1)).toBe(true);
});

it('resolves notebook ownership per file and uses the normal type-aware surface API', async () => {
  const result = await executeDocumentOpenBatch(createDocumentOpenBatch({ filePaths: ['/notes/a.md', '/outside/b.pdf'] }));
  expect(result.remaining).toEqual([]);
  expect(mocks.open.mock.calls[0][0]).toMatchObject({ host: 'column-1', target: { path: '/notes/a.md', scopePath: '/notes' }, options: { notebookId: 'notes' } });
  expect(mocks.open.mock.calls[1][0]).toMatchObject({ host: 'column-2', target: { path: '/outside/b.pdf', scopePath: null }, options: { notebookId: null } });
  expect(mocks.importFile).not.toHaveBeenCalled();
});

it('uses native physical paths and notebook ownership for non-Markdown files through aliases', async () => {
  mocks.resolveLocation.mockResolvedValueOnce({ path: '/real/book/a.pdf', notebookId: 'book', notebookPath: '/alias/book' });
  mocks.resolveContext.mockImplementationOnce((_path: string, context: object) => context);
  await executeDocumentOpenBatch(createDocumentOpenBatch({ filePaths: ['/alias/book/a.pdf'] }));
  expect(mocks.open.mock.calls[0][0]).toMatchObject({
    target: { path: '/real/book/a.pdf', scopePath: '/alias/book', fileBrowser: { notebookContextPath: '/real/book/a.pdf' } }, options: { notebookId: 'book' },
  });
});

it('imports every file type to the root, then opens the returned copies in the same positions', async () => {
  const result = await executeDocumentOpenBatch(createDocumentOpenBatch({ filePaths: ['/a.md', '/b.pdf', '/archive.zip'] }), { path: '/notes' });
  expect(result.remaining).toEqual([]);
  expect(mocks.importFile.mock.calls).toEqual([
    ['/a.md', '/notes', '/notes'], ['/b.pdf', '/notes', '/notes'], ['/archive.zip', '/notes', '/notes'],
  ]);
  expect(mocks.open.mock.calls.map(([request]) => [request.target.path, request.host])).toEqual([
    ['/notes/a.md', 'column-1'], ['/notes/b.pdf', 'column-2'], ['/notes/archive.zip', 'column-2'],
  ]);
});

it('retries only failed items without copying again or changing their original host', async () => {
  mocks.open.mockRejectedValueOnce(new Error('open failed')).mockResolvedValue({ status: 'opened' });
  const first = await executeDocumentOpenBatch(createDocumentOpenBatch({ filePaths: ['/a.md', '/b.pdf'] }), { path: '/notes' });
  expect(first.remaining).toHaveLength(1);
  expect(first.failures[0].path).toBe('/a.md');
  const retry = await executeDocumentOpenBatch(first.remaining, { path: '/notes' });
  expect(retry.remaining).toEqual([]);
  expect(mocks.importFile).toHaveBeenCalledTimes(2);
  expect(mocks.open.mock.calls[2][0]).toMatchObject({ host: 'column-1', target: { path: '/notes/a.md' } });
});

it('continues after copy errors without overwriting, and retries the failed import only', async () => {
  mocks.importFile.mockRejectedValueOnce(new Error('FILE_ALREADY_EXISTS'));
  const first = await executeDocumentOpenBatch(createDocumentOpenBatch({ filePaths: ['/a.pdf', '/b.md'] }), { path: '/notes' });
  expect(first.remaining.map((item) => item.path)).toEqual(['/a.pdf']);
  expect(mocks.open).toHaveBeenCalledTimes(1);
  await executeDocumentOpenBatch(first.remaining, { path: '/notes' });
  expect(mocks.importFile).toHaveBeenCalledTimes(3);
});

it('stops a cancelled navigation, retaining its copied path and all unprocessed items', async () => {
  mocks.open.mockResolvedValueOnce({ status: 'cancelled' });
  const first = await executeDocumentOpenBatch(createDocumentOpenBatch({ filePaths: ['/a.pdf', '/b.md'] }), { path: '/notes' });
  expect(first.remaining).toHaveLength(2);
  expect(first.failures).toEqual([]);
  expect(mocks.importFile).toHaveBeenCalledTimes(1);
  await executeDocumentOpenBatch(first.remaining, { path: '/notes' });
  expect(mocks.importFile).toHaveBeenCalledTimes(2);
});

it('submits all picker files in one request without filtering extensions', async () => {
  mocks.selectFiles.mockResolvedValue(['/a.md', '/b.pdf', '/file-without-extension']);
  const receive = vi.fn();
  window.addEventListener(FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT, receive);
  try {
    await selectDocumentsToOpen();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0][0].detail).toEqual({
      filePaths: ['/a.md', '/b.pdf', '/file-without-extension'], source: 'picker', destination: 0,
    });
  } finally {
    window.removeEventListener(FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT, receive);
  }
});
