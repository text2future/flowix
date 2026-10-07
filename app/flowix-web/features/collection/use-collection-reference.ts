import { useEffect, useState } from 'react';
import { collections, externalDocuments, type CollectionIndexItem } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { bindCollectionDisplayPath, ensureCollectionDisplay, pinCollectionDisplay } from '@/lib/collection-display-registry';
import type { FileDisplayIdentity } from '@/lib/file-display-registry';
import { canonicalDirectoryPath } from '@/lib/path';
import { parseCollectionEnvelope, type CollectionType } from './model';
import { subscribeLocalCollectionChanges } from './events';

interface ReferenceState {
  key: string;
  item: CollectionIndexItem | null;
  content: string | null;
  fileIdentity: FileDisplayIdentity | undefined;
  error: string | null;
}

/** An embedded reference resolves its ID; serialized paths are hints only. */
export function useCollectionReference(notebook: { id: string; path: string } | undefined, collectionId: string | null, type: CollectionType, viewId: string | null = null, enabled = true) {
  const root = notebook ? canonicalDirectoryPath(notebook.path) : null;
  const key = JSON.stringify([notebook?.id, root, collectionId, type, viewId]);
  const [state, setState] = useState<ReferenceState>({ key: '', item: null, content: null, fileIdentity: undefined, error: null });
  useEffect(() => {
    if (!enabled || !notebook || !root || !collectionId) return;
    const display = ensureCollectionDisplay({ notebookId: notebook.id, collectionId, viewId });
    const release = pinCollectionDisplay(display.displayId);
    let active = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const item = await collections.resolve(notebook.id, collectionId);
        if (item.identityConflict || item.parseState !== 'valid' || item.collectionType !== type) throw new Error('集合身份冲突或格式暂不可用');
        const path = `${root}/${item.relativePath}`;
        const content = await externalDocuments.read(path, root);
        const envelope = parseCollectionEnvelope(content);
        if (envelope.collection.id !== collectionId || envelope.collection.type !== type) throw new Error('集合身份已变化');
        if (viewId) {
          const views = type === 'table' ? (envelope.payload.table as { views: Array<{ id: string }> }).views : [envelope.payload.view as { id: string }];
          if (!views.some((view) => view.id === viewId)) throw new Error('此集合视图已不存在');
        }
        if (!active || request !== generation) return;
        if (!bindCollectionDisplayPath(display.displayId, path, item.indexSequence)) { void refresh(); return; }
        setState({ key, item, content, fileIdentity: { path, displayId: display.displayId }, error: null });
      } catch (error) {
        if (active && request === generation) setState({ key, item: null, content: null, fileIdentity: undefined, error: error instanceof Error ? error.message : String(error) });
      }
    };
    void refresh();
    const matches = (event: { notebookId: string; collectionId?: string }) => event.notebookId === notebook.id && (!event.collectionId || event.collectionId === collectionId);
    const stopCollection = subscribe<{ notebookId: string; collectionId: string }>('collection-changed', (event) => { if (matches(event)) void refresh(); });
    const stopPath = subscribe<{ notebookId: string; relativePath?: string }>('flowix:path-note-changed', (event) => {
      if (matches(event) && (!event.relativePath || /\.(table|lib)\.ya?ml$/i.test(event.relativePath))) void refresh();
    });
    const stopLocal = subscribeLocalCollectionChanges((event) => { if (matches({ notebookId: event.notebookId, collectionId: event.item.collectionId ?? undefined })) void refresh(); });
    return () => { active = false; stopCollection(); stopPath(); stopLocal(); release?.(); };
  }, [enabled, notebook?.id, root, collectionId, type, viewId, key]);
  return state.key === key ? state : { key, item: null, content: null, fileIdentity: undefined, error: null };
}
