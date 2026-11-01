import { files, externalDocuments } from '@platform/tauri/client';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import {
  addCalendarDateView, addKanbanView, addTableView, createTableDocument, parseTableDocument,
  type TableViewType,
} from '@features/multidimensional-table/public/create-api';
import {
  collectionTypeDomain, isHybridCollectionSource, parseCollectionDocumentV2, parseHybridCollection,
  reviseCollection, serializeHybridCollectionDocument, serializeProjectedCollectionDocument,
  type HybridCollectionDocument, type HybridCollectionView, type ProjectedCollectionDocument,
} from './model';
import { initializeFolderCollectionBanner, summarizeFolderCollectionSource, type AddCollectionViewResult } from './folder-collection';

/** Add one requested note layout, preserving every other domain and checking concurrent writes. */
export async function addCollectionNoteView(indexPath: string, notebookPath: string, layout: TableViewType, folderPath?: string | null, fieldId?: string): Promise<AddCollectionViewResult> {
  const source = await files.read(indexPath, notebookPath);
  const hybrid = source !== null && isHybridCollectionSource(source) ? parseHybridCollection(source) : null;
  const envelope = source !== null ? parseCollectionDocumentV2(source) : null;
  const hasNotes = hybrid ? Boolean(hybrid.payload.domains.notes) : envelope?.collection.type === 'table';
  let content: string;
  let viewId: string;
  if (source !== null && hasNotes) {
    const current = parseTableDocument(source);
    const added = fieldId && !(layout === 'calendar' && fieldId === '__note_calendar_date__') ? addTableView(current, layout, fieldId) : layout === 'kanban' ? addKanbanView(current)
      : layout === 'calendar' ? addCalendarDateView(current) : addTableView(current, layout);
    viewId = added.view.id;
    content = serializeProjectedCollectionDocument(source, added.document as unknown as ProjectedCollectionDocument, hybrid ? 'notes' : null);
  } else {
    if (source === null && !folderPath) throw new Error('集合文件不存在');
    const placement = envelope?.collection.placement ?? 'folder';
    const table = createTableDocument(layout, '集合', placement);
    if (layout === 'calendar' && fieldId) table.views.items[0].config.date_field = fieldId;
    if (placement === 'folder') {
      const directory = folderPath ?? indexPath.replace(/[\\/][^\\/]*$/, '');
      const relativeFolder = notebookRelativeDirectoryPath(notebookPath, directory);
      table.dataset.source = { scope: 'containing_folder', depth: 'direct_children' };
      table.dataset.filter = { path: relativeFolder, match: 'all', conditions: [{ field: 'kind', op: 'eq', value: 'note' }] };
      initializeFolderCollectionBanner(table.collection.properties);
    }
    viewId = table.views.default_id;
    const existingDomain = envelope && !hybrid && envelope.collection.type !== 'hybrid' ? collectionTypeDomain(envelope.collection.type) : null;
    const previousViews = envelope?.payload.views as { default_id: string; items: Record<string, unknown>[] } | undefined;
    const next: HybridCollectionDocument = {
      format: 'flowix.collection', schema_version: 3,
      collection: { ...(envelope ? reviseCollection(hybrid?.collection ?? envelope.collection) : table.collection), type: 'hybrid' },
      payload: {
        schema_version: 3,
        file_tree: hybrid?.payload.file_tree ?? placement === 'folder',
        domains: { ...(hybrid?.payload.domains ?? (existingDomain && envelope ? { [existingDomain]: envelope.payload.dataset } : {})), notes: table.dataset as unknown as Record<string, unknown> },
        views: {
          default_by_domain: { ...(hybrid?.payload.views.default_by_domain ?? (existingDomain && previousViews ? { [existingDomain]: previousViews.default_id } : {})), notes: viewId },
          items: [
            ...(hybrid?.payload.views.items ?? (existingDomain && previousViews ? previousViews.items.map((view) => ({ ...view, domain: existingDomain } as unknown as HybridCollectionView)) : [])),
            ...table.views.items.map((view) => ({ ...view, domain: 'notes' as const })),
          ],
        },
      },
    };
    content = serializeHybridCollectionDocument(next);
  }
  if (source === null) await files.create(indexPath, content, notebookPath);
  else {
    const result = await externalDocuments.write({ filePath: indexPath, scopePath: notebookPath, expectedContent: source, content });
    if (result.status !== 'saved') throw new Error('集合文件已变化，请重试');
    content = result.content;
  }
  return { summary: summarizeFolderCollectionSource(content), viewId };
}
