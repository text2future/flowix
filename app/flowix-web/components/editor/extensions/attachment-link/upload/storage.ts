import { invoke } from '@tauri-apps/api/core';
import type { StoredAsset } from './file-source';
import { assetUrl, safeFileName } from '../utils';
import { fileNameFromPath, getFileKind, getFileKindFromName, mimeTypeFromName } from './file-source';

export async function createAttachmentUpload(files: File[]): Promise<{ assets: StoredAsset[] }> {
    const assets: StoredAsset[] = [];

    for (const file of files) {
        const kind = getFileKind(file);
        const fileName = safeFileName(file.name);

        const base64Content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = String(reader.result || '');
                const base64 = result.includes(',') ? result.split(',')[1] : result;
                resolve(base64);
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });

        let storageKey: string | null = null;
        try {
            storageKey = await invoke<string | null>('save_attachment_content', {
                content: base64Content,
                fileName,
                notebookId: null,
            });
        } catch (err) {
            console.error('[FileUpload] Failed to save attachment:', err);
        }

        const blobUrl = URL.createObjectURL(file);
        assets.push({
            kind,
            url: blobUrl,
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            fileName,
            storageMode: 'attachment',
            storageKey,
            revokeObjectURL: true,
        });
    }

    return { assets };
}

export async function createAttachmentUploadFromPaths(paths: string[]): Promise<{ assets: StoredAsset[] }> {
    const assets: StoredAsset[] = [];

    for (const path of paths) {
        const name = fileNameFromPath(path);
        const fileName = safeFileName(name);
        let storageKey: string | null = null;

        try {
            storageKey = await invoke<string | null>('save_attachment', {
                sourcePath: path,
                notebookId: null,
            });
        } catch (err) {
            console.error('[FileUpload] Failed to save attachment:', err);
        }

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
