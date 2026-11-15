/**
 * Legacy `asset://` Markdown destination compatibility.
 *
 * New documents store regular relative or absolute filesystem paths. Keep the
 * decoder so existing Markdown continues to load and can be migrated on save.
 */
import { encodeAbsoluteDocumentPath } from './document-relative-path';

export function isRuntimeAssetHref(href: string): boolean {
  return /^(?:(?:flowix-asset|asset):\/\/|https?:\/\/asset\.localhost\/)/i.test(href);
}

/** Authored Markdown paths take precedence over transient WebView URLs. */
export function markdownAssetHref(source: unknown, storageMode: unknown, storageKey: unknown): string {
  const authored = typeof source === 'string' ? source : '';
  if (authored && !isRuntimeAssetHref(authored)) return authored;
  return storageMode === 'attachment' && typeof storageKey === 'string' && storageKey
    ? encodeAbsoluteDocumentPath(storageKey)
    : authored;
}

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

export function isVideoUrl(src: string | null | undefined): boolean {
  return !!src && /\.(mp4|mov|webm)(\?|$)/i.test(src);
}
