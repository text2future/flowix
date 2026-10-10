import { PluginKey, type StateField } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { StoredAsset } from './file-source';
import { buildUploadContent, insertUploadContent } from './build-content';
import { recordAttachmentRecovery } from './recovery';
import { reportUninsertedAttachments, reportUploadFailure } from './feedback';

type Anchor = { position: number; range?: { from: number; to: number }; controller: AbortController };
type Anchors = Map<number, Anchor>;
type Change = { add?: { id: number; anchor: Anchor }; remove?: number };
export const fileUploadPluginKey = new PluginKey<Anchors>('editor-file-upload');
let nextId = 0;

export const uploadState: StateField<Anchors> = {
    init: () => new Map(),
    apply(transaction, previous) {
        const next: Anchors = new Map();
        for (const [id, anchor] of previous) {
            const position = transaction.mapping.mapResult(anchor.position, 1);
            if (position.deleted) continue;
            const range = anchor.range ? {
                from: transaction.mapping.map(anchor.range.from, 1),
                to: transaction.mapping.map(anchor.range.to, -1),
            } : undefined;
            next.set(id, { ...anchor, position: position.pos, range: range && range.from <= range.to ? range : undefined });
        }
        const change = transaction.getMeta(fileUploadPluginKey) as Change | undefined;
        if (change?.add) next.set(change.add.id, change.add.anchor);
        if (change?.remove !== undefined) next.delete(change.remove);
        return next;
    },
};

export function uploadView(view: EditorView) {
    return {
        update(current: EditorView, previous: Parameters<typeof fileUploadPluginKey.getState>[0]) {
            for (const [id, anchor] of fileUploadPluginKey.getState(previous) ?? []) {
                if (!current.editable || !fileUploadPluginKey.getState(current.state)?.has(id)) anchor.controller.abort();
            }
        },
        destroy() {
            for (const anchor of fileUploadPluginKey.getState(view.state)?.values() ?? []) anchor.controller.abort();
        },
    };
}

export async function runTrackedUpload(
    view: EditorView,
    load: (signal: AbortSignal) => Promise<StoredAsset[]>,
    position?: number,
    range?: { from: number; to: number },
    ownerPath?: string,
): Promise<void> {
    if (view.isDestroyed || !view.editable || !fileUploadPluginKey.getState(view.state)) return;
    const requestedPosition = position ?? range?.from ?? view.state.selection.from;
    if (!Number.isInteger(requestedPosition) || requestedPosition < 0 || requestedPosition > view.state.doc.content.size) {
        reportUploadFailure('Invalid upload position');
        return;
    }
    const id = ++nextId;
    const controller = new AbortController();
    const anchor: Anchor = { position: requestedPosition, range, controller };
    view.dispatch(view.state.tr.setMeta(fileUploadPluginKey, { add: { id, anchor } }).setMeta('addToHistory', false));
    let assets: StoredAsset[] = [];
    let inserted = false;
    try {
        assets = await load(controller.signal);
        const mapped = view.isDestroyed ? undefined : fileUploadPluginKey.getState(view.state)?.get(id);
        if (!controller.signal.aborted && view.editable && mapped && assets.length) {
            insertUploadContent(view, buildUploadContent(assets), mapped.position, mapped.range);
            inserted = true;
        }
    } catch (error) {
        if (!controller.signal.aborted) reportUploadFailure(error);
    } finally {
        if (!inserted && assets.length) {
            recordAttachmentRecovery(assets.flatMap((asset) => asset.storageKey ? [asset.storageKey] : []), ownerPath);
            reportUninsertedAttachments();
        }
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(fileUploadPluginKey, { remove: id }).setMeta('addToHistory', false));
        controller.abort();
    }
}
