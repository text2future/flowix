import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@platform/tauri/core';
import { readFileBase64 } from './io';
import { uploadInChunks, UPLOAD_CHUNK_BYTES } from './chunked';

vi.mock('@platform/tauri/core', () => ({ invoke: vi.fn() }));
vi.mock('./io', () => ({ readFileBase64: vi.fn() }));

describe('chunked attachment transport', () => {
    beforeEach(() => {
        vi.mocked(invoke).mockReset();
        vi.mocked(readFileBase64).mockReset().mockResolvedValue('YQ==');
        vi.mocked(invoke).mockImplementation(async (command) => command === 'begin_attachment_upload' ? 'upload' : { path: '/attachments/file', created: true });
    });

    it('slices input and waits for each chunk before committing', async () => {
        const file = new File([new Uint8Array(UPLOAD_CHUNK_BYTES + 1)], 'file');
        expect(await uploadInChunks(file, 'file', 'memo')).toEqual({ path: '/attachments/file', created: true });
        expect(invoke).toHaveBeenNthCalledWith(1, 'begin_attachment_upload', { notePath: 'memo', fileName: 'file', size: file.size });
        expect(vi.mocked(readFileBase64).mock.calls.map(([blob]) => blob.size)).toEqual([UPLOAD_CHUNK_BYTES, 1]);
        expect(invoke).toHaveBeenNthCalledWith(2, 'append_attachment_upload', { uploadId: 'upload', offset: 0, content: 'YQ==' });
        expect(invoke).toHaveBeenNthCalledWith(3, 'append_attachment_upload', { uploadId: 'upload', offset: UPLOAD_CHUNK_BYTES, content: 'YQ==' });
        expect(invoke).toHaveBeenNthCalledWith(4, 'finish_attachment_upload', { uploadId: 'upload' });
    });

    it('commits empty files without sending empty chunks', async () => {
        await uploadInChunks(new File([], 'empty'), 'empty', 'memo');
        expect(readFileBase64).not.toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('cancels a session when reading fails', async () => {
        vi.mocked(readFileBase64).mockRejectedValue(new Error('read failed'));
        await expect(uploadInChunks(new File(['x'], 'file'), 'file', 'memo')).rejects.toThrow('read failed');
        expect(invoke).toHaveBeenLastCalledWith('cancel_attachment_upload', { uploadId: 'upload' });
    });

    it('does not begin after cancellation', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(uploadInChunks(new File([], 'file'), 'file', 'memo', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('cancels a session returned after the caller aborts', async () => {
        const controller = new AbortController();
        vi.mocked(invoke).mockImplementationOnce(async () => { controller.abort(); return 'upload'; });
        await expect(uploadInChunks(new File(['x'], 'file'), 'file', 'memo', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(readFileBase64).not.toHaveBeenCalled();
        expect(invoke).toHaveBeenLastCalledWith('cancel_attachment_upload', { uploadId: 'upload' });
    });

    it('returns a completed write for recovery even if cancellation arrives during commit', async () => {
        const controller = new AbortController();
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === 'begin_attachment_upload') return 'upload';
            if (command === 'finish_attachment_upload') controller.abort();
            return { path: '/attachments/file', created: true };
        });
        expect(await uploadInChunks(new File([], 'file'), 'file', 'memo', controller.signal)).toEqual({ path: '/attachments/file', created: true });
        expect(invoke).toHaveBeenCalledTimes(2);
    });
});
