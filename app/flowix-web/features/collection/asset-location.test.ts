import { expect, it } from 'vitest';
import { createMediaLibrary, parseMediaLibrary, serializeMediaLibrary, matchesMediaCollectionFilter } from '../media-library/model';
import { resolveMediaLibraryAddDirectory } from '../media-library/add-location';
import { createWorkDocumentsCollection, parseWorkDocumentsCollection, serializeWorkDocumentsCollection } from '../work-documents/model';
import { resolveCollectionScope, resolveCollectionLocationScope, pathInCollectionScope } from './collection-scope';
import { resolveDatasetFilterForLocation } from './dataset-filter-location';
import { resolveCollectionSaveDirectory } from './save-location';
import { assetConditionFromFilter } from './asset-filter';
import { createFolderHybridCollectionContent, summarizeFolderCollectionSource } from './folder-collection';

const parsers = [
  { create: createMediaLibrary, parse: parseMediaLibrary, serialize: serializeMediaLibrary },
  { create: createWorkDocumentsCollection, parse: parseWorkDocumentsCollection, serialize: serializeWorkDocumentsCollection },
];

it.each(parsers)('recurses from a moved folder and relocates its filter', ({ create, parse, serialize }) => {
  const old = create('Project');
  old.collection.placement = 'folder';
  old.dataset.source = { scope: 'containing_folder' };
  old.dataset.filter = { path: 'Old', match: 'all', conditions: [] };
  // Both formats share the collection envelope.
  const loaded = parse(serialize(old as never));
  expect(resolveCollectionScope(loaded.dataset.source, '/book/New/.index.yaml', '/book'))
    .toEqual({ relativePath: 'New', depth: 'descendants' });
  const filter = resolveDatasetFilterForLocation(loaded.dataset.filter, loaded.collection.placement, '/book/New/.index.yaml', '/book');
  expect(filter?.path).toBe('New');
  expect(matchesMediaCollectionFilter('New/sub/a.png', 'image', filter)).toBe(true);
  expect(matchesMediaCollectionFilter('Old/a.png', 'image', filter)).toBe(false);
});

it.each(parsers)('uses a standalone selected location over a stale source', ({ create, parse, serialize }) => {
  const old = create('View');
  old.dataset.source = { scope: 'folder', path: 'Old' };
  old.dataset.filter = { path: 'New', match: 'all', conditions: [] };
  const loaded = parse(serialize(old as never));
  expect(loaded.dataset.source).toEqual({ scope: 'notebook' });
  expect(assetConditionFromFilter(loaded.dataset.filter).path_contains).toBe('New');
  const scope = resolveCollectionLocationScope(loaded, '/book/Views/view.index.yaml', '/book');
  expect(scope).toEqual({ relativePath: 'New', depth: 'descendants' });
  expect(pathInCollectionScope('New/sub/a.png', scope)).toBe(true);
  expect(pathInCollectionScope('Old/a.png', scope)).toBe(false);
});

it.each(parsers)('exposes a source-only location without losing legacy OR conditions', ({ create, parse, serialize }) => {
  const old = create('View');
  old.dataset.source = { scope: 'folder', path: 'Project' };
  const any = [{ field: 'file_name', op: 'contains', value: 'a' }];
  old.dataset.filter = { all: [], any };
  const loaded = parse(serialize(old as never));
  expect(loaded.dataset.source).toEqual({ scope: 'notebook' });
  expect(loaded.dataset.filter).toEqual({ all: [{ field: 'path', op: 'contains', value: 'Project' }], any });
});

it('imports gallery and list files into the selected standalone directory', () => {
  const media = createMediaLibrary('Gallery');
  media.dataset.source = { scope: 'folder', path: 'Old' };
  media.dataset.filter = { path: 'New', match: 'all', conditions: [] };
  const gallery = parseMediaLibrary(serializeMediaLibrary(media));
  expect(resolveMediaLibraryAddDirectory({ filePath: '/book/Views/gallery.index.yaml', notebookPath: '/book', document: gallery })).toBe('/book/New');
  const list = createWorkDocumentsCollection('List');
  list.dataset.source = media.dataset.source;
  list.dataset.filter = media.dataset.filter;
  const loaded = parseWorkDocumentsCollection(serializeWorkDocumentsCollection(list));
  expect(resolveCollectionSaveDirectory({ filePath: '/book/Views/list.index.yaml', notebookPath: '/book',
    placement: loaded.collection.placement, source: loaded.dataset.source,
    filter: loaded.dataset.filter, defaultDirectory: '/book/Views',
  })).toBe('/book/New');
});

it('gives all folder domains and the image picker the same recursive scope', () => {
  const source = createFolderHybridCollectionContent('Project', 'Project');
  const summary = summarizeFolderCollectionSource(source);
  for (const domain of ['notes', 'media', 'work_documents'] as const) {
    expect(summary.sources[domain]).toEqual({ scope: 'containing_folder' });
  }
});
