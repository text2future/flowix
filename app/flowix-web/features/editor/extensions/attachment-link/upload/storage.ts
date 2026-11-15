import { files as desktopFiles, notebookAssets } from '@platform/tauri/client';
import { acquireUploadSlot, readFileBase64 } from './io';
import { reportUploadFailure } from './feedback';
import { uploadInChunks } from './chunked';
import type { StoredAsset, AttachmentUploadRequest } from '@features/editor/extensions/attachment-link/upload/file-source';
import { assetUrl, safeFileName } from '@features/editor/extensions/attachment-link/utils';
import { fileNameFromPath, getFileKind, getFileKindFromName, mimeTypeFromName } from '@features/editor/extensions/attachment-link/upload/file-source';
import { documentRelativeHref, encodeAbsoluteDocumentPath, resolvePhysicalDocumentPath } from '@/lib/document-relative-path';

export type AttachmentContentSaver = (params: { content: string; fileName: string }) => Promise<string | null>;
export type AttachmentFileSaver = (params: { file: File; fileName: string }) => Promise<string | null>;

export const MAX_ATTACHMENT_CONTENT_BYTES = 64 * 1024 * 1024;

export type AttachmentPathUploadOptions = AttachmentUploadRequest;

export async function createAttachmentUpload(
    files: File[],
    { saveContent, saveFile, ownerPath, signal, deduplicate = true, externalFileCache = false, notebookId, repositoryPath, documentPath }: AttachmentUploadRequest & {
        saveContent?: AttachmentContentSaver;
        saveFile?: AttachmentFileSaver;
    } = {},
): Promise<{ assets: StoredAsset[] }> {
    const assets: StoredAsset[] = [];
    if (!ownerPath && !notebookId && !externalFileCache && !saveContent && !saveFile) {
        reportUploadFailure('OWNER_REQUIRED');
        return { assets };
    }

    for (const file of files) {
        if (signal?.aborted) break;
        const fileKind = getFileKind(file);
        const kind = fileKind === 'file' ? getFileKindFromName(file.name) : fileKind;
        const fileName = safeFileName(file.name);
        const external = !ownerPath && !notebookId && externalFileCache;
        const candidatePath = (file as File & { path?: unknown }).path;
        const sourcePath = typeof candidatePath === 'string' ? resolvePhysicalDocumentPath(candidatePath)?.path : undefined;

        let storageKey: string | null = null;
        let created = true;
        let release: (() => void) | undefined;
        try {
            release = acquireUploadSlot();
            if (saveFile) {
                storageKey = await saveFile({ file, fileName });
            } else {
                if (saveContent) {
                    if (file.size > MAX_ATTACHMENT_CONTENT_BYTES) throw new Error('ATTACHMENT_CONTENT_TOO_LARGE');
                    const base64Content = await readFileBase64(file, signal);
                    if (signal?.aborted) break;
                    storageKey = await saveContent({ content: base64Content, fileName });
                } else {
                    if (!sourcePath && file.size > MAX_ATTACHMENT_CONTENT_BYTES) throw new Error('ATTACHMENT_CONTENT_TOO_LARGE');
                    const saved = sourcePath
                        ? await saveAttachmentPath(sourcePath, { ownerPath, notebookId, repositoryPath, externalFileCache, deduplicate })
                        : await uploadInChunks(file, fileName, { ownerPath, signal, deduplicate, externalFileCache: external, notebookId, repositoryPath });
                    storageKey = saved?.path ?? null;
                    created = saved?.created ?? false;
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

        const markdownHref = markdownDestination(storageKey, documentPath, external);

        assets.push({
            kind,
            url: assetUrl(storageKey),
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            fileName,
            storageMode: 'attachment',
            storageKey,
            markdownHref,
            created,
            revokeObjectURL: false,
        });
    }

    return { assets };
}

export async function createAttachmentUploadFromPaths(
    paths: string[],
    { ownerPath, notebookId, repositoryPath, documentPath, signal, deduplicate = true, externalFileCache = false }: AttachmentPathUploadOptions = {},
): Promise<{ assets: StoredAsset[] }> {
    const assets: StoredAsset[] = [];
    if (!ownerPath && !notebookId && !externalFileCache) {
        reportUploadFailure('OWNER_REQUIRED');
        return { assets };
    }

    for (const path of paths) {
        if (signal?.aborted) break;
        const name = fileNameFromPath(path);
        const fileName = safeFileName(name);
        const kind = getFileKindFromName(name);
        const external = !ownerPath && !notebookId && externalFileCache;
        let storageKey: string | null = null;
        let created = true;
        let release: (() => void) | undefined;

        try {
            release = acquireUploadSlot();
            const saved = await saveAttachmentPath(path, { ownerPath, notebookId, repositoryPath, externalFileCache, deduplicate });
            if (!saved?.path) throw new Error('Attachment save returned no path');
            storageKey = saved.path;
            created = saved.created;
        } catch (err) {
            console.error('[FileUpload] Failed to save attachment:', err);
            if (!signal?.aborted) reportUploadFailure(err);
        } finally {
            release?.();
        }

        if (!storageKey) continue;

        const markdownHref = markdownDestination(storageKey, documentPath, external);

        assets.push({
            kind,
            url: storageKey ? assetUrl(storageKey) : '',
            name,
            mimeType: mimeTypeFromName(name),
            size: 0,
            fileName,
            storageMode: 'attachment',
            storageKey,
            markdownHref,
            created,
        });
    }

    return { assets };
}

async function saveAttachmentPath(
    sourcePath: string,
    { ownerPath, notebookId, repositoryPath, externalFileCache, deduplicate = true }: AttachmentPathUploadOptions,
) {
    const source = resolvePhysicalDocumentPath(sourcePath);
    if (!source) throw new Error('Absolute attachment source path required');
    if (!ownerPath && !notebookId && externalFileCache) {
        return { path: await desktopFiles.retainReference(source.path), created: false };
    }
    return notebookAssets.saveFromPath(source.path, {
        ...(ownerPath ? { notePath: ownerPath } : { notebookId }),
        ...(repositoryPath ? { repositoryPath } : {}),
        deduplicate,
        // Existing notebook/repository files are referenced in place.
        reuseNotebookFile: true,
    });
}

function markdownDestination(storageKey: string, documentPath: string | undefined, external: boolean): string {
    if (external) return encodeAbsoluteDocumentPath(storageKey);
    const target = resolvePhysicalDocumentPath(storageKey);
    return target && documentPath
        ? documentRelativeHref(target, documentPath) ?? encodeAbsoluteDocumentPath(storageKey)
        : encodeAbsoluteDocumentPath(storageKey);
}
