import { translate, type AppLanguage } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

export type StoredAsset = {
    kind: 'image' | 'video' | 'file';
    url: string;
    name: string;
    mimeType: string;
    size: number;
    fileName?: string | null;
    storageMode?: 'attachment';
    storageKey?: string | null;
    revokeObjectURL?: boolean;
};

export type AttachmentUploadOptions = {
    storage: { mode: 'attachment' };
    picker: { accept: string | undefined; multiple: boolean };
    ingest: {
        paste: boolean;
        drop: boolean;
        allowedMimeTypes: string[];
        maxFileSize: number;
    };
    onError: undefined;
};

export type OpenFileDialogParams = {
    accept?: string;
    multiple?: boolean;
    replaceRange?: { from: number; to: number };
};

export function getFileKind(file: File): 'image' | 'video' | 'file' {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    return 'file';
}

export function getFileKindFromName(name: string): 'image' | 'video' | 'file' {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg'].includes(ext)) return 'video';
    return 'file';
}

export function mimeTypeFromName(name: string): string {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        json: 'application/json',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
    };
    return mimeTypes[ext] ?? 'application/octet-stream';
}

/**
 * 解析路径尾段作为文件名 ── 当路径无法取出文件名时回落到当前语言下的
 * "附件"。非 React 上下文使用, 由调用方传入 language, 不传则直读
 * user-settings-store (与 errors.ts 的 getLanguage() 同源)。
 */
export function fileNameFromPath(path: string, language?: AppLanguage): string {
    const lang = language ?? useUserSettingsStore.getState().settings.language;
    return path.split(/[\\/]/).pop() || translate(lang, 'editor.attachment.fallback');
}

export function isTauriApp(): boolean {
    return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

export function filterFilesByMimeTypes(files: File[], allowedMimeTypes?: string[]): File[] {
    if (!allowedMimeTypes?.length) return files;
    return files.filter((file) => allowedMimeTypes.includes(file.type));
}

export function filterIncomingFiles(files: File[], maxFileSize?: number): File[] {
    if (!maxFileSize) return files;
    return files.filter((file) => file.size <= maxFileSize);
}

export function hasClipboardHtmlContent(htmlContent: string): boolean {
    return htmlContent.trim().length > 0;
}
