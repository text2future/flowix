import YAML from 'yaml';
import { externalDocuments, notebooks } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath, notebookRelativeDirectoryPath } from '@/lib/path';
import { createFolderCollectionContent } from './folder-collection';
import { publishCollectionContent } from './content-events';
import {
  createCollectionId,
  createUuidV7,
  collectionDisplayName,
  isRecord,
  parseCollectionDocumentV2,
  serializeCollectionDocumentV2,
  validateCollectionProperty,
  type CollectionDocumentV2,
  type CollectionMetadata,
  type CollectionPlacement,
  type CollectionProperty,
  type CollectionType,
} from './model';
import { createTableDocument, createTableView, parseTableDocument, serializeTableDocument, type MultidimensionalTableDocument } from '@features/multidimensional-table/model';
import { createMediaLibrary, parseMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { createWorkDocumentsCollection, parseWorkDocumentsCollection, serializeWorkDocumentsCollection } from '@features/work-documents/model';

export interface CollectionRecoveryResult {
  collectionId: string;
  collectionType: CollectionType;
  placement: CollectionPlacement;
  name: string;
}

function parseLooseDocument(source: string): Record<string, unknown> | null {
  try {
    const value: unknown = YAML.parse(source);
    return isRecord(value) ? value : null;
  } catch {
    // parseDocument can retain a useful partial YAML tree when a later block
    // is malformed. Keep that partial tree for record-level salvage.
    try {
      const value: unknown = YAML.parseDocument(source, { prettyErrors: false }).toJS();
      return isRecord(value) ? value : null;
    } catch { return null; }
  }
}

function collectionTypeFromWire(value: unknown): CollectionType | null {
  if (value === 'notes' || value === 'table') return 'table';
  if (value === 'media' || value === 'media_library') return 'media_library';
  if (value === 'work_documents') return 'work_documents';
  return null;
}

function detectCollectionType(source: string, loose: Record<string, unknown> | null, filePath?: string): CollectionType {
  const collection = loose && isRecord(loose.collection) ? loose.collection : null;
  const parsed = collectionTypeFromWire(collection?.type);
  if (parsed) return parsed;
  // A syntax error elsewhere in the YAML should not hide a readable type.
  const collectionBlock = source.match(/^collection:\s*\r?\n((?:^[ \t]+.*(?:\r?\n|$))*)/m)?.[1] ?? '';
  const wireType = collectionBlock.match(/^[ \t]{2,}type:\s*(notes|media|table|media_library|work_documents)\s*$/m)?.[1];
  return collectionTypeFromWire(wireType) ?? (/\.workdocs\.ya?ml$/i.test(filePath ?? '') ? 'work_documents' : 'table');
}

/** Identify the renderer without requiring the damaged document to validate. */
export function inspectCollectionRecoveryType(source: string, filePath?: string): CollectionType {
  return detectCollectionType(source, parseLooseDocument(source), filePath);
}

function detectPlacement(filePath: string): CollectionPlacement {
  // Placement is tied to the collection's location. A standalone collection
  // cannot become a folder collection merely because its metadata is corrupt.
  return canonicalPath(filePath).endsWith('/.index.yaml') ? 'folder' : 'standalone';
}

function validNotebookRelativePath(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && !value.startsWith('/') && !value.includes('\\')
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^rec_[0-9a-f]{32}$/.test(value);
}

function sourceRecords(
  loose: Record<string, unknown> | null,
): { include: unknown[]; exclude: unknown[] } {
  const payload = loose && isRecord(loose.payload) ? loose.payload : null;
  const dataset = payload && isRecord(payload.dataset) ? payload.dataset : null;
  const records = dataset && isRecord(dataset.records) ? dataset.records : null;
  if (records) return {
    include: Array.isArray(records.include) ? records.include : [],
    exclude: Array.isArray(records.exclude) ? records.exclude : [],
  };
  // Read the common v1 shape as well as v2. Legacy data rows become explicit
  // includes; malformed fields are stripped by the type-specific sanitizer.
  const legacyRecords = payload && isRecord(payload.records) ? payload.records : null;
  return { include: Array.isArray(legacyRecords?.data) ? legacyRecords.data : [], exclude: [] };
}

function sanitizeRecords(
  loose: Record<string, unknown> | null,
  type: CollectionType,
  notebookId?: string,
): { include: Record<string, unknown>[]; exclude: Record<string, unknown>[] } {
  const records = sourceRecords(loose);
  const sanitize = (values: unknown[]) => {
    const seen = new Set<string>();
    const seenIds = new Set<string>();
    const output: Record<string, unknown>[] = [];
    for (const raw of values) {
      if (!isRecord(raw)) continue;
      if (type === 'work_documents') continue;
      const path = type === 'table' ? raw.note_path : (raw.relative_path ?? raw.note_path);
      if (!validNotebookRelativePath(path) || seen.has(path)) continue;
      if (type === 'media_library' && !notebookId
        && (typeof raw.resource_id !== 'string' || !raw.resource_id.trim())) continue;
      seen.add(path);
      const recordId = validRecordId(raw.id) && !seenIds.has(raw.id) ? raw.id : `rec_${createUuidV7()}`;
      seenIds.add(recordId);
      output.push({
        id: recordId,
        updated_at: validTimestamp(raw.updated_at) ? raw.updated_at : new Date().toISOString(),
        ...(type === 'table' ? { note_path: path } : { resource_id: notebookId ? `${notebookId}::${path}` : (raw.resource_id as string).trim(), relative_path: path }),
      });
    }
    return output;
  };
  return { include: sanitize(records.include), exclude: sanitize(records.exclude) };
}

function recoveredMetadata(
  loose: Record<string, unknown> | null,
  type: CollectionType,
  placement: CollectionPlacement,
  fallbackName: string,
): CollectionMetadata {
  const raw = loose && isRecord(loose.collection) ? loose.collection : {};
  const now = new Date().toISOString();
  const properties: Record<string, CollectionProperty> = {};
  if (isRecord(raw.properties)) {
    for (const [key, value] of Object.entries(raw.properties)) {
      if (validateCollectionProperty(value)) properties[key] = value;
    }
  }
  const rawName = typeof raw.name === 'string' ? raw.name.trim() : '';
  return {
    id: typeof raw.id === 'string' && /^col_[0-9a-f]{32}$/.test(raw.id) ? raw.id : createCollectionId(),
    type,
    placement,
    name: rawName || fallbackName,
    revision: Number.isSafeInteger(raw.revision) && Number(raw.revision) >= 0 ? Number(raw.revision) + 1 : 1,
    created_at: validTimestamp(raw.created_at) ? raw.created_at : now,
    updated_at: now,
    properties,
  };
}

function fallbackCollectionName(filePath: string, type: CollectionType): string {
  const filename = filePath.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const withoutExtension = filename.replace(/(?:\.index\.ya?ml|\.(?:table|lib|workdocs)\.ya?ml)$/i, '').trim();
  return withoutExtension || (type === 'table' ? '多维表格' : type === 'work_documents' ? '列表' : '媒体库');
}

function createTemplate(
  filePath: string,
  notebookPath: string,
  type: CollectionType,
  placement: CollectionPlacement,
  name: string,
): CollectionDocumentV2 {
  if (placement === 'folder') {
    const directory = canonicalPath(filePath).replace(/[\\/][^\\/]*$/, '');
    const relativeDirectory = notebookRelativeDirectoryPath(notebookPath, directory) ?? '';
    return parseCollectionDocumentV2(createFolderCollectionContent(type === 'table' ? 'notes' : 'media', name, relativeDirectory));
  }
  if (type === 'table') return parseCollectionDocumentV2(serializeTableDocument(createTableDocument('table', name, 'standalone')));
  if (type === 'work_documents') return parseCollectionDocumentV2(serializeWorkDocumentsCollection(createWorkDocumentsCollection(name)));
  const media = createMediaLibrary(name);
  media.collection.placement = 'standalone';
  // A damaged standalone media library with no readable filter should reopen
  // with the notebook's discoverable media instead of an empty gallery.
  media.dataset.filter = { all: [{ field: 'kind', op: 'in', value: ['image', 'video'] }], any: [] };
  return parseCollectionDocumentV2(serializeMediaLibrary(media));
}

function tryCollection(candidate: CollectionDocumentV2): CollectionDocumentV2 | null {
  try {
    const source = serializeCollectionDocumentV2(candidate);
    const parsed = parseCollectionDocumentV2(source);
    if (parsed.collection.type === 'table') parseTableDocument(source);
    else if (parsed.collection.type === 'media_library') parseMediaLibrary(source);
    else parseWorkDocumentsCollection(source);
    return parsed;
  }
  catch { return null; }
}

function buildRecoveredDocument(
  filePath: string,
  notebookPath: string,
  loose: Record<string, unknown> | null,
  type: CollectionType,
  placement: CollectionPlacement,
  notebookId?: string,
): CollectionDocumentV2 {
  const name = fallbackCollectionName(filePath, type);
  const template = createTemplate(filePath, notebookPath, type, placement, name);
  const collection = recoveredMetadata(loose, type, placement, name);
  const dataset = template.payload.dataset;
  const incoming = loose && isRecord(loose.payload) && isRecord(loose.payload.dataset) ? loose.payload.dataset : null;
  let candidate: CollectionDocumentV2 = {
    ...template,
    collection,
    payload: { ...template.payload, dataset: { ...dataset, records: sanitizeRecords(loose, type, notebookId) } },
  };

  // Keep each optional dataset section only when it passes the full collection
  // validator in combination with the repaired metadata and records.
  if (incoming && isRecord(incoming.source) && placement === 'standalone') {
    const next = { ...candidate, payload: { ...candidate.payload, dataset: { ...candidate.payload.dataset, source: incoming.source } } };
    candidate = tryCollection(next) ?? candidate;
  }
  if (incoming && (incoming.filter === null || isRecord(incoming.filter))) {
    const next = { ...candidate, payload: { ...candidate.payload, dataset: { ...candidate.payload.dataset, filter: incoming.filter as Record<string, unknown> | null } } };
    candidate = tryCollection(next) ?? candidate;
  }
  if (incoming && isRecord(incoming.schema)) {
    const datasetWithSchema = { ...candidate.payload.dataset, schema: incoming.schema };
    let next: CollectionDocumentV2 = { ...candidate, payload: { ...candidate.payload, dataset: datasetWithSchema } };
    if (type === 'table') {
      try {
        const tableDocument = {
          collection,
          dataset: datasetWithSchema,
          views: { default_id: '', items: [] },
        } as unknown as MultidimensionalTableDocument;
        const defaultView = createTableView(tableDocument, 'table');
        next = { ...next, payload: { ...next.payload, views: { default_id: defaultView.id, items: [defaultView] } } };
      } catch { /* Invalid custom fields fall back to the known template below. */ }
    }
    candidate = tryCollection(next) ?? candidate;
  }

  // Retain custom views only as a valid set. A broken or stale view set falls
  // back to the generated table/media view, which is always known to validate.
  const incomingViews = loose && isRecord(loose.payload) && isRecord(loose.payload.views) ? loose.payload.views : null;
  if (incomingViews && Array.isArray(incomingViews.items)) {
    const requestedDefault = typeof incomingViews.default_id === 'string' ? incomingViews.default_id : '';
    const validViews = incomingViews.items.filter(isRecord);
    const defaultExists = validViews.some((view) => view.id === requestedDefault);
    const nextViews = {
      default_id: defaultExists ? requestedDefault : (typeof validViews[0]?.id === 'string' ? validViews[0].id : candidate.payload.views.default_id),
      items: validViews,
    };
    const next = { ...candidate, payload: { ...candidate.payload, views: nextViews } };
    candidate = tryCollection(next) ?? candidate;
  }
  return tryCollection(candidate) ?? template;
}

/** Repair a malformed collection in place while retaining every valid record/config section. */
export async function repairCollectionFile(
  filePath: string,
  notebookPath: string,
): Promise<CollectionRecoveryResult> {
  const root = canonicalPath(notebookPath);
  const path = canonicalPath(filePath);
  const source = await externalDocuments.read(path, root);
  const loose = parseLooseDocument(source);
  const collectionType = detectCollectionType(source, loose, path);
  const placement = detectPlacement(path);
  const name = fallbackCollectionName(path, collectionType);
  const notebookId = collectionType === 'media_library'
    ? (await notebooks.getAll()).find((notebook) => canonicalDirectoryPath(notebook.path) === root)?.id
    : undefined;
  if (collectionType === 'media_library' && !notebookId) throw new Error('媒体库所属笔记本未注册');
  const document = buildRecoveredDocument(path, root, loose, collectionType, placement, notebookId);
  const content = serializeCollectionDocumentV2(document);
  // Validate the exact bytes before touching disk; serialization must produce
  // a complete document accepted by the normal reader.
  const verified = parseCollectionDocumentV2(content);
  const result = await externalDocuments.write({ filePath: path, scopePath: root, expectedContent: source, content });
  if (result.status === 'conflict') throw new Error('集合文件已变化，请重新点击“重置当前视图”');
  if (result.status === 'missing') throw new Error('集合文件已不存在');
  if (result.status === 'error') throw new Error(result.message);
  // 重建后的内容同样要广播：其它已挂载的面板还挂着修复前的文档。
  publishCollectionContent({ indexPath: path, notebookPath: root, content: result.content });
  return {
    collectionId: verified.collection.id,
    collectionType: verified.collection.type as CollectionType,
    placement: verified.collection.placement,
    name: collectionDisplayName(path, placement) || name,
  };
}
