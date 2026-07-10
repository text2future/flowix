import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { buildUploadContent, insertUploadContent, normalizeUploadContentForInsert } from '@features/editor/extensions/attachment-link/upload/build-content';
import { createAttachmentUpload } from '@features/editor/extensions/attachment-link/upload/storage';
import { filterFilesByMimeTypes, filterIncomingFiles, hasClipboardHtmlContent } from '@features/editor/extensions/attachment-link/upload/file-source';

export const fileUploadPluginKey = new PluginKey('editor-file-upload');

export async function handleFileUpload(
    view: EditorView,
    files: File[],
    position?: number,
    replaceRange?: { from: number; to: number }
) {
    try {
        const filteredFiles = filterIncomingFiles(files);
        if (filteredFiles.length === 0) return;

        const result = await createAttachmentUpload(filteredFiles);
        const content = normalizeUploadContentForInsert(buildUploadContent(result.assets));

        if (view.isDestroyed) return;
        if (content.length === 0) return;

        insertUploadContent(view, content, position, replaceRange);
    } catch (err) {
        console.error('[FileUpload] Upload failed:', err);
    }
}

export function createFileUploadPlugin(options: {
    ingest: { drop: boolean; paste: boolean; allowedMimeTypes?: string[] };
}) {
    const { ingest } = options;

    return new Plugin({
        key: fileUploadPluginKey,
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
                handleFileUpload(view, filteredFiles, pos);
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
                handleFileUpload(view, files, pos);
                return true;
            },
        },
    });
}
