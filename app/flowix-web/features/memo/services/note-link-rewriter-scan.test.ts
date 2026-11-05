import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDirChildren, readDocument, writeDocument } = vi.hoisted(() => ({
  getDirChildren: vi.fn(),
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
}));
const { hasLiveUnsavedDocumentAtPath, acceptBackgroundDocumentContent, notebooks } = vi.hoisted(() => ({
  hasLiveUnsavedDocumentAtPath: vi.fn(() => false),
  acceptBackgroundDocumentContent: vi.fn(() => true),
  notebooks: [{ id: 'work', name: 'Work', path: 'C:/Notes' }],
}));

vi.mock('@platform/tauri/client/desktop', () => ({ files: { getDirChildren } }));
vi.mock('@platform/tauri/client', () => ({ externalDocuments: { read: readDocument }, notes: { writeDocument } }));
vi.mock('@features/document/public/workspace-api', () => ({ hasLiveUnsavedDocumentAtPath, acceptBackgroundDocumentContent, getWorkspaceDocumentLinkStage: () => undefined }));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: { getState: () => ({
    notebooksInitialized: true,
    notebooks,
  }) },
}));

import { rewriteLinksInNotebooks, rewriteNoteLinkMoves, updateNoteLinksAfterMove } from './note-link-rewriter';

describe('background link update', () => {
  beforeEach(() => {
    localStorage.removeItem('flowix:pending-note-link-moves');
    getDirChildren.mockReset();
    readDocument.mockReset();
    writeDocument.mockReset();
    hasLiveUnsavedDocumentAtPath.mockReset();
    hasLiveUnsavedDocumentAtPath.mockReturnValue(false);
    acceptBackgroundDocumentContent.mockClear();
    notebooks.splice(0, notebooks.length, { id: 'work', name: 'Work', path: 'C:/Notes' });
  });
  it('rewrites a reference in a nested Markdown file without using the note index', async () => {
    getDirChildren.mockImplementation(async (path: string) => path === 'C:/Notes'
      ? [{ type: 'folder', fullPath: 'C:/Notes/Projects', name: 'Projects' }]
      : [{ type: 'document', fullPath: 'C:/Notes/Projects/Index.md', name: 'Index.md' }]);
    const content = '[Old](flowix://open?book=Work&file=Old.md)';
    readDocument.mockResolvedValue(content);
    const updated = '[New](flowix://open?b=Work&f=New.md)';
    writeDocument.mockResolvedValue({ path: 'C:/Notes/Projects/Index.md', content: updated });

    await rewriteLinksInNotebooks('C:/Notes/Old.md', 'C:/Notes/New.md');

    expect(writeDocument).toHaveBeenCalledWith({
      filePath: 'C:/Notes/Projects/Index.md',
      content: '[New](flowix://open?b=Work&f=New.md)',
      expectedContent: content,
    });
    expect(acceptBackgroundDocumentContent).toHaveBeenCalledWith('C:/Notes/Projects/Index.md', updated);
    expect(readDocument).toHaveBeenCalledWith('C:/Notes/Projects/Index.md', 'C:/Notes');
  });

  it('defers a dirty open note for a later pass', async () => {
    getDirChildren.mockResolvedValue([{ type: 'document', fullPath: 'C:/Notes/Index.md', name: 'Index.md' }]);
    hasLiveUnsavedDocumentAtPath.mockReturnValueOnce(true);
    readDocument.mockClear();
    writeDocument.mockClear();
    expect(await rewriteLinksInNotebooks('C:/Notes/Old.md', 'C:/Notes/New.md')).toBe(false);
    expect(readDocument).not.toHaveBeenCalled();
    expect(writeDocument).not.toHaveBeenCalled();
  });

  it('keeps a failed compare-and-swap pending after retrying fresh content', async () => {
    getDirChildren.mockResolvedValue([{ type: 'document', fullPath: 'C:/Notes/Index.md', name: 'Index.md' }]);
    readDocument.mockResolvedValue('[Old](flowix://open?b=Work&f=Old.md)');
    writeDocument.mockResolvedValue(null);
    expect(await rewriteLinksInNotebooks('C:/Notes/Old.md', 'C:/Notes/New.md')).toBe(false);
    expect(writeDocument).toHaveBeenCalledTimes(2);
  });

  it('updates A in the affected notebook before any unrelated notebook scan', async () => {
    notebooks.unshift({ id: 'slow', name: 'Slow', path: 'C:/Slow' });
    getDirChildren.mockImplementation(async (path: string) => {
      if (path === 'C:/Slow') {
        expect(writeDocument).toHaveBeenCalledTimes(1);
        return [];
      }
      return [{ type: 'document', fullPath: 'C:/Notes/A.md', name: 'A.md' }];
    });
    readDocument.mockResolvedValue('[B](flowix://open?b=Work&f=B.md)');
    writeDocument.mockImplementation(async (request) => ({ path: request.filePath, content: request.content }));
    expect(await rewriteLinksInNotebooks('C:/Notes/B.md', 'C:/Notes/B2.md')).toBe(true);
    expect(getDirChildren.mock.calls[0][0]).toBe('C:/Notes');
    expect(acceptBackgroundDocumentContent).toHaveBeenCalledWith('C:/Notes/A.md', '[B2](flowix://open?b=Work&f=B2.md)');
  });
  it('updates relative image references without a Flowix URL in the document', async () => {
    getDirChildren.mockResolvedValue([{ type: 'document', fullPath: 'C:/Notes/Index.md', name: 'Index.md' }]);
    readDocument.mockResolvedValue('![chart](./old.png)');
    writeDocument.mockImplementation(async request => ({ path: request.filePath, content: request.content }));
    expect(await rewriteLinksInNotebooks('C:/Notes/old.png', 'C:/Notes/new.png')).toBe(true);
    expect(writeDocument).toHaveBeenCalledWith({ filePath: 'C:/Notes/Index.md', expectedContent: '![chart](./old.png)', content: '![chart](./new.png)' });
  });

  it('recovers a source rebase after a write succeeds but its response is lost', async () => {
    getDirChildren.mockResolvedValue([{ type: 'document', fullPath: 'C:/Notes/Index.md', name: 'Index.md' }]);
    let disk = '[custom](./target.md)';
    readDocument.mockImplementation(async () => disk);
    writeDocument.mockImplementationOnce(async request => { disk = request.content; throw new Error('lost response'); });
    const jobs: Parameters<typeof rewriteNoteLinkMoves>[0] = [{ oldPath: 'C:/Notes/sub/Index.md', newPath: 'C:/Notes/Index.md' }];
    const persist = vi.fn();
    expect(await rewriteNoteLinkMoves(jobs, () => false, persist)).toBe(false);
    expect(disk).toBe('[custom](./sub/target.md)');
    expect(persist).toHaveBeenCalled();
    const recovered = JSON.parse(JSON.stringify(jobs));
    expect(await rewriteNoteLinkMoves(recovered)).toBe(true);
    expect(writeDocument).toHaveBeenCalledTimes(1);
    // Later edits must not trigger another source-directory conversion on retry.
    disk += ' updated';
    expect(await rewriteNoteLinkMoves(recovered)).toBe(true);
    expect(writeDocument).toHaveBeenCalledTimes(1);
  });

  it('does not rebase a dirty source or overwrite an edit racing the write', async () => {
    getDirChildren.mockResolvedValue([{ type: 'document', fullPath: 'C:/Notes/Index.md', name: 'Index.md' }]);
    readDocument.mockResolvedValue('[x](./target.md)');
    writeDocument.mockResolvedValue(null);
    expect(await rewriteLinksInNotebooks('C:/Notes/sub/Index.md', 'C:/Notes/Index.md')).toBe(false);
    expect(writeDocument).toHaveBeenCalledWith(expect.objectContaining({ expectedContent: '[x](./target.md)', content: '[x](./sub/target.md)' }));
  });

  it('does not reapply target swaps when another document causes a batch retry', async () => {
    getDirChildren.mockResolvedValue([
      { type: 'document', fullPath: 'C:/Notes/Index.md', name: 'Index.md' },
      { type: 'document', fullPath: 'C:/Notes/Dirty.md', name: 'Dirty.md' },
    ]);
    let disk = '[a](./A.md)';
    hasLiveUnsavedDocumentAtPath.mockImplementation((...args: unknown[]) => args[0] === 'C:/Notes/Dirty.md');
    readDocument.mockImplementation(async () => disk);
    writeDocument.mockImplementation(async request => { disk = request.content; return { content: disk }; });
    const jobs: Parameters<typeof rewriteNoteLinkMoves>[0] = [
      { oldPath: 'C:/Notes/A.md', newPath: 'C:/Notes/Temp.md' },
      { oldPath: 'C:/Notes/B.md', newPath: 'C:/Notes/A.md' },
      { oldPath: 'C:/Notes/Temp.md', newPath: 'C:/Notes/B.md' },
    ];
    expect(await rewriteNoteLinkMoves(jobs)).toBe(false);
    expect(disk).toBe('[a](./B.md)');
    const recovered = JSON.parse(JSON.stringify(jobs));
    expect(await rewriteNoteLinkMoves(recovered)).toBe(false);
    expect(disk).toBe('[a](./B.md)');
    expect(writeDocument).toHaveBeenCalledTimes(1);
  });

  it('continues from each document stage when another source move is appended', async () => {
    let source = 'C:/Notes/B/n.md';
    getDirChildren.mockImplementation(async () => [{ type: 'document', fullPath: source, name: 'n.md' }]);
    let disk = '[asset](./asset.png)';
    readDocument.mockImplementation(async () => disk);
    writeDocument.mockImplementation(async request => { disk = request.content; return { content: disk }; });
    const jobs: Parameters<typeof rewriteNoteLinkMoves>[0] = [{ oldPath: 'C:/Notes/A/n.md', newPath: source }];
    expect(await rewriteNoteLinkMoves(jobs)).toBe(true);
    expect(disk).toBe('[asset](../A/asset.png)');
    source = 'C:/Notes/C/n.md';
    jobs.push({ oldPath: 'C:/Notes/B/n.md', newPath: source });
    expect(await rewriteNoteLinkMoves(jobs)).toBe(true);
    expect(disk).toBe('[asset](../A/asset.png)');
  });

  it('keeps the full timeline when a move arrives during the background scan', async () => {
    let source = 'C:/Notes/B/n.md';
    let disk = '[asset](./asset.png)';
    let appended = false;
    getDirChildren.mockImplementation(async () => [{ type: 'document', fullPath: source, name: 'n.md' }]);
    readDocument.mockImplementation(async () => {
      if (!appended) {
        appended = true;
        source = 'C:/Notes/C/n.md';
        updateNoteLinksAfterMove('C:/Notes/B/n.md', source);
      }
      return disk;
    });
    writeDocument.mockImplementation(async request => { disk = request.content; return { content: disk }; });
    updateNoteLinksAfterMove('C:/Notes/A/n.md', source);
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('flowix:pending-note-link-moves') ?? '[]')).toEqual([]));
    expect(disk).toBe('[asset](../A/asset.png)');
    expect(writeDocument).toHaveBeenCalledTimes(1);
  });

});
