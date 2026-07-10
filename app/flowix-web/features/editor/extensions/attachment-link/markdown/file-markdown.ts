import { assetMarkdownUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';

export function isAttachmentMarkdownUrl(url: string): boolean {
    return /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i.test(url);
}

export function parseFileAttachmentMarkdown(token: any) {
    const { url, title } = token;

    return {
        type: 'fileAttachment',
        attrs: {
            url,
            name: title ?? null,
            mimeType: null,
            size: 0,
            storageMode: 'attachment',
            storageKey: decodeStorageKey(url),
        },
    };
}

export function renderFileAttachmentMarkdown(node: any) {
    const { storageMode, storageKey, url, name } = node.attrs ?? {};
    const fileUrl = storageMode === 'attachment' && storageKey
        ? assetMarkdownUrl(String(storageKey))
        : url ?? '';
    return `[${name ?? ''}](${fileUrl})`;
}
