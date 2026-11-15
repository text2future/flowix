import { invoke } from '@platform/tauri/core';
import { readFileBase64 } from './io';
import type { AttachmentSaveResult, AttachmentUploadRequest } from './file-source';

export const UPLOAD_CHUNK_BYTES = 256 * 1024;

export async function uploadInChunks(
    file: File,
    fileName: string,
    { ownerPath, signal, deduplicate = false, externalFileCache = false, notebookId, repositoryPath }: AttachmentUploadRequest = {},
): Promise<AttachmentSaveResult> {
    const checkCancelled = () => {
        if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    };
    checkCancelled();
    if (!ownerPath && !notebookId && !externalFileCache) throw new Error('OWNER_REQUIRED');
    const uploadId = await invoke<string>('begin_attachment_upload', {
        ...(externalFileCache
            ? { externalFileCache: true }
            : ownerPath
                ? { notePath: ownerPath }
                : { notebookId }),
        ...(repositoryPath ? { repositoryPath } : {}),
        fileName,
        size: file.size,
        ...(deduplicate ? { deduplicate: true } : {}),
    });
    let finished = false;
    try {
        checkCancelled();
        for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
            checkCancelled();
            const content = await readFileBase64(file.slice(offset, offset + UPLOAD_CHUNK_BYTES), signal);
            checkCancelled();
            await invoke('append_attachment_upload', { uploadId, offset, content });
        }
        checkCancelled();
        const result = await invoke<AttachmentSaveResult>('finish_attachment_upload', { uploadId });
        finished = true;
        return result;
    } finally {
        if (!finished) {
            await invoke('cancel_attachment_upload', { uploadId }).catch(() => {});
        }
    }
}
