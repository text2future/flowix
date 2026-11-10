import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), notebookPath: vi.fn().mockResolvedValue('/notes') }));
vi.mock('@platform/tauri/notebook-change-events', () => ({ subscribeNotebookChanges: mocks.subscribe }));
vi.mock('@features/memo/public/app-api', () => ({ getAppNotebookPath: mocks.notebookPath, refreshAppPathNoteMetadata: vi.fn() }));
vi.mock('@features/editor/public/mention-data-api', () => ({
  invalidateMentionNotes: vi.fn(),
  invalidateMentionTags: vi.fn(),
}));
vi.mock('@features/document/public/workspace-api', () => ({ rebaseStoredRecoveryDraftPaths: vi.fn() }));
vi.mock('@features/workspace/public/app-api', () => ({ openCreatedDocumentFromNotice: vi.fn(), removeBrowserColumnContentByPath: vi.fn(), applyNotebookPathMove: vi.fn() }));
vi.mock('@features/workspace/public/shell-api', () => ({ clearWorkspaceTargetForDeletedFile: vi.fn() }));
import { mountMainWindowNotebookEvents } from './main-window-notebook-events';
import { useCreatedDocumentNotices } from './created-document-notices';
import { openCreatedDocumentFromNotice } from '@features/workspace/public/app-api';

describe('new document event projections', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.subscribe.mockReturnValue(() => {}); useCreatedDocumentNotices.setState({ notices: [] }); });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  it('queues external creates without navigation and ignores ordinary edits and AGENTS.md', async () => {
    const stop = mountMainWindowNotebookEvents();
    const emit = mocks.subscribe.mock.calls[0][0];
    emit({ notebookId: 'nb', kind: 'resource-created', source: 'external_tool', relativePath: 'Draft.md' });
    emit({ notebookId: 'nb', kind: 'resource-created', source: 'external_tool', relativePath: 'Draft.md' });
    emit({ notebookId: 'nb', kind: 'resource-created', source: 'external_tool', relativePath: 'AGENTS.md' });
    emit({ notebookId: 'nb', kind: 'resource-updated', relativePath: 'Other.md' });
    await flush();
    expect(useCreatedDocumentNotices.getState().notices.map((item) => item.path)).toEqual(['/notes/Draft.md']);
    expect(openCreatedDocumentFromNotice).not.toHaveBeenCalled();
    emit({ notebookId: 'nb', kind: 'path-moved', previousRelativePath: 'Draft.md', relativePath: 'Renamed.md', directory: false });
    await flush();
    expect(useCreatedDocumentNotices.getState().notices[0].path).toBe('/notes/Renamed.md');
    emit({ notebookId: 'nb', kind: 'resource-deleted', relativePath: 'Renamed.md' });
    await flush();
    expect(useCreatedDocumentNotices.getState().notices).toEqual([]);
    stop();
  });
  it('does not publish a late card after the listener is disposed', async () => {
    const stop = mountMainWindowNotebookEvents();
    mocks.subscribe.mock.calls[0][0]({ notebookId: 'nb', kind: 'resource-created', source: 'external_tool', relativePath: 'Draft.md' });
    stop();
    await flush();
    expect(useCreatedDocumentNotices.getState().notices).toEqual([]);
  });
});
