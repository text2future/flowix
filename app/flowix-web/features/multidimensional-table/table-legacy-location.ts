import { datasetLocation } from '@features/collection/public/dataset-filter-api';
import type { MultidimensionalTableDocument } from './model';

/** Only legacy standalone locations collect notes automatically. Folder trees are separate. */
export function legacyTableLocationFilter(document: MultidimensionalTableDocument): Record<string, unknown> | null {
  if (document.collection.placement === 'folder') return null;
  const { filter, source } = document.dataset;
  if (filter && datasetLocation({ filter }) !== null) return filter;
  if (source.scope === 'folder' && source.path !== undefined) {
    return { path: source.path, match: 'all', conditions: [] };
  }
  return null;
}
