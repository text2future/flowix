import { Extension } from '@tiptap/core';
import { ImageAttachment } from './nodes/image-attachment';
import { VideoAttachment } from './nodes/video-attachment';
import { FileAttachment } from './nodes/file-attachment';
import { createAttachmentCommands } from './upload/commands';
import { createFileUploadPlugin } from './upload/plugin';
import type { AttachmentUploadOptions, OpenFileDialogParams } from './upload/file-source';

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
                    paste: opts.ingest.paste,
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

export { ImageAttachment } from './nodes/image-attachment';
export { VideoAttachment } from './nodes/video-attachment';
export { FileAttachment } from './nodes/file-attachment';
export { decodeStorageKey, isVideoUrl } from './utils';
export type { StoredAsset } from './upload/file-source';
export { createAttachmentUpload, createAttachmentUploadFromPaths } from './upload/storage';
export { buildUploadContent } from './upload/build-content';
export { fileUploadPluginKey } from './upload/plugin';
