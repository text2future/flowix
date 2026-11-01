import { describe, expect, it } from 'vitest';

import type {
  CollectionIndexItem,
  DocTreeItem,
  MediaLibraryListItem,
  TableDocumentListItem,
} from '@platform/tauri/client';
import {
  buildCollectionPinTargets,
  resolveTreePinRoute,
} from './collection-pin-routing';

const ROOT = '/notes';

function documentRow(name: string, resourceKind?: DocTreeItem['resourceKind']): DocTreeItem {
  return {
    id: `doc:${name}`,
    fullPath: `${ROOT}/${name}`,
    name,
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: null,
    modifiedMs: 0,
    createdMs: 0,
    memoCreatedMs: null,
    resourceKind,
  };
}

function table(relativePath: string, pinned: boolean): TableDocumentListItem {
  return { relativePath, collectionId: `col-${relativePath}`, name: relativePath, modifiedMs: 0, fileRevision: 1, inViews: true, pinned };
}

function library(relativePath: string, pinned: boolean): MediaLibraryListItem {
  return { relativePath, collectionId: `col-${relativePath}`, name: relativePath, modifiedMs: 0, inViews: true, pinned };
}

function workDocuments(relativePath: string, pinned: boolean, collectionId: string | null): CollectionIndexItem {
  return {
    indexSequence: 1,
    relativePath,
    collectionId,
    collectionType: 'work_documents',
    name: relativePath,
    schemaVersion: 2,
    payloadSchemaVersion: 2,
    revision: 1,
    properties: {},
    createdAt: null,
    updatedAt: null,
    modifiedMs: 0,
    sizeBytes: 0,
    contentHash: null,
    parseState: 'valid',
    errorCode: null,
    inViews: true,
    pinned,
    identityConflict: false,
  };
}

function targets(...entries: Array<[string, TableDocumentListItem | MediaLibraryListItem | CollectionIndexItem]>) {
  const tables = new Map<string, TableDocumentListItem>();
  const libraries = new Map<string, MediaLibraryListItem>();
  const collections = new Map<string, CollectionIndexItem>();
  for (const [path, item] of entries) {
    if ('fileRevision' in item) tables.set(path, item);
    else if ('collectionType' in item) collections.set(path, item);
    else libraries.set(path, item);
  }
  return buildCollectionPinTargets(tables, libraries, collections);
}

describe('buildCollectionPinTargets', () => {
  it('keeps the pin flag and kind of every catalog', () => {
    const byPath = targets(
      [`${ROOT}/a.table.yaml`, table('a.table.yaml', true)],
      [`${ROOT}/b.lib.yaml`, library('b.lib.yaml', false)],
      [`${ROOT}/c.workdocs.yaml`, workDocuments('c.workdocs.yaml', true, 'col-c')],
    );
    expect(byPath.get(`${ROOT}/a.table.yaml`)).toEqual({ collectionId: 'col-a.table.yaml', pinned: true, kind: 'table' });
    expect(byPath.get(`${ROOT}/b.lib.yaml`)).toEqual({ collectionId: 'col-b.lib.yaml', pinned: false, kind: 'media_library' });
    expect(byPath.get(`${ROOT}/c.workdocs.yaml`)).toEqual({ collectionId: 'col-c', pinned: true, kind: 'work_documents' });
  });

  it('skips work document rows without an identity', () => {
    const byPath = targets([`${ROOT}/legacy.workdocs.yaml`, workDocuments('legacy.workdocs.yaml', false, null)]);
    expect(byPath.size).toBe(0);
  });
});

describe('resolveTreePinRoute', () => {
  it('routes an indexed collection to the collection command', () => {
    const route = resolveTreePinRoute(
      documentRow('a.table.yaml', 'other'),
      { collectionId: 'col-a', pinned: true, kind: 'table' },
    );
    expect(route).toEqual({ kind: 'collection', target: { collectionId: 'col-a', pinned: true, kind: 'table' } });
  });

  it('routes a plain document to the document command', () => {
    expect(resolveTreePinRoute(documentRow('report.pdf', 'other'), undefined)).toEqual({ kind: 'document' });
  });

  it('hides the pin entry for a legacy collection file the index cannot resolve', () => {
    expect(resolveTreePinRoute(documentRow('old.table.yml', 'other'), undefined)).toEqual({ kind: 'none' });
    expect(resolveTreePinRoute(documentRow('old.lib.yaml', 'other'), undefined)).toEqual({ kind: 'none' });
    expect(resolveTreePinRoute(documentRow('.index.yaml', 'other'), undefined)).toEqual({ kind: 'none' });
  });

  it('never offers a pin entry for notes or folders', () => {
    expect(resolveTreePinRoute(documentRow('note.md', 'note'), undefined)).toEqual({ kind: 'none' });
    // A note row without a resource kind still resolves from the filename.
    expect(resolveTreePinRoute(documentRow('note.md'), undefined)).toEqual({ kind: 'none' });
    expect(resolveTreePinRoute({
      ...documentRow('folder'), type: 'folder',
    }, undefined)).toEqual({ kind: 'none' });
  });
});
