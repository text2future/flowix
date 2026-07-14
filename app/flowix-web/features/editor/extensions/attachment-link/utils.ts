// ─── Storage Key Utilities ─────────────────────────────────────────────────────
import { convertFileSrc } from '@tauri-apps/api/core';

export function decodeStorageKey(src: string): string | null {
    if (!src.startsWith('asset://') && !src.startsWith('http://asset.localhost/') && !src.startsWith('https://asset.localhost/')) return null;
    try {
        const encoded = src
            .replace('asset://localhost/', '')
            .replace('http://asset.localhost/', '')
            .replace('https://asset.localhost/', '');
        return decodeURIComponent(encoded);
    } catch {
        return null;
    }
}

export function assetMarkdownUrl(storageKey: string | null | undefined): string {
    if (!storageKey) return '';
    const encoded = encodeURIComponent(storageKey)
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
    return `asset://localhost/${encoded}`;
}

// Only match actual video file extensions - NOT all asset:// URLs
export function isVideoUrl(src: string | null | undefined): boolean {
    if (!src) return false;
    return /\.(mp4|mov|webm)(\?|$)/i.test(src);
}

export function assetUrl(storageKey: string | null | undefined): string {
    if (!storageKey) return '';
    return convertFileSrc(storageKey);
}

export function safeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_');
}
