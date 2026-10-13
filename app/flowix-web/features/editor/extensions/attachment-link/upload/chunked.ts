import { invoke } from '@platform/tauri/core';
import { readFileBase64 } from './io';
import type { AttachmentSaveResult } from './file-source';

export const UPLOAD_CHUNK_BYTES = 256 * 1024;

export async function uploadInChunks(
    file: File,
    fileName: string,
    ownerPath: string,
    signal?: AbortSignal,
    deduplicate = false,
): Promise<AttachmentSaveResult> {
    const checkCancelled = () => {
        if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    };
    checkCancelled();
    const uploadId = await invoke<string>('begin_attachment_upload', {
        notePath: ownerPath,
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
