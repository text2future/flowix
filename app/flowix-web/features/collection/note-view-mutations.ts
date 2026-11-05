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
import { CollectionDocumentWriteError, createCollectionDocument, mutateCollectionDocument, type CollectionDocumentMutation } from './document-gateway';

/**
 * Add one requested note layout, preserving every other domain and checking concurrent writes.
 *
 * 走 `mutateCollectionDocument` 而不是自己 read+write：除了一次冲突重放（表格正在保存
 * 单元格时点「新增视图」不会直接失败），落盘后还会广播内容，表格面板与外壳 summary
 * 立刻跟上 —— 否则 tab 已经切到「日历」，表格里却还是旧视图。
 */
export async function addCollectionNoteView(
  indexPath: string,
  notebookPath: string,
  layout: TableViewType,
  folderPath?: string | null,
  fieldId?: string,
): Promise<AddCollectionViewResult> {
  const appendView = (current: string | null): CollectionDocumentMutation<{ viewId: string }> =>
    addNoteViewToCollection(current, notebookPath, indexPath, layout, folderPath ?? null, fieldId);

  try {
    const { content, result } = await mutateCollectionDocument({ indexPath, notebookPath, mutate: appendView });
    return { summary: summarizeFolderCollectionSource(content), viewId: result.viewId };
  } catch (error) {
    // 读改写会自己报告「文件不存在」：文件夹入口按模板就地建一份，其它入口照原样抛。
    if (!(error instanceof CollectionDocumentWriteError) || error.status !== 'missing' || !folderPath) throw error;
    const created = appendView(null);
    const content = await createCollectionDocument({ indexPath, notebookPath, content: created.content });
    return { summary: summarizeFolderCollectionSource(content), viewId: created.result.viewId };
  }
}

/**
 * 在给定集合源文本上追加一个笔记视图（纯函数：冲突重试时会用新读到的 source 再跑一次）。
 * `source === null` 表示集合文件尚未存在，按模板新建一份只含 notes 域的集合。
 */
function addNoteViewToCollection(
  source: string | null,
  notebookPath: string,
  indexPath: string,
  layout: TableViewType,
  folderPath: string | null,
  fieldId: string | undefined,
): CollectionDocumentMutation<{ viewId: string }> {
  const hybrid = source !== null && isHybridCollectionSource(source) ? parseHybridCollection(source) : null;
  const envelope = source !== null && !hybrid ? parseCollectionDocumentV2(source) : null;
  const hasNotes = hybrid ? Boolean(hybrid.payload.domains.notes) : envelope?.collection.type === 'table';
  if (source !== null && hasNotes) {
    const current = parseTableDocument(source);
    const added = fieldId && !(layout === 'calendar' && fieldId === '__note_calendar_date__') ? addTableView(current, layout, fieldId) : layout === 'kanban' ? addKanbanView(current)
      : layout === 'calendar' ? addCalendarDateView(current) : addTableView(current, layout);
    return {
      content: serializeProjectedCollectionDocument(source, added.document as unknown as ProjectedCollectionDocument, hybrid ? 'notes' : null),
      result: { viewId: added.view.id },
    };
  }

  const placement = hybrid?.collection.placement ?? envelope?.collection.placement ?? (folderPath ? 'folder' : 'standalone');
  const table = createTableDocument(layout, '集合', placement);
  if (layout === 'calendar' && fieldId) table.views.items[0].config.date_field = fieldId;
  if (placement === 'folder') {
    const directory = folderPath ?? indexPath.replace(/[\\/][^\\/]*$/, '');
    const relativeFolder = notebookRelativeDirectoryPath(notebookPath, directory);
    table.dataset.source = { scope: 'containing_folder' };
    table.dataset.filter = { path: relativeFolder, match: 'all', conditions: [{ field: 'kind', op: 'eq', value: 'note' }] };
    initializeFolderCollectionBanner(table.collection.properties);
  }
  const viewId = table.views.default_id;
  const existingDomain = envelope && !hybrid && envelope.collection.type !== 'hybrid' ? collectionTypeDomain(envelope.collection.type) : null;
  const previousViews = envelope?.payload.views as { default_id: string; items: Record<string, unknown>[] } | undefined;
  const collection = hybrid
    ? reviseCollection(hybrid.collection)
    : envelope ? reviseCollection(envelope.collection) : table.collection;
  const next: HybridCollectionDocument = {
    format: 'flowix.collection', schema_version: 3,
    collection: { ...collection, type: 'hybrid' },
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
  return { content: serializeHybridCollectionDocument(next), result: { viewId } };
}
