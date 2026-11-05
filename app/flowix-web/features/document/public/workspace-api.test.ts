import { describe, expect, it, vi } from 'vitest';

vi.mock('../store/document-session-service', () => ({
  prepareDocumentLeave: vi.fn(), saveDocumentPath: vi.fn(), rebaseActiveDocumentPath: vi.fn(),
}));
vi.mock('../store/recovery-draft-store', () => ({ rebaseRecoveryDraftPath: vi.fn() }));

import { ensureFileDisplayIdentity, rebaseFileDisplayPath } from '@/lib/file-display-registry';
import { useDocumentStore } from '../store/document-store';
import { replaceWorkspaceDocumentPath, saveWorkspaceTransferSources } from './workspace-api';
import { getDocumentSession } from '../store/document-runtime-session';
import { saveDocumentPath } from '../store/document-session-service';

describe('confirmed document path projection', () => {
  it('updates the open session even when another path consumer already rebased its identity', () => {
    const identity = ensureFileDisplayIdentity('/projection/old.md');
    useDocumentStore.setState({
      currentDocumentPath: identity.path, currentDocumentSource: 'external',
      activeExternalSession: {
        fileIdentity: identity, scopePath: '/projection', notebookId: 'book', notebookPath: '/projection',
        relativePath: 'old.md', indexable: true, openedAt: 1, transitionId: 7,
      },
    });
    expect(rebaseFileDisplayPath(identity.path, '/projection/new.md', identity.displayId)).toBe(true);
    expect(replaceWorkspaceDocumentPath({ ...identity, kind: 'md' }, '/projection/new.md')).toBe(true);
    expect(useDocumentStore.getState().currentDocumentPath).toBe('/projection/new.md');
    expect(useDocumentStore.getState().activeExternalSession).toMatchObject({
      fileIdentity: { displayId: identity.displayId, path: '/projection/new.md' },
      relativePath: 'new.md', transitionId: 7, openedAt: 1,
    });
    const confirmedSession = useDocumentStore.getState().activeExternalSession;
    replaceWorkspaceDocumentPath({ ...identity, kind: 'md' }, '/projection/new.md');
    expect(useDocumentStore.getState().activeExternalSession).toBe(confirmedSession);
    // Repeated receipts cannot roll a later rename back to an earlier path.
    expect(replaceWorkspaceDocumentPath({ ...identity, path: '/projection/new.md', kind: 'md' }, '/projection/final.md')).toBe(true);
    expect(replaceWorkspaceDocumentPath({ ...identity, kind: 'md' }, '/projection/new.md')).toBe(false);
    expect(useDocumentStore.getState().currentDocumentPath).toBe('/projection/final.md');
  });
});


describe('saving file transfer sources', () => {
  it('follows a title rename without changing a caller’s selection paths', async () => {
    const originalPath = '/transfer-title/old.md';
    const nextPath = '/transfer-title/new.md';
    const identity = ensureFileDisplayIdentity(originalPath);
    getDocumentSession({ ...identity, kind: 'md' });
    const save = vi.mocked(saveDocumentPath);
    save.mockClear();
    save.mockImplementationOnce(async () => {
      rebaseFileDisplayPath(originalPath, nextPath, identity.displayId);
      return true;
    });
    const selected = [originalPath];
    const transfer = selected.map(path => ({ path, isFolder: false }));
    expect(await saveWorkspaceTransferSources(transfer, '/transfer-title')).toBe(true);
    expect(transfer[0].path).toBe(nextPath);
    expect(selected).toEqual([originalPath]);
  });

  it('saves descendants of a selected folder while excluding similarly named siblings', async () => {
    for (const path of ['/transfer-folder/inside/a.md', '/transfer-folder/inside/nested/b.md', '/transfer-folder/inside-other/c.md']) {
      getDocumentSession({ ...ensureFileDisplayIdentity(path), kind: 'md' });
    }
    const save = vi.mocked(saveDocumentPath);
    save.mockClear(); save.mockResolvedValue(true);
    expect(await saveWorkspaceTransferSources([{ path: '/transfer-folder/inside', isFolder: true }], '/transfer-folder')).toBe(true);
    expect(save.mock.calls.map(call => call[1])).toEqual(['/transfer-folder/inside/a.md', '/transfer-folder/inside/nested/b.md']);
  });
});
