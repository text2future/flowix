import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@platform/tauri/core';
import { uploadInChunks } from './chunked';
import { createAttachmentUpload, createAttachmentUploadFromPaths, MAX_ATTACHMENT_CONTENT_BYTES } from './storage';

vi.mock('@platform/tauri/core', () => ({ invoke: vi.fn() }));
vi.mock('./feedback', () => ({ reportUploadFailure: vi.fn() }));
vi.mock('./chunked', () => ({ uploadInChunks: vi.fn() }));
vi.mock('@features/editor/extensions/attachment-link/utils', () => ({
    assetUrl: (path: string) => `asset:${path}`,
    safeFileName: (name: string) => name,
}));
vi.mock('@features/editor/extensions/attachment-link/upload/file-source', () => ({
    fileNameFromPath: (path: string) => path.split('/').pop(),
    getFileKind: () => 'file',
    getFileKindFromName: () => 'file',
    mimeTypeFromName: () => 'application/octet-stream',
}));

describe('attachment storage failures', () => {
    beforeEach(() => {
        vi.mocked(invoke).mockReset();
        vi.mocked(uploadInChunks).mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => vi.restoreAllMocks());

    it('saves selected files for a path-based note using its notebook instead of a legacy memo ID', async () => {
        vi.mocked(invoke).mockResolvedValue({ path: '/notebook/attachments/fig.png', created: true });
        const result = await createAttachmentUploadFromPaths(['/selected/fig.png'], { notebookId: 'notebook-owner' });
        expect(invoke).toHaveBeenCalledWith('save_notebook_asset', {
            sourcePath: '/selected/fig.png', notebookId: 'notebook-owner', deduplicate: true, reuseNotebookFile: true, reuseExistingAttachment: true,
        });
        expect(result.assets[0].storageKey).toBe('/notebook/attachments/fig.png');
    });

    it('does not create an attachment for an unauthorized source', async () => {
        vi.mocked(invoke).mockRejectedValue(new Error('not authorized'));
        expect(await createAttachmentUploadFromPaths(['/private/file.txt'], { ownerPath: 'memo-a' })).toEqual({ assets: [] });
    });

    it('does not create an attachment for an empty save result', async () => {
        vi.mocked(invoke).mockResolvedValue(null);
        expect(await createAttachmentUploadFromPaths(['/selected/file.txt'], { ownerPath: 'memo-a' })).toEqual({ assets: [] });
    });

    it('keeps successful imports in a partially failed batch', async () => {
        vi.mocked(invoke).mockRejectedValueOnce(new Error('read failed'))
            .mockResolvedValueOnce({ path: '/notebook/attachments/good.txt', created: true });
        const result = await createAttachmentUploadFromPaths(['/bad.txt', '/good.txt'], { ownerPath: 'memo-a' });
        expect(result.assets).toHaveLength(1);
        expect(result.assets[0].storageKey).toBe('/notebook/attachments/good.txt');
    });

    it('does not allocate a preview for a file that failed to persist', async () => {
        const file = { name: 'file.txt', type: 'text/plain', size: 4 } as File;
        const saveFile = vi.fn().mockRejectedValue(new Error('disk full'));
        expect(await createAttachmentUpload([file], { saveFile })).toEqual({ assets: [] });
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('does not invoke storage without an explicit owner', async () => {
        expect(await createAttachmentUploadFromPaths(['/selected/file.txt'])).toEqual({ assets: [] });
        const file = { name: 'file.txt', type: 'text/plain', size: 4 } as File;
        expect(await createAttachmentUpload([file])).toEqual({ assets: [] });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('routes native browser files through the chunked transport', async () => {
        const file = new File(['content'], 'file.txt', { type: 'text/plain' });
        const controller = new AbortController();
        vi.mocked(uploadInChunks).mockResolvedValue({ path: '/attachments/file.txt', created: true });
        const result = await createAttachmentUpload([file], { ownerPath: 'memo-a', signal: controller.signal });
        expect(uploadInChunks).toHaveBeenCalledWith(file, 'file.txt', expect.objectContaining({ ownerPath: 'memo-a', signal: controller.signal, deduplicate: true, externalFileCache: false }));
        expect(invoke).not.toHaveBeenCalled();
        expect(result.assets[0].storageKey).toBe('/attachments/file.txt');
    });

    it('sends the same note path for every file in a batch', async () => {
        vi.mocked(invoke).mockResolvedValue({ path: '/attachments/saved.txt', created: true });
        await createAttachmentUploadFromPaths(['/one.txt', '/two.txt'], { ownerPath: 'memo-a' });
        expect(invoke).toHaveBeenNthCalledWith(1, 'save_notebook_asset', { sourcePath: '/one.txt', notePath: 'memo-a', deduplicate: true, reuseNotebookFile: true, reuseExistingAttachment: true });
        expect(invoke).toHaveBeenNthCalledWith(2, 'save_notebook_asset', { sourcePath: '/two.txt', notePath: 'memo-a', deduplicate: true, reuseNotebookFile: true, reuseExistingAttachment: true });
    });

    it('does not mix note paths between overlapping uploads', async () => {
        vi.mocked(invoke).mockResolvedValue({ path: '/attachments/saved.txt', created: true });
        await Promise.all([
            createAttachmentUploadFromPaths(['/one.txt'], { ownerPath: 'memo-a' }),
            createAttachmentUploadFromPaths(['/two.txt'], { ownerPath: 'memo-b' }),
        ]);
        expect(invoke).toHaveBeenCalledWith('save_notebook_asset', { sourcePath: '/one.txt', notePath: 'memo-a', deduplicate: true, reuseNotebookFile: true, reuseExistingAttachment: true });
        expect(invoke).toHaveBeenCalledWith('save_notebook_asset', { sourcePath: '/two.txt', notePath: 'memo-b', deduplicate: true, reuseNotebookFile: true, reuseExistingAttachment: true });
    });

    it('rejects oversized Base64 uploads before reading or invoking storage', async () => {
        const file = { name: 'large.bin', type: 'application/octet-stream', size: MAX_ATTACHMENT_CONTENT_BYTES + 1 } as File;
        const saveContent = vi.fn();
        expect(await createAttachmentUpload([file], { saveContent, ownerPath: 'memo-a' })).toEqual({ assets: [] });
        expect(saveContent).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith('[FileUpload] Failed to save attachment:', expect.objectContaining({ message: 'ATTACHMENT_CONTENT_TOO_LARGE' }));
    });

    it('does not impose the Base64 limit on custom file savers', async () => {
        const file = { name: 'large.bin', type: 'application/octet-stream', size: MAX_ATTACHMENT_CONTENT_BYTES + 1 } as File;
        const saveFile = vi.fn().mockResolvedValue(null);
        await createAttachmentUpload([file], { saveFile, ownerPath: 'memo-a' });
        expect(saveFile).toHaveBeenCalledWith({ file, fileName: 'large.bin' });
    });

    it('stops the batch after cancellation but returns an already saved file for recovery', async () => {
        const controller = new AbortController();
        let complete!: (result: { path: string; created: boolean }) => void;
        vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
        const upload = createAttachmentUploadFromPaths(['/first.txt', '/second.txt'], { ownerPath: 'memo-a', signal: controller.signal });
        controller.abort();
        complete({ path: '/attachments/first.txt', created: true });
        const result = await upload;
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(result.assets[0].storageKey).toBe('/attachments/first.txt');
    });

    it.each(['report.pdf', 'photo.png'])('persists external clipboard content without an original path: %s', async (name) => {
        const file = new File(['content'], name);
        const savedPath = `/Users/test/.flowix/cache/external-file-images/${name}`;
        vi.mocked(uploadInChunks).mockResolvedValue({ path: savedPath, created: true });
        const result = await createAttachmentUpload([file], { externalFileCache: true, documentPath: '/outside/draft.md' });
        expect(uploadInChunks).toHaveBeenCalledWith(file, name, expect.objectContaining({ externalFileCache: true, deduplicate: true }));
        expect(result.assets[0]).toMatchObject({ storageKey: savedPath, markdownHref: savedPath, created: true });
        expect(invoke).not.toHaveBeenCalled();
    });

    it.each(['report.pdf', 'photo.png'])('references existing external files in place: %s', async (name) => {
        vi.mocked(invoke).mockResolvedValue(`/original files/${name}`);
        const result = await createAttachmentUploadFromPaths([`/original files/${name}`], {
            externalFileCache: true, documentPath: '/outside/draft.md',
        });
        expect(result.assets[0]).toMatchObject({
            storageKey: `/original files/${name}`, markdownHref: `/original%20files/${name}`, created: false,
        });
        expect(invoke).toHaveBeenCalledWith('retain_external_file_reference', { sourcePath: `/original files/${name}` });
        expect(uploadInChunks).not.toHaveBeenCalled();
    });

    it.each([
        { root: '/book', repositoryPath: undefined },
        { root: '/repository', repositoryPath: '/repository' },
    ])('uses a document-relative attachment destination for $root', async ({ root, repositoryPath }) => {
        vi.mocked(invoke).mockResolvedValue({ path: `${root}/attachments/report.pdf`, created: true });
        const result = await createAttachmentUploadFromPaths(['/selected/report.pdf'], {
            notebookId: 'book', repositoryPath, documentPath: `${root}/notes/draft.md`,
        });
        expect(result.assets[0].markdownHref).toBe('../attachments/report.pdf');
        expect(invoke).toHaveBeenCalledWith('save_notebook_asset', expect.objectContaining({
            notebookId: 'book', ...(repositoryPath ? { repositoryPath } : {}), reuseNotebookFile: true,
        }));
    });

    it('reuses a path-bearing File through the same notebook import flow as a selected path', async () => {
        const file = Object.assign(new File(['content'], 'report.pdf'), { path: '/repository/documents/report.pdf' });
        vi.mocked(invoke).mockResolvedValue({ path: file.path, created: false });
        const result = await createAttachmentUpload([file], { notebookId: 'book', repositoryPath: '/repository', documentPath: '/repository/notes/draft.md' });
        expect(result.assets[0]).toMatchObject({ markdownHref: '../documents/report.pdf', created: false });
        expect(invoke).toHaveBeenCalledWith('save_notebook_asset', expect.objectContaining({
            sourcePath: file.path, repositoryPath: '/repository', reuseNotebookFile: true,
        }));
        expect(uploadInChunks).not.toHaveBeenCalled();
    });
});
