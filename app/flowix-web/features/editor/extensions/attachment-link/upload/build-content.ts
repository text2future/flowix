import type { JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import type { StoredAsset } from '@features/editor/extensions/attachment-link/upload/file-source';
import { assetUrl } from '@features/editor/extensions/attachment-link/utils';

export function buildUploadContent(assets: StoredAsset[]): JSONContent[] {
    return assets.flatMap((asset) => {
        const fileName = asset.fileName ?? asset.name;

        if (asset.kind === 'image') {
            return [{
                type: 'image',
                attrs: {
                    src: assetUrl(asset.storageKey) || asset.url,
                    alt: asset.name,
                    title: asset.name,
                    fileName,
                    mimeType: asset.mimeType,
                    storageMode: asset.storageMode ?? null,
                    storageKey: asset.storageKey ?? null,
                },
            }] as JSONContent[];
        }

        if (asset.kind === 'video') {
            return [{
                type: 'videoAttachment',
                attrs: {
                    src: assetUrl(asset.storageKey) || asset.url,
                    title: asset.name,
                    fileName,
                    mimeType: asset.mimeType,
                    storageMode: asset.storageMode ?? null,
                    storageKey: asset.storageKey ?? null,
                },
            }] as JSONContent[];
        }

        return [{
            type: 'fileAttachment',
            attrs: {
                url: assetUrl(asset.storageKey) || asset.url,
                name: fileName,
                fileName,
                mimeType: asset.mimeType || '',
                size: asset.size ?? 0,
                storageMode: asset.storageMode ?? null,
                storageKey: asset.storageKey ?? null,
            },
        }] as JSONContent[];
    });
}

export function normalizeUploadContentForInsert(content: JSONContent[]): JSONContent[] {
    return content;
}

function canReplaceRangeWithUploadContent(view: EditorView, range: { from: number; to: number }): boolean {
    const node = view.state.doc.nodeAt(range.from);
    return !!node && node.isTextblock && node.textContent.length === 0 && range.to === range.from + node.nodeSize;
}

export function insertUploadContent(
    view: EditorView,
    content: JSONContent[],
    position?: number,
    replaceRange?: { from: number; to: number }
) {
    if (content.length === 0) return;

    let tr = view.state.tr;
    let insertPos = position ?? view.state.selection.from;

    if (replaceRange && canReplaceRangeWithUploadContent(view, replaceRange)) {
        tr = tr.delete(replaceRange.from, replaceRange.to);
        insertPos = tr.mapping.map(replaceRange.from);
    }

    content.forEach((node) => {
        const safeInsertPos = Math.min(insertPos, tr.doc.content.size);
        const $insertPos = tr.doc.resolve(safeInsertPos);
        const pmNode = view.state.schema.nodeFromJSON(
            node.type === 'fileAttachment' && !$insertPos.parent.inlineContent
                ? { type: 'paragraph', content: [node] }
                : node
        );

        tr = tr.insert(safeInsertPos, pmNode);
        insertPos = safeInsertPos + pmNode.nodeSize;
    });

    view.dispatch(tr);
}
