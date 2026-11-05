import { beforeEach, expect, it, vi } from 'vitest';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
const mocks = vi.hoisted(() => ({
  remove: vi.fn(), clearDocument: vi.fn(), clearTarget: vi.fn(), clearBrowser: vi.fn(),
}));
vi.mock('@features/document/public/workspace-api', () => ({
  deleteExternalDocument: mocks.remove,
  getWorkspaceDocumentState: () => ({ activeExternalSession: {
    fileIdentity: { path: '/book/c.md', displayId: 'C' }, scopePath: '/book', transitionId: 2, openedAt: 0,
  } }),
}));
vi.mock('@features/memo/public/workspace-api', () => ({
  getWorkspaceMemoState: () => ({ notebooks: [{ id: 'book', path: '/book' }] }),
}));
vi.mock('../store/work-column-store', () => ({ useWorkColumnStore: { getState: () => ({ navigation: {
  target: { kind: 'external', path: '/book/a.md', scopePath: '/book', transitionId: 1 },
} }) } }));
vi.mock('../store/browser-column-store', () => ({ useBrowserColumnStore: { getState: () => ({ clearExternalPath: mocks.clearBrowser }) } }));
vi.mock('./workspace-navigation', () => ({ clearWorkspaceDocument: mocks.clearDocument, clearWorkspaceTargetForDeletedFile: mocks.clearTarget }));
import { deleteMainExternalDocument } from './delete-main-external-document';
beforeEach(() => { vi.clearAllMocks(); ensureFileDisplayIdentity('/book/a.md'); });
it('saves and deletes displayed A rather than singleton C after a swap', async () => {
  mocks.remove.mockResolvedValue(true);
  expect(await deleteMainExternalDocument('/book/a.md')).toBe('deleted');
  expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ fileIdentity: expect.objectContaining({ path: '/book/a.md' }) }));
  expect(mocks.clearTarget).toHaveBeenCalledWith('/book/a.md');
  expect(mocks.clearDocument).not.toHaveBeenCalled();
});
it('keeps the displayed target when its draft cannot be saved', async () => {
  mocks.remove.mockResolvedValue(false);
  expect(await deleteMainExternalDocument('/book/a.md')).toBe('unsaved');
  expect(mocks.clearTarget).not.toHaveBeenCalled();
  expect(mocks.clearBrowser).not.toHaveBeenCalled();
});
