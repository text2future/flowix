import { invoke } from '@platform/tauri/core';
import type { Editor, RawCommands } from '@tiptap/core';
import { handleFileUpload } from './plugin';
import { createAttachmentUpload, createAttachmentUploadFromPaths } from './storage';
import { runTrackedUpload } from './pending';
import type { OpenFileDialogParams } from './file-source';
import { isTauriApp } from './file-source';

function pickBrowserFiles(params: OpenFileDialogParams | undefined, signal: AbortSignal): Promise<File[]> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve([]);
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = params?.accept ?? '';
        input.multiple = params?.multiple ?? true;
        input.style.display = 'none';
        let settled = false;
        const finish = (files: File[]) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener('abort', cancel);
            input.onchange = null;
            input.oncancel = null;
            input.remove();
            resolve(files);
        };
        const cancel = () => finish([]);
        const timeout = window.setTimeout(cancel, 300_000);
        signal.addEventListener('abort', cancel, { once: true });
        input.onchange = () => finish(Array.from(input.files ?? []));
        input.oncancel = cancel;
        document.body.appendChild(input);
        input.click();
    });
}

export function createAttachmentCommands(ownerPath?: string): Partial<RawCommands> {
    return {
        openFileDialog:
            (params?: OpenFileDialogParams) =>
            ({ editor }: { editor: Editor }) => {
                if (editor.isDestroyed || !editor.isEditable) return false;
                void runTrackedUpload(editor.view, async (signal) => {
                    if (isTauriApp()) {
                        const paths = await invoke<string[] | null>('select_files', {
                            accept: params?.accept ?? null,
                            multiple: params?.multiple ?? true,
                        });
                        if (!paths?.length || signal.aborted) return [];
                        return (await createAttachmentUploadFromPaths(paths, ownerPath, signal)).assets;
                    }
                    const files = await pickBrowserFiles(params, signal);
                    if (signal.aborted) return [];
                    return (await createAttachmentUpload(files, undefined, undefined, ownerPath, signal)).assets;
                }, undefined, params?.replaceRange, ownerPath);
                return true;
            },

        insertFiles:
            (params: { files: File[]; position?: number }) =>
            ({ editor }: { editor: Editor }) => {
                if (editor.isDestroyed || !editor.isEditable) return false;
                void handleFileUpload(editor.view, params.files, params.position, undefined, ownerPath);
                return true;
            },
    };
}
