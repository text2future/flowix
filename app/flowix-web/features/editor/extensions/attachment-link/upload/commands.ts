import { invoke } from '@tauri-apps/api/core';
import type { Editor } from '@tiptap/core';
import { buildUploadContent, insertUploadContent, normalizeUploadContentForInsert } from '@features/editor/extensions/attachment-link/upload/build-content';
import { handleFileUpload } from '@features/editor/extensions/attachment-link/upload/plugin';
import { createAttachmentUploadFromPaths } from '@features/editor/extensions/attachment-link/upload/storage';
import type { OpenFileDialogParams } from '@features/editor/extensions/attachment-link/upload/file-source';
import { isTauriApp } from '@features/editor/extensions/attachment-link/upload/file-source';

export function createAttachmentCommands() {
    return {
        openFileDialog:
            (params?: OpenFileDialogParams) =>
            ({ editor }: { editor: Editor }) => {
                if (!editor.isEditable) return false;

                if (isTauriApp()) {
                    void (async () => {
                        try {
                            const paths = await invoke<string[] | null>('select_files');
                            if (!paths?.length) return;
                            const result = await createAttachmentUploadFromPaths(paths);
                            const content = normalizeUploadContentForInsert(buildUploadContent(result.assets));
                            if (content.length > 0) {
                                editor.commands.focus();
                                insertUploadContent(
                                    editor.view,
                                    content,
                                    undefined,
                                    params?.replaceRange
                                );
                            }
                        } catch (err) {
                            console.error('[FileUpload] Upload failed:', err);
                        }
                    })();
                    return true;
                }

                const input = document.createElement('input');
                let settled = false;
                input.type = 'file';
                input.accept = params?.accept ?? '';
                input.multiple = params?.multiple ?? true;
                input.style.position = 'fixed';
                input.style.left = '-9999px';

                const cleanup = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(safetyTimer);
                    input.onchange = null;
                    input.oncancel = null;
                    window.removeEventListener('focus', handleWindowFocus, true);
                    input.remove();
                };

                const safetyTimer = window.setTimeout(cleanup, 300_000);

                const handleWindowFocus = () => {
                    window.setTimeout(() => {
                        if (!settled && (input.files?.length ?? 0) === 0) {
                            cleanup();
                        }
                    }, 0);
                };

                input.oncancel = cleanup;

                input.onchange = async () => {
                    try {
                        const files = Array.from(input.files || []);
                        if (files.length > 0) {
                            void handleFileUpload(
                                editor.view,
                                files,
                                undefined,
                                params?.replaceRange
                            );
                        }
                    } finally {
                        cleanup();
                    }
                };

                document.body.appendChild(input);
                window.addEventListener('focus', handleWindowFocus, true);
                input.click();
                return true;
            },

        insertFiles:
            (params: { files: File[]; position?: number }) =>
            ({ editor }: { editor: Editor }) => {
                if (!editor.isEditable) return false;
                void handleFileUpload(editor.view, params.files, params.position);
                return true;
            },
    } as any;
}
