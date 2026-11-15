import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import { openDocumentLocalLink } from './open-document-local-link';
import { peekAgentLocationRequest, cancelAgentLocationRequest } from './agent-location-navigation';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), open: vi.fn(), confirm: vi.fn() }));
vi.mock('@features/editor/components/cross-notebook-link-confirm', () => ({ confirmCrossNotebookLink: mocks.confirm }));
vi.mock('@features/document/public/resource-context', () => ({ getDocumentResourceSnapshot: () => ({ notebooks: [] }) }));
vi.mock('@platform/tauri/client', () => ({ files: { resolveLocation: mocks.resolve } }));
vi.mock('@features/workspace/public/session-api', () => ({ columnAtIndex: () => 'column-1' }));
vi.mock('@features/workspace/public/session-opening-api', () => ({
  openPreparedWorkspaceSurface: async (request: object, prepare: () => Promise<object>) =>
    mocks.open({ ...request, ...await prepare() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.resolve.mockImplementation(async (path: string) => ({
    path, notebookId: 'book', notebookPath: '/nb', relativePath: 'note.md', indexable: true, isDirectory: false,
  }));
  mocks.open.mockResolvedValue({ status: 'opened', location: { host: 'column-1', state: 'active' } });
});

describe('openDocumentLocalLink', () => {
  it('opens an actual directory without requiring a trailing slash', async () => {
    mocks.resolve.mockResolvedValue({ path: '/nb/05 我的作品', notebookId: 'book', notebookPath: '/nb', isDirectory: true });
    await openDocumentLocalLink({ path: '/nb/05 我的作品', anchor: null }, '/nb');
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      columnId: 'column-1', target: { kind: 'folder-collection', folderPath: '/nb/05 我的作品',
        notebookId: 'book', notebookPath: '/nb', folderName: '05 我的作品' },
    }));
  });

  it('uses resolved ownership and canonical path for a directory alias', async () => {
    mocks.resolve.mockResolvedValue({ path: '/nb/作品', notebookId: 'book', notebookPath: '/nb', isDirectory: true });
    await openDocumentLocalLink({ path: '/alias/作品', anchor: null }, '/alias');
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ kind: 'folder-collection', notebookId: 'book', folderPath: '/nb/作品' }),
    }));
  });

  it('opens the notebook root as a collection using resolved root ownership', async () => {
    mocks.resolve.mockResolvedValue({ path: '/nb', notebookId: 'book', notebookPath: '/nb', relativePath: '', isDirectory: true });
    await openDocumentLocalLink({ path: '/alias', anchor: null }, null);
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ kind: 'folder-collection', notebookId: 'book', folderPath: '/nb' }),
    }));
  });

  it('opens a directory outside a notebook in the file browser', async () => {
    mocks.resolve.mockResolvedValue({ path: '/repo', notebookId: null, isDirectory: true });
    await openDocumentLocalLink({ path: '/repo', anchor: null }, null);
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ kind: 'file-browser', folderPath: '/repo', activeFilePath: null }),
    }));
  });

  it('reuses file resolution and publishes the anchor against the canonical path', async () => {
    mocks.resolve.mockResolvedValue({ path: '/nb/note.md', notebookId: 'book', isDirectory: false });
    await openDocumentLocalLink({ path: '/alias/note.md', anchor: '实验步骤' }, '/nb');
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ kind: 'external', path: '/nb/note.md' }),
      options: { markdownLocation: { path: '/nb/note.md', notebookId: 'book', isDirectory: false } },
    }));
    expect(peekAgentLocationRequest('/nb/note.md')?.anchor).toBe('实验步骤');
    cancelAgentLocationRequest('/nb/note.md');
  });

  it('does not publish an anchor for a cancelled navigation', async () => {
    mocks.open.mockResolvedValue({ status: 'cancelled' });
    await openDocumentLocalLink({ path: '/nb/cancelled.md', anchor: '结论' }, '/nb');
    expect(peekAgentLocationRequest('/nb/cancelled.md')).toBeNull();
  });

  it('does not turn unknown target types into files even with a directory syntax hint', async () => {
    mocks.resolve.mockResolvedValue({ path: '/nb/missing', isDirectory: null });
    await expect(openDocumentLocalLink({ path: '/nb/missing', anchor: null, isDirectory: true }, '/nb')).rejects.toThrow();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('propagates resolution failures without opening a file fallback', async () => {
    mocks.resolve.mockRejectedValue(new Error('permission denied'));
    await expect(openDocumentLocalLink({ path: '/nb/restricted', anchor: null }, '/nb')).rejects.toThrow('permission denied');
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

it('prefers the notebook-root Markdown note over a same-named folder', async () => {
  mocks.resolve.mockImplementation(async (path: string) => ({ path,
    notebookId: 'book', notebookPath: '/nb', isDirectory: path === '/nb/sub/资料' }));
  await openDocumentLocalLink({ path: '/nb/sub/资料', notebookNoteName: '资料', anchor: '标题' }, null, '/nb/sub/source.md');
  expect(mocks.resolve.mock.calls.map(call => call[0])).toEqual(['/nb/sub/source.md', '/nb/资料.md']);
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ path: '/nb/资料.md' }) }));
  expect(peekAgentLocationRequest('/nb/资料.md')?.anchor).toBe('标题');
  cancelAgentLocationRequest('/nb/资料.md');
});

it('falls back to the authored relative folder when the root note is missing', async () => {
  mocks.resolve.mockImplementation(async (path: string) => ({ path,
    notebookId: 'book', notebookPath: '/nb', isDirectory: path.endsWith('.md') ? path === '/nb/资料.md' ? null : false : true }));
  await openDocumentLocalLink({ path: '/nb/sub/资料', notebookNoteName: '资料', anchor: null }, null, '/nb/sub/source.md');
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ kind: 'folder-collection', folderPath: '/nb/sub/资料' }) }));
});

it('notifies when a bare note name resolves back to the current document', async () => {
  const notice = vi.spyOn(toast, 'info').mockReturnValue(1);
  try {
    await openDocumentLocalLink({ path: '/nb/资料', notebookNoteName: '资料', anchor: null }, '/nb', '/nb/资料.md');
    expect(notice).toHaveBeenCalledOnce();
  } finally { notice.mockRestore(); }
});

it('cancels a cross-notebook link before opening its destination', async () => {
  mocks.resolve.mockImplementation(async (path: string) => ({ path, isDirectory: false,
    notebookId: path.startsWith('/other/') ? 'other' : 'book', notebookPath: path.startsWith('/other/') ? '/other' : '/nb' }));
  mocks.confirm.mockResolvedValue(false);
  await expect(openDocumentLocalLink({ path: '/other/target.md', anchor: null }, null, '/nb/source.md'))
    .rejects.toThrow('Local link navigation cancelled');
  expect(mocks.confirm).toHaveBeenCalledWith('book', { id: 'other', name: 'other' });
  expect(mocks.open).not.toHaveBeenCalled();
});

it('opens a cross-notebook link after confirmation', async () => {
  mocks.resolve.mockImplementation(async (path: string) => ({ path, isDirectory: false,
    notebookId: path.startsWith('/other/') ? 'other' : 'book', notebookPath: path.startsWith('/other/') ? '/other' : '/nb' }));
  await openDocumentLocalLink({ path: '/other/target.md', anchor: null }, null, '/nb/source.md');
  expect(mocks.confirm).toHaveBeenCalledWith('book', { id: 'other', name: 'other' });
  expect(mocks.open).toHaveBeenCalledOnce();
});
