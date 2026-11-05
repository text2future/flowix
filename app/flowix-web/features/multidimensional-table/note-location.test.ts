import { expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { createFolderCollectionContent, createFolderHybridCollectionContent } from '../collection/folder-collection';
import { resolveDatasetFilterForLocation } from '../collection/dataset-filter-location';
import { resolveCollectionSaveDirectory } from '../collection/save-location';
import { createTableDocument, parseTableDocument, serializeTableDocument, withTableAutoCollect, tableAutoCollectConfig } from './model';
import { noteInCollectionSource } from './table-view-helpers';
import { noteMatchesCollectionFilter } from './record-filter';

function collectedPaths(document: ReturnType<typeof createTableDocument>, filePath: string, paths: string[]) {
  const fields = document.dataset.schema.fields;
  const primary = document.dataset.schema.primary_field_id;
  const filter = resolveDatasetFilterForLocation(document.dataset.filter, document.collection.placement, filePath, '/book');
  if (!filter) return [];
  return paths.filter((relativePath) => noteInCollectionSource(relativePath, document.dataset.source, filePath, '/book')
    && noteMatchesCollectionFilter({ relativePath, title: relativePath, properties: {} } as NoteEntry, fields, primary, filter));
}

const paths = ['Project/a.md', 'Project/sub/b.md', 'Project/sub/deep/c.md', 'Project2/d.md', 'Other/e.md'];

it.each([
  createFolderCollectionContent('notes', 'Project', 'Project'),
  createFolderHybridCollectionContent('Project', 'Project'),
])('collects all descendant notes from new folder templates', (source) => {
  expect(collectedPaths(parseTableDocument(source), '/book/Project/.index.yaml', paths)).toEqual(paths.slice(0, 3));
});

it('ignores and removes the old folder depth while following a moved index', () => {
  const old = createTableDocument('table', 'Project', 'folder');
  old.dataset.filter = { path: 'Old', match: 'all', conditions: [] };
  const source = serializeTableDocument(old).replace(
    '      scope: containing_folder', '      scope: containing_folder\n      depth: direct_children',
  );
  const loaded = parseTableDocument(source);
  expect(collectedPaths(loaded, '/book/Project/.index.yaml', paths)).toEqual(paths.slice(0, 3));
  expect(loaded.dataset.source).toEqual({ scope: 'containing_folder' });
  expect(serializeTableDocument(loaded)).not.toContain('depth:');
});

it.each(['Other', ''])('uses the selected standalone location %j instead of a stale folder source', (path) => {
  const old = createTableDocument();
  old.dataset.source = { scope: 'folder', path: 'Project' };
  old.dataset.filter = { path, match: 'all', conditions: [] };
  const loaded = parseTableDocument(serializeTableDocument(old));
  expect(collectedPaths(loaded, '/book/Views/notes.index.yaml', paths)).toEqual(path ? ['Other/e.md'] : paths);
});

it('applies a changed standalone location immediately and after saving', () => {
  const old = createTableDocument();
  old.dataset.source = { scope: 'folder', path: 'Project' };
  const changed = withTableAutoCollect(old, { condition: { path: 'Other' } });
  expect(collectedPaths(changed, '/book/Views/notes.index.yaml', paths)).toEqual(['Other/e.md']);
  expect(resolveCollectionSaveDirectory({
    filePath: '/book/Views/notes.index.yaml', notebookPath: '/book', placement: changed.collection.placement,
    source: changed.dataset.source, filter: changed.dataset.filter, defaultDirectory: '/book/Views',
  })).toBe('/book/Other');
  expect(collectedPaths(parseTableDocument(serializeTableDocument(changed)), '/book/Views/notes.index.yaml', paths)).toEqual(['Other/e.md']);
});

it('exposes a manual-only standalone location without enabling auto collection', () => {
  const old = createTableDocument();
  old.dataset.source = { scope: 'folder', path: 'Project' };
  old.dataset.filter = null;
  const loaded = parseTableDocument(serializeTableDocument(old));
  expect(loaded.dataset.filter).toBeNull();
  expect(loaded.dataset.source).toEqual(old.dataset.source);
  expect(tableAutoCollectConfig(loaded)?.condition.path).toBe('Project');
});

it('migrates a hidden standalone scope into the visible location without losing conditions', () => {
  const old = createTableDocument();
  old.dataset.source = { scope: 'folder', path: 'Project' };
  const conditions = [{ field: 'kind', op: 'eq', value: 'note' }];
  old.dataset.filter = { path: null, match: 'all', conditions };
  const loaded = parseTableDocument(serializeTableDocument(old));
  expect(loaded.dataset.filter).toEqual({ path: 'Project', match: 'all', conditions });
  expect(tableAutoCollectConfig(loaded)?.condition.path).toBe('Project');
  expect(collectedPaths(loaded, '/book/View.index.yaml', paths)).toEqual(paths.slice(0, 3));
});
