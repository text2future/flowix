import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), confirm: vi.fn(), notice: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ files: { resolveLocation: mocks.resolve } }));
vi.mock('./components/cross-notebook-link-confirm', () => ({ confirmCrossNotebookLink: mocks.confirm }));
vi.mock('@/lib/toast', () => ({ toast: { info: mocks.notice } }));
import { prepareLocalLinkNavigation } from './local-link-navigation';
beforeEach(() => {
  vi.clearAllMocks(); mocks.confirm.mockResolvedValue(true);
  mocks.resolve.mockImplementation(async (path: string) => ({ path, notebookId: 'a', notebookPath: '/a', isDirectory: false }));
});
it('confirms the physical destination notebook of a directory symlink', async () => {
  mocks.resolve.mockImplementation(async (path: string) => path === '/a/source.md'
    ? { path, notebookId: 'a', notebookPath: '/a', isDirectory: false }
    : { path: '/b/target.md', notebookId: 'b', notebookPath: '/b', isDirectory: false });
  const prepared = await prepareLocalLinkNavigation({ path: '/a/alias/target.md', anchor: null }, '/a/source.md', {
    notebooks: [{ id: 'b', name: '显示名称' }],
  });
  expect(mocks.confirm).toHaveBeenCalledWith('a', { id: 'b', name: '显示名称' });
  expect(prepared?.location.path).toBe('/b/target.md');
  mocks.confirm.mockResolvedValue(false);
  expect(await prepareLocalLinkNavigation({ path: '/a/alias/target.md', anchor: null }, '/a/source.md')).toBeNull();
});
it('recognizes the current document through a filesystem alias', async () => {
  mocks.resolve.mockResolvedValue({ path: '/a/source.md', notebookId: 'a', notebookPath: '/a', isDirectory: false });
  const prepared = await prepareLocalLinkNavigation({ path: '/alias/source.md', anchor: null }, '/a/source.md');
  expect(prepared?.isCurrentDocument).toBe(true);
  expect(mocks.notice).toHaveBeenCalledOnce();
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it('does not show confirmation for an async click that has become stale', async () => {
  let current = true;
  mocks.resolve.mockImplementation(async (path: string) => {
    if (path !== '/a/source.md') current = false;
    return { path, notebookId: path === '/a/source.md' ? 'a' : 'b', isDirectory: false };
  });
  expect(await prepareLocalLinkNavigation({ path: '/b/target.md', anchor: null }, '/a/source.md', { isCurrent: () => current })).toBeNull();
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it('uses a literal Wiki directory when its implied Markdown note is absent', async () => {
  mocks.resolve.mockImplementation(async (path: string) => ({ path, notebookId: 'a', notebookPath: '/a',
    isDirectory: path === '/a/folder.md' ? null : path === '/a/folder' }));
  const prepared = await prepareLocalLinkNavigation({ path: '/a/folder.md', fallbackPath: '/a/folder', anchor: null }, '/a/source.md');
  expect(prepared?.location).toMatchObject({ path: '/a/folder', isDirectory: true });
});
