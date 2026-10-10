import { createCollectionMetadata, createUuidV7, parseCollectionEnvelope, serializeCollectionEnvelope, validateCollectionMetadata, type CollectionMetadata } from '@features/collection/model';
import { createUniqueNotebookFile } from '@features/collection/create-unique-notebook-file';
export { createUuidV7 } from '@features/collection/model';
import { sanitizeFileName } from '@/lib/export-utils';

export type MediaLibraryKind = 'image' | 'video';
export interface MediaLibraryFileCondition {
  file_name_contains?: string;
  file_type?: MediaLibraryKind;
  path_contains?: string;
}

export interface MediaLibraryRecord {
  id: string;
  updated_at: string;
  /** Notebook-relative path to an explicitly linked media file. */
  note_path: string;
}

export interface MediaLibraryDatasetEntry {
  relativePath: string;
  kind: MediaLibraryKind;
}

export function normalizeMediaLibraryFileCondition(condition?: MediaLibraryFileCondition | null): MediaLibraryFileCondition {
  const normalized = {
    file_name_contains: condition?.file_name_contains?.trim() ?? '',
    file_type: condition?.file_type ?? '',
    path_contains: condition?.path_contains?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') ?? '',
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value)) as MediaLibraryFileCondition;
}

export function hasMediaLibraryDatasetCondition(condition?: MediaLibraryFileCondition | null): boolean {
  return Object.keys(normalizeMediaLibraryFileCondition(condition)).length > 0;
}

export function matchesMediaLibraryDataset(entry: MediaLibraryDatasetEntry, condition?: MediaLibraryFileCondition | null): boolean {
  const normalized = normalizeMediaLibraryFileCondition(condition);
  if (!Object.keys(normalized).length) return false;
  const relativePath = entry.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const fileName = relativePath.split('/').pop() ?? relativePath;
  if (normalized.file_name_contains && !fileName.toLocaleLowerCase().includes(normalized.file_name_contains.toLocaleLowerCase())) return false;
  if (normalized.file_type && entry.kind !== normalized.file_type) return false;
  if (normalized.path_contains) {
    const directory = relativePath.split('/').slice(0, -1).join('/').toLocaleLowerCase();
    const path = normalized.path_contains.replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
    if (directory !== path && !directory.startsWith(`${path}/`)) return false;
  }
  return true;
}

export interface MediaLibraryDocument {
  collection: CollectionMetadata;
  view: {
    id: string;
    layout: 'waterfall';
    condition: { file_condition?: MediaLibraryFileCondition };
    sort?: { field: 'created_at'; direction: 'desc' };
  };
  records: { data: MediaLibraryRecord[] };
}

const LIBRARY_ID_PATTERN = /^col_[0-9a-f]{32}$/;
const VIEW_ID_PATTERN = /^view_[0-9a-f]{32}$/;

export function createMediaLibraryRecord(notePath: string, now = new Date().toISOString()): MediaLibraryRecord {
  return { id: `rec_${createUuidV7()}`, updated_at: now, note_path: notePath.replace(/\\/g, '/') };
}

export function createMediaLibrary(name: string): MediaLibraryDocument {
  const viewId = createUuidV7();
  return {
    collection: createCollectionMetadata('media_library', name),
    view: {
      id: `view_${viewId}`,
      layout: 'waterfall',
      condition: {},
      sort: { field: 'created_at', direction: 'desc' },
    },
    records: { data: [] },
  };
}

export function serializeMediaLibrary(document: MediaLibraryDocument): string {
  validateMediaLibraryDocument(document);
  return serializeCollectionEnvelope(document.collection, { view: document.view, records: document.records });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMediaLibrary(source: string): MediaLibraryDocument {
  const { collection, payload } = parseCollectionEnvelope(source, 'media_library');
  const { schema_version: _version, ...data } = payload;
  return validateMediaLibraryDocument({ collection, ...data });
}

export function validateMediaLibraryDocument(value: unknown): MediaLibraryDocument {
  if (!isRecord(value) || !hasOnlyKeys(value, ['collection', 'view', 'records'])
    || !isRecord(value.collection) || !isRecord(value.view)
    || !hasOnlyKeys(value.view, ['id', 'layout', 'condition', 'sort'])) {
    throw new Error('不支持的媒体库文件格式');
  }
  const collection = validateCollectionMetadata(value.collection, 'media_library');
  const { view } = value;
  const rawRecords = value.records;
  if (rawRecords !== undefined && (!isRecord(rawRecords) || !hasOnlyKeys(rawRecords, ['data'])
    || !Array.isArray(rawRecords.data)
    || rawRecords.data.some((record) => !isRecord(record)
      || !hasOnlyKeys(record, ['id', 'updated_at', 'note_path'])
      || typeof record.id !== 'string' || !/^rec_[0-9a-f]{32}$/.test(record.id)
      || typeof record.updated_at !== 'string' || !Number.isFinite(Date.parse(record.updated_at))
      || typeof record.note_path !== 'string' || !record.note_path.trim()
      || record.note_path.startsWith('/') || record.note_path.includes('\\')
      || record.note_path.split('/').some((part) => !part || part === '.' || part === '..')))) {
    throw new Error('媒体库记录无效');
  }
  if (rawRecords && isRecord(rawRecords) && Array.isArray(rawRecords.data)) {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const record of rawRecords.data as MediaLibraryRecord[]) {
      const normalizedPath = record.note_path.toLocaleLowerCase();
      if (ids.has(record.id) || paths.has(normalizedPath)) throw new Error('媒体库记录重复');
      ids.add(record.id);
      paths.add(normalizedPath);
    }
  }
  const legacyKinds = view.kinds;
  const condition = view.condition;
  if (legacyKinds !== undefined && (!Array.isArray(legacyKinds) || legacyKinds.some((kind) => kind !== 'image' && kind !== 'video') || new Set(legacyKinds).size !== legacyKinds.length)) {
    throw new Error('媒体库配置无效');
  }
  if (condition !== undefined && (!isRecord(condition) || !hasOnlyKeys(condition, ['file_condition']))) {
    throw new Error('媒体库配置无效');
  }
  const fileCondition = isRecord(condition) ? condition.file_condition : undefined;
  if (fileCondition !== undefined && (!isRecord(fileCondition)
    || !hasOnlyKeys(fileCondition, ['file_name_contains', 'file_type', 'path_contains'])
    || ['file_name_contains', 'file_type', 'path_contains'].some((key) => fileCondition[key] !== undefined && typeof fileCondition[key] !== 'string')
    || (fileCondition.file_type !== undefined && fileCondition.file_type !== '' && fileCondition.file_type !== 'image' && fileCondition.file_type !== 'video'))) {
    throw new Error('媒体库配置无效');
  }
  const legacyType = Array.isArray(legacyKinds) && legacyKinds.length === 1 ? legacyKinds[0] : '';
  const fileType = isRecord(fileCondition) && typeof fileCondition.file_type === 'string'
    ? fileCondition.file_type
    : legacyType;
  const normalizedFileCondition = normalizeMediaLibraryFileCondition({
    file_name_contains: isRecord(fileCondition) && typeof fileCondition.file_name_contains === 'string' ? fileCondition.file_name_contains : undefined,
    file_type: fileType as MediaLibraryKind | undefined,
    path_contains: isRecord(fileCondition) && typeof fileCondition.path_contains === 'string' ? fileCondition.path_contains : undefined,
  });
  if (typeof collection.id !== 'string' || !LIBRARY_ID_PATTERN.test(collection.id)
    || typeof collection.name !== 'string' || !collection.name.trim() || collection.name !== collection.name.trim()
    || !Number.isInteger(collection.revision) || (collection.revision as number) < 0
    || !Number.isSafeInteger(collection.revision)
    || typeof view.id !== 'string' || !VIEW_ID_PATTERN.test(view.id) || view.layout !== 'waterfall'
    || (legacyKinds === undefined && condition === undefined)
    || (view.sort !== undefined && (!isRecord(view.sort)
      || !hasOnlyKeys(view.sort, ['field', 'direction'])
      || view.sort.field !== 'created_at' || view.sort.direction !== 'desc'))) {
    throw new Error('媒体库配置无效');
  }
  return {
    collection,
    view: {
      id: view.id,
      layout: 'waterfall',
      condition: Object.keys(normalizedFileCondition).length > 0 ? { file_condition: normalizedFileCondition } : {},
      ...(view.sort ? { sort: { field: 'created_at', direction: 'desc' } as const } : {}),
    },
    records: { data: rawRecords && isRecord(rawRecords) && Array.isArray(rawRecords.data) ? rawRecords.data as MediaLibraryRecord[] : [] },
  };
}

function hasOnlyKeys(value: object, allowedKeys: string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

export async function createMediaLibraryFile(
  notebookPath: string,
  relativeFolder: string | null | undefined,
  name: string,
): Promise<{ filePath: string; document: MediaLibraryDocument }> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('请输入媒体库名称');
  const stem = sanitizeFileName(trimmedName).replace(/\.lib\.ya?ml$/i, '');
  if (!stem) throw new Error('媒体库名称无效');
  const document = createMediaLibrary(stem);
  const { filePath } = await createUniqueNotebookFile(
    notebookPath,
    relativeFolder,
    stem,
    '.lib.yaml',
    serializeMediaLibrary(document),
  );
  return { filePath, document };
}
