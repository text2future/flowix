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
        vi.mocked(invoke).mockResolvedValue('/notebook/attachments/fig.png');
        const result = await createAttachmentUploadFromPaths(['/selected/fig.png'], undefined, undefined, 'notebook-owner');
        expect(invoke).toHaveBeenCalledWith('save_attachment', {
            sourcePath: '/selected/fig.png', memoId: undefined, notebookId: 'notebook-owner',
        });
        expect(result.assets[0].storageKey).toBe('/notebook/attachments/fig.png');
    });

    it('does not create an attachment for an unauthorized source', async () => {
        vi.mocked(invoke).mockRejectedValue(new Error('not authorized'));
        expect(await createAttachmentUploadFromPaths(['/private/file.txt'], 'memo-a')).toEqual({ assets: [] });
    });

    it('does not create an attachment for an empty save result', async () => {
        vi.mocked(invoke).mockResolvedValue(null);
        expect(await createAttachmentUploadFromPaths(['/selected/file.txt'], 'memo-a')).toEqual({ assets: [] });
    });

    it('keeps successful imports in a partially failed batch', async () => {
        vi.mocked(invoke).mockRejectedValueOnce(new Error('read failed'))
            .mockResolvedValueOnce('/notebook/attachments/good.txt');
        const result = await createAttachmentUploadFromPaths(['/bad.txt', '/good.txt'], 'memo-a');
        expect(result.assets).toHaveLength(1);
        expect(result.assets[0].storageKey).toBe('/notebook/attachments/good.txt');
    });

    it('does not allocate a preview for a file that failed to persist', async () => {
        const file = { name: 'file.txt', type: 'text/plain', size: 4 } as File;
        const saveFile = vi.fn().mockRejectedValue(new Error('disk full'));
        expect(await createAttachmentUpload([file], undefined, saveFile)).toEqual({ assets: [] });
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
        vi.mocked(uploadInChunks).mockResolvedValue('/attachments/file.txt');
        const result = await createAttachmentUpload([file], undefined, undefined, 'memo-a', controller.signal);
        expect(uploadInChunks).toHaveBeenCalledWith(file, 'file.txt', 'memo-a', controller.signal);
        expect(invoke).not.toHaveBeenCalled();
        expect(result.assets[0].storageKey).toBe('/attachments/file.txt');
    });

    it('sends the same memo identity for every file in a batch', async () => {
        vi.mocked(invoke).mockResolvedValue('/attachments/saved.txt');
        await createAttachmentUploadFromPaths(['/one.txt', '/two.txt'], 'memo-a');
        expect(invoke).toHaveBeenNthCalledWith(1, 'save_attachment', { sourcePath: '/one.txt', memoId: 'memo-a' });
        expect(invoke).toHaveBeenNthCalledWith(2, 'save_attachment', { sourcePath: '/two.txt', memoId: 'memo-a' });
    });

    it('does not mix identities between overlapping uploads', async () => {
        vi.mocked(invoke).mockResolvedValue('/attachments/saved.txt');
        await Promise.all([
            createAttachmentUploadFromPaths(['/one.txt'], 'memo-a'),
            createAttachmentUploadFromPaths(['/two.txt'], 'memo-b'),
        ]);
        expect(invoke).toHaveBeenCalledWith('save_attachment', { sourcePath: '/one.txt', memoId: 'memo-a' });
        expect(invoke).toHaveBeenCalledWith('save_attachment', { sourcePath: '/two.txt', memoId: 'memo-b' });
    });

    it('rejects oversized Base64 uploads before reading or invoking storage', async () => {
        const file = { name: 'large.bin', type: 'application/octet-stream', size: MAX_ATTACHMENT_CONTENT_BYTES + 1 } as File;
        const saveContent = vi.fn();
        expect(await createAttachmentUpload([file], saveContent, undefined, 'memo-a')).toEqual({ assets: [] });
        expect(saveContent).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith('[FileUpload] Failed to save attachment:', expect.objectContaining({ message: 'ATTACHMENT_CONTENT_TOO_LARGE' }));
    });

    it('does not impose the Base64 limit on custom file savers', async () => {
        const file = { name: 'large.bin', type: 'application/octet-stream', size: MAX_ATTACHMENT_CONTENT_BYTES + 1 } as File;
        const saveFile = vi.fn().mockResolvedValue(null);
        await createAttachmentUpload([file], undefined, saveFile, 'memo-a');
        expect(saveFile).toHaveBeenCalledWith({ file, fileName: 'large.bin' });
    });

    it('stops the batch after cancellation but returns an already saved file for recovery', async () => {
        const controller = new AbortController();
        let complete!: (path: string) => void;
        vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
        const upload = createAttachmentUploadFromPaths(['/first.txt', '/second.txt'], 'memo-a', controller.signal);
        controller.abort();
        complete('/attachments/first.txt');
        const result = await upload;
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(result.assets[0].storageKey).toBe('/attachments/first.txt');
    });
});
