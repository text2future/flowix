import { serializeHybridCollectionDocument, type HybridCollectionDocument } from '@features/collection/public/hybrid-api';
import { createMediaLibrary, createMediaLibraryRecord, serializeMediaLibrary } from '@features/media-library/public/model-api';
import {
  createTableDocument, serializeTableDocument, type MultidimensionalTableDocument,
} from '@features/multidimensional-table/public/create-api';
import {
  createWorkDocumentsCollection, serializeWorkDocumentsCollection, type WorkDocumentsDocument,
} from '@features/collection/public/work-documents-model-api';

/**
 * Real collection files for the embedded-page bridge tests.
 *
 * Hand-written YAML drifts from the parser without anyone noticing: the bridge
 * reads rows through the same parsers the surfaces use, so a fixture that is
 * one field off silently lands in the "explicit records" fallback and the test
 * stays green while proving nothing. Every source here is produced by the
 * product's own factory + serializer, which validate on the way out.
 */

export interface ViewFixture {
  filter?: Record<string, unknown>;
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
}

export interface TableFixtureOptions {
  /** Explicit links, in stored order. */
  include?: string[];
  /** Auto-collect condition (`{ path, match, conditions }`), or null for none. */
  filter?: Record<string, unknown> | null;
  /** Filter/sort of the default view. */
  view?: ViewFixture;
  placement?: 'standalone' | 'folder';
  /** Escape hatch for tests that need a field the factory does not create. */
  build?: (document: MultidimensionalTableDocument) => void;
}

const RECORD_TIME = '2026-01-01T00:00:00.000Z';

export function tableDocument(options: TableFixtureOptions = {}): MultidimensionalTableDocument {
  const placement = options.placement ?? 'standalone';
  const document = createTableDocument('table', '项目', placement);
  // A folder-placed collection must bind its scope to the containing folder;
  // the serializer refuses any other source.
  if (placement === 'folder') document.dataset.source = { scope: 'containing_folder' };
  document.dataset.records.include = (options.include ?? []).map((notePath, index) => ({
    // The schema pins the id shape: `rec_` + 32 hex characters.
    id: `rec_${String(index + 1).padStart(32, '0')}`,
    updated_at: RECORD_TIME,
    note_path: notePath,
  }));
  document.dataset.filter = options.filter ?? null;
  const view = document.views.items[0];
  if (options.view?.filter) view.filter = options.view.filter;
  if (options.view?.sort) view.sort = options.view.sort;
  options.build?.(document);
  return document;
}

export function tableSource(options: TableFixtureOptions = {}): string {
  return serializeTableDocument(tableDocument(options));
}

export interface WorkDocumentsFixtureOptions {
  filter?: Record<string, unknown> | null;
  view?: ViewFixture;
  build?: (document: WorkDocumentsDocument) => void;
}

export function workDocumentsDocument(options: WorkDocumentsFixtureOptions = {}): WorkDocumentsDocument {
  const document = createWorkDocumentsCollection('资料');
  document.dataset.filter = options.filter ?? null;
  const view = document.views.items[0];
  if (options.view?.filter) view.filter = options.view.filter;
  options.build?.(document);
  return document;
}

export function workDocumentsSource(options: WorkDocumentsFixtureOptions = {}): string {
  return serializeWorkDocumentsCollection(workDocumentsDocument(options));
}

/** A media library whose records name files (they carry `relative_path`). */
export function mediaLibrarySource(relativePaths: string[]): string {
  const document = createMediaLibrary('素材');
  document.dataset.records.include = relativePaths
    .map((relativePath, index) => createMediaLibraryRecord('nb-1', relativePath, `res-${index}`));
  return serializeMediaLibrary(document);
}

export interface HybridFixtureOptions {
  notes?: TableFixtureOptions;
  workDocuments?: WorkDocumentsFixtureOptions;
}

/**
 * A schema-v3 hybrid file holding a note table and a document list. Each view
 * carries its `domain`, which is exactly what the bridge uses to pick a reader.
 */
export function hybridSource(options: HybridFixtureOptions = {}): {
  text: string;
  viewIds: Record<'notes' | 'work_documents', string>;
} {
  const table = tableDocument(options.notes);
  const work = workDocumentsDocument(options.workDocuments);
  // A hybrid file reuses one collection identity for all its domains.
  const collection = { ...table.collection, type: 'hybrid' };
  const document = {
    format: 'flowix.collection',
    schema_version: 3,
    collection,
    payload: {
      schema_version: 3,
      file_tree: false,
      domains: { notes: table.dataset, work_documents: work.dataset },
      views: {
        default_by_domain: { notes: table.views.default_id, work_documents: work.views.default_id },
        items: [
          ...table.views.items.map((view) => ({ ...view, domain: 'notes' as const })),
          ...work.views.items.map((view) => ({ ...view, domain: 'work_documents' as const })),
        ],
      },
    },
  } as unknown as HybridCollectionDocument;
  return {
    text: serializeHybridCollectionDocument(document),
    viewIds: { notes: table.views.default_id, work_documents: work.views.default_id },
  };
}
