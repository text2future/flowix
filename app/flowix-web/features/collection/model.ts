import YAML from 'yaml';

export type CollectionType = 'table' | 'media_library';
export type CollectionPropertyType = 'Text' | 'Number' | 'Boolean' | 'Date' | 'URL' | 'Icon' | 'Color' | 'Tag';
export interface CollectionProperty {
  type: CollectionPropertyType;
  name?: string;
  value: string | number | boolean | string[];
}
export interface CollectionMetadata {
  id: string;
  type: CollectionType;
  name: string;
  revision: number;
  created_at: string;
  updated_at: string;
  properties: Record<string, CollectionProperty>;
}
export interface CollectionEnvelope {
  format: 'flowix.collection';
  schema_version: 1;
  collection: CollectionMetadata;
  payload: { schema_version: 1; [key: string]: unknown };
}

export function createUuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export const createCollectionId = () => `col_${createUuidV7()}`;
export function createCollectionMetadata(type: CollectionType, name: string): CollectionMetadata {
  const now = new Date().toISOString();
  return { id: createCollectionId(), type, name: name.trim(), revision: 0, created_at: now, updated_at: now, properties: {} };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
export function validateCollectionProperty(property: unknown): property is CollectionProperty {
  if (!isRecord(property) || !hasOnlyKeys(property, ['type', 'name', 'value'])
    || (property.name !== undefined && (typeof property.name !== 'string' || !property.name.trim()))) return false;
  const value = property.value;
  switch (property.type) {
    case 'Number': return typeof value === 'number' && Number.isFinite(value);
    case 'Boolean': return typeof value === 'boolean';
    case 'Date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    case 'Tag': case 'Color': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'Text': case 'URL': case 'Icon': return typeof value === 'string';
    default: return false;
  }
}
export function validateCollectionMetadata(value: unknown, type?: CollectionType): CollectionMetadata {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'type', 'name', 'revision', 'created_at', 'updated_at', 'properties'])
    || typeof value.id !== 'string' || !/^col_[0-9a-f]{32}$/.test(value.id)
    || !['table', 'media_library'].includes(String(value.type)) || (type && value.type !== type)
    || typeof value.name !== 'string' || !value.name.trim() || value.name !== value.name.trim()
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))
    || !isRecord(value.properties) || Object.entries(value.properties).some(([key, property]) => (
      !/^[a-z][a-z0-9_]*$/.test(key) || !validateCollectionProperty(property)
    ))) throw new Error('集合身份、版本或自有属性无效');
  return value as unknown as CollectionMetadata;
}
export function parseCollectionEnvelope(source: string, type?: CollectionType): CollectionEnvelope {
  const value: unknown = YAML.parse(source);
  if (!isRecord(value) || !hasOnlyKeys(value, ['format', 'schema_version', 'collection', 'payload'])
    || value.format !== 'flowix.collection' || value.schema_version !== 1
    || !isRecord(value.payload) || value.payload.schema_version !== 1) throw new Error('不支持的集合文件格式或版本');
  validateCollectionMetadata(value.collection, type);
  return value as unknown as CollectionEnvelope;
}
export function serializeCollectionEnvelope(collection: CollectionMetadata, payload: Record<string, unknown>): string {
  validateCollectionMetadata(collection);
  return YAML.stringify({ format: 'flowix.collection', schema_version: 1, collection, payload: { ...payload, schema_version: 1 } }, { lineWidth: 0, indent: 2 });
}
export function reviseCollection(collection: CollectionMetadata): CollectionMetadata {
  return { ...collection, revision: collection.revision + 1, updated_at: new Date().toISOString() };
}
