import { Extension, type JSONContent, type MarkdownToken } from '@tiptap/core';
import { decodeStorageKey, markdownAssetHref } from './asset-markdown';
import { escapeMarkdownLinkLabel, readMarkdownLink } from '@features/editor/extensions/shared/markdown-link-destination';

export function isAttachmentMarkdownUrl(url: string): boolean {
    return /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i.test(url);
}

export function parseFileAttachmentMarkdown(token: MarkdownToken) {
    const url = typeof token.url === 'string' ? token.url : '';
    const title = typeof token.title === 'string' ? token.title : null;

    return {
        type: 'fileAttachment',
        attrs: {
            url,
            name: title ?? null,
            mimeType: null,
            size: 0,
            storageMode: isAttachmentMarkdownUrl(url) ? 'attachment' : null,
            storageKey: decodeStorageKey(url),
        },
    };
}

export function renderFileAttachmentMarkdown(node: JSONContent) {
    const { storageMode, storageKey, url, name } = node.attrs ?? {};
    const fileUrl = markdownAssetHref(url, storageMode, storageKey);
    return `[${escapeMarkdownLinkLabel(String(name ?? ''))}](${fileUrl})`;
}

export const fileAttachmentMarkdownSpec = {
    markdownTokenizer: {
        name: 'fileAttachment',
        level: 'inline' as const,
        start(src: string) {
            for (let index = src.indexOf('['); index >= 0; index = src.indexOf('[', index + 1)) {
                const link = readMarkdownLink(src, index);
                if (link && isAttachmentMarkdownUrl(link.url)) return index;
            }
            return -1;
        },
        tokenize(src: string) {
            const link = readMarkdownLink(src);
            if (!link || !isAttachmentMarkdownUrl(link.url)) return undefined;
            return {
                type: 'fileAttachment',
                raw: src.slice(0, link.end + 1),
                url: link.url,
                title: link.label,
            };
        },
    },
    parseMarkdown: parseFileAttachmentMarkdown,
};

export const FileAttachmentMarkdownExtension = Extension.create({
    name: 'fileAttachment',
    ...fileAttachmentMarkdownSpec,
});
