import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { createAttachmentUpload } from '@features/editor/extensions/attachment-link/upload/storage';
import { filterFilesByMimeTypes, filterIncomingFiles, hasClipboardHtmlContent } from '@features/editor/extensions/attachment-link/upload/file-source';

import { fileUploadPluginKey, runTrackedUpload, uploadState, uploadView } from './pending';
export { fileUploadPluginKey } from './pending';

export async function handleFileUpload(
    view: EditorView,
    files: File[],
    position?: number,
    replaceRange?: { from: number; to: number },
    ownerPath?: string,
) {
    try {
        const filteredFiles = filterIncomingFiles(files);
        if (filteredFiles.length === 0) return;

        await runTrackedUpload(view, async (signal) =>
            (await createAttachmentUpload(filteredFiles, undefined, undefined, ownerPath, signal)).assets,
        position, replaceRange, ownerPath);
    } catch (err) {
        console.error('[FileUpload] Upload failed:', err);
    }
}

export function createFileUploadPlugin(options: {
    ownerPath?: string;
    ingest: { drop: boolean; paste: boolean; allowedMimeTypes?: string[] };
}) {
    const { ingest } = options;

    return new Plugin({
        key: fileUploadPluginKey,
        state: uploadState,
        view: uploadView,
        props: {
            handleDrop(view, event) {
                if (view.editable === false) return false;
                if (!ingest.drop) return false;
                const dt = event.dataTransfer;
                if (!dt) return false;
                const files = Array.from(dt.files || []);
                const filteredFiles = filterFilesByMimeTypes(files, ingest.allowedMimeTypes);
                if (filteredFiles.length === 0) return false;
                event.preventDefault();
                event.stopPropagation();
                const coords = { left: event.clientX, top: event.clientY };
                const pos = view.posAtCoords(coords)?.pos;
                handleFileUpload(view, filteredFiles, pos, undefined, options.ownerPath);
                return true;
            },
            handlePaste(view, event) {
                if (view.editable === false) return false;
                if (!ingest.paste) return false;
                const files = filterFilesByMimeTypes(
                    Array.from(event.clipboardData?.files || []),
                    ingest.allowedMimeTypes
                );
                if (files.length === 0) return false;
                const htmlContent = event.clipboardData?.getData('text/html') ?? '';
                if (hasClipboardHtmlContent(htmlContent)) return false;
                event.preventDefault();
                event.stopPropagation();
                const pos = view.state.selection.from;
                handleFileUpload(view, files, pos, undefined, options.ownerPath);
                return true;
            },
        },
    });
}
