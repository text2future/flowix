import { invoke } from '@platform/tauri/core';
import { acquireUploadSlot, readFileBase64 } from './io';
import { reportUploadFailure } from './feedback';
import { uploadInChunks } from './chunked';
import type { StoredAsset } from '@features/editor/extensions/attachment-link/upload/file-source';
import { assetUrl, safeFileName } from '@features/editor/extensions/attachment-link/utils';
import { fileNameFromPath, getFileKind, getFileKindFromName, mimeTypeFromName } from '@features/editor/extensions/attachment-link/upload/file-source';

export type AttachmentContentSaver = (params: { content: string; fileName: string }) => Promise<string | null>;
export type AttachmentFileSaver = (params: { file: File; fileName: string }) => Promise<string | null>;

export const MAX_ATTACHMENT_CONTENT_BYTES = 64 * 1024 * 1024;

export async function createAttachmentUpload(
    files: File[],
    saveContent?: AttachmentContentSaver,
    saveFile?: AttachmentFileSaver,
    memoId?: string,
    signal?: AbortSignal,
): Promise<{ assets: StoredAsset[] }> {
    const assets: StoredAsset[] = [];
    if (!memoId && !saveContent && !saveFile) {
        reportUploadFailure('OWNER_REQUIRED');
        return { assets };
    }

    for (const file of files) {
        if (signal?.aborted) break;
        const kind = getFileKind(file);
        const fileName = safeFileName(file.name);

        let storageKey: string | null = null;
        let release: (() => void) | undefined;
        try {
            release = acquireUploadSlot();
            if (saveFile) {
                storageKey = await saveFile({ file, fileName });
            } else {
                if (file.size > MAX_ATTACHMENT_CONTENT_BYTES) {
                    throw new Error('ATTACHMENT_CONTENT_TOO_LARGE');
                }
                if (saveContent) {
                    const base64Content = await readFileBase64(file, signal);
                    if (signal?.aborted) break;
                    storageKey = await saveContent({ content: base64Content, fileName });
                } else {
                    storageKey = await uploadInChunks(file, fileName, memoId!, signal);
                }
            }
            if (!storageKey) throw new Error('Attachment save returned no path');
        } catch (err) {
            console.error('[FileUpload] Failed to save attachment:', err);
            if (!signal?.aborted) reportUploadFailure(err);
        } finally {
            release?.();
        }

        if (!storageKey) continue;

        assets.push({
            kind,
            url: assetUrl(storageKey),
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            fileName,
            storageMode: 'attachment',
            storageKey,
            revokeObjectURL: false,
        });
    }

    return { assets };
}

export async function createAttachmentUploadFromPaths(paths: string[], memoId?: string, signal?: AbortSignal, notebookId?: string): Promise<{ assets: StoredAsset[] }> {
    const assets: StoredAsset[] = [];
    if (!memoId && !notebookId) {
        reportUploadFailure('OWNER_REQUIRED');
        return { assets };
    }

    for (const path of paths) {
        if (signal?.aborted) break;
        const name = fileNameFromPath(path);
        const fileName = safeFileName(name);
        let storageKey: string | null = null;
        let release: (() => void) | undefined;

        try {
            release = acquireUploadSlot();
            storageKey = await invoke<string | null>('save_attachment', {
                sourcePath: path,
                memoId,
                ...(notebookId ? { notebookId } : {}),
            });
            if (!storageKey) throw new Error('Attachment save returned no path');
        } catch (err) {
            console.error('[FileUpload] Failed to save attachment:', err);
            if (!signal?.aborted) reportUploadFailure(err);
        } finally {
            release?.();
        }

        if (!storageKey) continue;

        assets.push({
            kind: getFileKindFromName(name),
            url: storageKey ? assetUrl(storageKey) : '',
            name,
            mimeType: mimeTypeFromName(name),
            size: 0,
            fileName,
            storageMode: 'attachment',
            storageKey,
        });
    }

    return { assets };
}
