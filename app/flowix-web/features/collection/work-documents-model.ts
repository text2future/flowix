/**
 * `work_documents` 集合类型的文档适配层。
 *
 * 它只是集合协议的一层薄封装：`createCollectionMetadata` / `parseCollectionDocumentV2`
 * 全都来自 `./model`，这里补上列表视图的默认形状、`kind` 过滤规则与文件名约定。
 * 放在 collection 内部而不是独立 feature，是为了让**读文件的每一层**（集合恢复、
 * 资料列表视图、嵌入页、创建对话框）不必反向依赖负责「编辑器里怎么显示」的
 * `features/work-documents`：那个 feature 反过来要读 surface 的列表视图、memo 的
 * 笔记本信息和 collection 的引用解析，双向依赖会把懒加载边界和测试隔离一起打掉。
 */
import {
  createCollectionMetadata,
  createUuidV7,
  parseCollectionDocumentV2,
  serializeCollectionDocumentV2,
  type CollectionMetadata,
  type CollectionSource,
} from './model';
import { createUniqueNotebookFile } from './create-unique-notebook-file';
import { ASSET_KINDS, type AssetKind } from './asset-filter';
import { sanitizeFileName } from '@/lib/export-utils';
import { normalizeCollectionLocation } from './shared-dataset-location';

export const WORK_DOCUMENT_KINDS = ['document', 'spreadsheet', 'presentation', 'web', 'archive', 'database'] as const;
export type WorkDocumentsKind = typeof WORK_DOCUMENT_KINDS[number];

export function workDocumentsResourceKindsChanged(resourceKinds?: readonly string[]): boolean {
  return resourceKinds === undefined
    || resourceKinds.some((kind) => WORK_DOCUMENT_KINDS.includes(kind as WorkDocumentsKind));
}

export interface WorkDocumentsFilterCondition {
  file_name_contains?: string;
  /** 旧数据的单选类型条件；新写入统一用 `file_types`。 */
  file_type?: WorkDocumentsKind;
  /** 多选类型条件：空/缺省 = 面板类目内全部。落盘为 kind 的 `in` 规则。 */
  file_types?: WorkDocumentsKind[];
  path_contains?: string;
  path_scope?: 'all';
}

export interface WorkDocumentsDocument {
  collection: CollectionMetadata;
  dataset: {
    source: CollectionSource;
    schema: { fields: [] };
    records: { include: []; exclude: [] };
    filter: Record<string, unknown> | null;
  };
  views: {
    default_id: string;
    items: Array<{
      id: string;
      name: string;
      layout: 'gallery';
      filter: Record<string, unknown>;
      sort: Array<{ field: 'modified_at'; direction: 'desc' }>;
      config: Record<string, never>;
    }>;
  };
}

export function normalizeWorkDocumentsCondition(condition?: WorkDocumentsFilterCondition | null): WorkDocumentsFilterCondition {
  const fileTypes = [...new Set((condition?.file_types ?? (condition?.file_type ? [condition.file_type] : []))
    .filter((kind): kind is WorkDocumentsKind => WORK_DOCUMENT_KINDS.includes(kind as WorkDocumentsKind)))]
    .sort((left, right) => WORK_DOCUMENT_KINDS.indexOf(left) - WORK_DOCUMENT_KINDS.indexOf(right));
  const normalized = {
    file_name_contains: condition?.file_name_contains?.trim() ?? '',
    file_types: fileTypes.length && fileTypes.length < WORK_DOCUMENT_KINDS.length ? fileTypes : undefined,
    path_contains: condition?.path_contains?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') ?? '',
    path_scope: condition?.path_scope === 'all' ? 'all' : '',
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value)) as WorkDocumentsFilterCondition;
}

export function workDocumentsFilterFromCondition(condition?: WorkDocumentsFilterCondition | null): Record<string, unknown> | null {
  const normalized = normalizeWorkDocumentsCondition(condition);
  const conditions: Record<string, unknown>[] = [];
  if (normalized.file_name_contains) conditions.push({ field: 'file_name', op: 'contains', value: normalized.file_name_contains });
  if (normalized.file_types?.length === 1) conditions.push({ field: 'kind', op: 'eq', value: normalized.file_types[0] });
  else if (normalized.file_types?.length) conditions.push({ field: 'kind', op: 'in', value: normalized.file_types });
  else if (normalized.file_type) conditions.push({ field: 'kind', op: 'eq', value: normalized.file_type });
  const path = normalized.path_scope === 'all' ? '' : normalized.path_contains || null;
  if (path === null && conditions.length === 0) return null;
  return { path, match: 'all', conditions };
}

/** The compact work-documents editor can only round-trip one name and kind rule. */
export function canEditWorkDocumentsFilter(filter?: Record<string, unknown> | null): boolean {
  if (!filter) return true;
  if (Object.keys(filter).some((key) => !['path', 'match', 'conditions'].includes(key))
    || (filter.path !== null && typeof filter.path !== 'string')
    || filter.match !== 'all'
    || !Array.isArray(filter.conditions)) return false;

  const seenFields = new Set<string>();
  return filter.conditions.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const rule = entry as Record<string, unknown>;
    if (Object.keys(rule).some((key) => !['field', 'op', 'value'].includes(key))
      || typeof rule.field !== 'string'
      || seenFields.has(rule.field)) return false;
    seenFields.add(rule.field);
    if (rule.field === 'file_name') return rule.op === 'contains' && typeof rule.value === 'string';
    if (rule.field === 'kind') {
      if (rule.op === 'eq' && WORK_DOCUMENT_KINDS.includes(rule.value as WorkDocumentsKind)) return true;
      return rule.op === 'in' && Array.isArray(rule.value) && rule.value.length > 0
        && rule.value.every((value) => ASSET_KINDS.includes(value as AssetKind));
    }
    return false;
  });
}

export function createWorkDocumentsCollection(name: string): WorkDocumentsDocument {
  const viewId = `view_${createUuidV7()}`;
  return {
    collection: createCollectionMetadata('work_documents', name),
    dataset: {
      source: { scope: 'notebook' },
      schema: { fields: [] },
      records: { include: [], exclude: [] },
      filter: null,
    },
    views: { default_id: viewId, items: [{
      id: viewId, name: '列表', layout: 'gallery', filter: { all: [], any: [] },
      sort: [{ field: 'modified_at', direction: 'desc' }], config: {},
    }] },
  };
}

export function serializeWorkDocumentsCollection(document: WorkDocumentsDocument): string {
  return serializeCollectionDocumentV2({ format: 'flowix.collection', schema_version: 2,
    collection: document.collection,
    payload: { schema_version: 2, dataset: document.dataset, views: document.views },
  });
}

export function parseWorkDocumentsCollection(source: string): WorkDocumentsDocument {
  const document = parseCollectionDocumentV2(source, 'work_documents');
  return normalizeCollectionLocation({
    collection: document.collection,
    dataset: document.payload.dataset as unknown as WorkDocumentsDocument['dataset'],
    views: document.payload.views as unknown as WorkDocumentsDocument['views'],
  });
}

export async function createWorkDocumentsCollectionFile(
  notebookPath: string,
  relativeFolder: string | null | undefined,
  name: string,
): Promise<{ filePath: string; relativePath: string; document: WorkDocumentsDocument }> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('请输入工作文档集合名称');
  const stem = sanitizeFileName(trimmedName).replace(/\.(?:workdocs|index)\.ya?ml$/i, '');
  if (!stem) throw new Error('工作文档集合名称无效');
  const document = createWorkDocumentsCollection(stem);
  const created = await createUniqueNotebookFile(notebookPath, relativeFolder, stem, '.index.yaml', serializeWorkDocumentsCollection(document));
  return { ...created, document };
}
