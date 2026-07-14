import { Extension } from '@tiptap/core';
import { ImageAttachment } from '@features/editor/extensions/attachment-link/nodes/view-image';
import { VideoAttachment } from '@features/editor/extensions/attachment-link/nodes/view-video';
import { FileAttachment } from '@features/editor/extensions/attachment-link/nodes/view-file';
import { createAttachmentCommands } from '@features/editor/extensions/attachment-link/upload/commands';
import { createFileUploadPlugin } from '@features/editor/extensions/attachment-link/upload/plugin';
import type { AttachmentUploadOptions, OpenFileDialogParams } from '@features/editor/extensions/attachment-link/upload/file-source';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        attachmentLink: {
            openFileDialog: (params?: OpenFileDialogParams) => ReturnType;
        };
    }
}

const defaultOptions: AttachmentUploadOptions = {
    storage: { mode: 'attachment' },
    picker: { accept: undefined, multiple: true },
    ingest: { paste: true, drop: true, allowedMimeTypes: [], maxFileSize: Infinity },
    onError: undefined,
};

function normalizeOptions(options: Partial<AttachmentUploadOptions> = {}) {
    return {
        storage: { mode: options.storage?.mode ?? 'attachment' },
        ingest: {
            paste: options.ingest?.paste ?? true,
            drop: options.ingest?.drop ?? true,
            allowedMimeTypes: options.ingest?.allowedMimeTypes ?? [],
            maxFileSize: options.ingest?.maxFileSize ?? Infinity,
        },
        onError: options.onError,
    };
}

export const AttachmentLink = Extension.create<AttachmentUploadOptions>({
    name: 'attachmentLink',

    addOptions() {
        return defaultOptions;
    },

    addProseMirrorPlugins() {
        const opts = normalizeOptions(this.options);
        return [
            createFileUploadPlugin({
                ingest: {
                    drop: opts.ingest.drop,
                    paste: false,
                    allowedMimeTypes: opts.ingest.allowedMimeTypes,
                },
            }),
        ];
    },

    addExtensions() {
        return [ImageAttachment, VideoAttachment, FileAttachment];
    },

    addCommands() {
        return createAttachmentCommands();
    },
});

export { ImageAttachment } from '@features/editor/extensions/attachment-link/nodes/view-image';
export { VideoAttachment } from '@features/editor/extensions/attachment-link/nodes/view-video';
export { FileAttachment } from '@features/editor/extensions/attachment-link/nodes/view-file';
export { decodeStorageKey, isVideoUrl } from '@features/editor/extensions/attachment-link/utils';
export type { StoredAsset } from '@features/editor/extensions/attachment-link/upload/file-source';
export { createAttachmentUpload, createAttachmentUploadFromPaths } from '@features/editor/extensions/attachment-link/upload/storage';
export { buildUploadContent } from '@features/editor/extensions/attachment-link/upload/build-content';
export { fileUploadPluginKey } from '@features/editor/extensions/attachment-link/upload/plugin';
