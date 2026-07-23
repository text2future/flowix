import YAML, { isMap, isScalar, type YAMLMap } from 'yaml';
import type { PropertyKind } from '@features/document/properties/presets';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';

export const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
export const SYSTEM_FRONTMATTER_KEYS = new Set(['key']);

export type FrontmatterPropertyErrorCode =
  | 'empty-key'
  | 'reserved-key'
  | 'duplicate-key'
  | 'invalid-tag'
  | 'invalid-number'
  | 'invalid-yaml'
  | 'non-mapping'
  | 'non-scalar-key';

export class FrontmatterPropertyError extends Error {
  constructor(
    readonly code: FrontmatterPropertyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FrontmatterPropertyError';
  }
}

export interface VisibleFrontmatterProperty {
  key: string;
  value: unknown;
}

export interface ParsedVisibleFrontmatter {
  properties: VisibleFrontmatterProperty[];
  firstProperty: VisibleFrontmatterProperty | null;
  data: Record<string, unknown>;
  userData: Record<string, unknown>;
  parseError: string | null;
}

export interface ExtractedFrontmatter extends ParsedVisibleFrontmatter {
  yamlContent: string;
  body: string;
  hasFrontmatter: boolean;
}

export interface FrontmatterPropertyValue {
  key: string;
  value: unknown;
}

function nodeKeyToString(key: unknown): string {
  if (isScalar(key)) return String(key.value ?? '');
  return String(key ?? '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function withoutSystemProperties(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !SYSTEM_FRONTMATTER_KEYS.has(key)),
  );
}

function parseDocument(yamlContent: string) {
  const document = YAML.parseDocument(yamlContent.trim() || '{}');
  if (document.errors.length > 0) {
    throw new FrontmatterPropertyError(
      'invalid-yaml',
      document.errors[0]?.message ?? 'Invalid YAML',
    );
  }
  if (!isMap(document.contents)) {
    throw new FrontmatterPropertyError(
      'non-mapping',
      'YAML frontmatter must be a mapping',
    );
  }
  return document;
}

export function parseVisibleFrontmatter(yamlContent: string): ParsedVisibleFrontmatter {
  try {
    const document = parseDocument(yamlContent);
    const map = document.contents as unknown as YAMLMap;
    const data = asRecord(document.toJS());
    const userData = withoutSystemProperties(data);
    const properties = map.items.flatMap((pair) => {
      const key = nodeKeyToString(pair.key);
      return key && !SYSTEM_FRONTMATTER_KEYS.has(key)
        ? [{ key, value: userData[key] }]
        : [];
    });

    return {
      properties,
      firstProperty: properties[0] ?? null,
      data,
      userData,
      parseError: null,
    };
  } catch (error) {
    return {
      properties: [],
      firstProperty: null,
      data: {},
      userData: {},
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function extractFrontmatter(content: string): ExtractedFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  const yamlContent = match?.[1]?.trim() ?? '';
  const body = match ? content.slice(match[0].length) : content;
  const parsed = match
    ? parseVisibleFrontmatter(yamlContent)
    : { properties: [], firstProperty: null, data: {}, userData: {}, parseError: null };

  return {
    ...parsed,
    yamlContent,
    body,
    hasFrontmatter: Boolean(match),
  };
}

export function formatFrontmatterPropertyValue(value: unknown, truncateAt = 72): string {
  let text: string;
  if (value === null) {
    text = 'null';
  } else if (typeof value === 'string') {
    text = value;
  } else {
    text = YAML.stringify(value, {
      collectionStyle: 'flow',
      lineWidth: 0,
    }).trim();
  }

  const singleLine = text.replace(/\s*\n\s*/g, ' ');
  return singleLine.length > truncateAt
    ? `${singleLine.slice(0, truncateAt - 1)}…`
    : singleLine;
}

export function toFrontmatterPropertyInput(value: unknown): string {
  return formatFrontmatterPropertyValue(value, Number.POSITIVE_INFINITY);
}

function parseMultiSelect(value: string): string[] {
  if (!value.trim()) return [];
  try {
    const parsed = YAML.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // A comma-separated list is the inline editor's friendly fallback.
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeDocumentTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new FrontmatterPropertyError('invalid-tag', 'Tags must be a list');
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new FrontmatterPropertyError('invalid-tag', 'Every tag must be text');
    }
    const tag = item.trim();
    const segments = tag.split('/');
    if (
      !tag
      || segments.some((segment) => !segment || /[\s\p{P}]/u.test(segment))
    ) {
      throw new FrontmatterPropertyError(
        'invalid-tag',
        'Tags cannot contain whitespace or punctuation; use / only for hierarchy',
      );
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
    }
  }
  return normalized;
}

function parsePropertyInput(
  value: string,
  kind: PropertyKind | undefined,
  previousValue: unknown,
): unknown {
  switch (kind) {
    case 'Number': {
      if (!value.trim()) return '';
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new FrontmatterPropertyError('invalid-number', 'Property value must be a number');
      }
      return number;
    }
    case 'MultiSelect':
      return parseMultiSelect(value);
    case 'Text':
    case 'Date':
    case 'URL':
    case 'Icon':
    case 'Select':
      return value;
    default:
      break;
  }

  if (typeof previousValue === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (typeof previousValue === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  if (Array.isArray(previousValue)) return parseMultiSelect(value);
  if (previousValue && typeof previousValue === 'object') {
    try {
      return YAML.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function updateVisibleFrontmatterProperty(
  yamlContent: string,
  previousKey: string | null,
  nextKeyInput: string,
  nextValueInput: string,
  kind?: PropertyKind,
): string {
  const nextKey = canonicalizePropertyKey(nextKeyInput);
  if (!nextKey) {
    throw new FrontmatterPropertyError('empty-key', 'Property key is required');
  }
  if (SYSTEM_FRONTMATTER_KEYS.has(nextKey)) {
    throw new FrontmatterPropertyError(
      'reserved-key',
      'The key property is managed by Flowix',
    );
  }

  const document = parseDocument(yamlContent);
  const map = document.contents as unknown as YAMLMap;
  const targetPair = previousKey
    ? map.items.find((pair) => nodeKeyToString(pair.key) === previousKey)
    : undefined;
  const duplicatePair = map.items.find((pair) => nodeKeyToString(pair.key) === nextKey);
  if (duplicatePair && duplicatePair !== targetPair) {
    throw new FrontmatterPropertyError('duplicate-key', 'Property key already exists');
  }
  const targetKey = targetPair?.key;
  if (targetPair && !isScalar(targetKey)) {
    throw new FrontmatterPropertyError('non-scalar-key', 'Property key must be a scalar');
  }

  const previousValue = previousKey
    ? asRecord(document.toJS())[previousKey]
    : undefined;
  const parsedValue = parsePropertyInput(nextValueInput, kind, previousValue);
  const nextValue = nextKey === 'tags'
    ? normalizeDocumentTags(parsedValue)
    : parsedValue;
  if (targetPair && isScalar(targetKey)) {
    targetKey.value = nextKey;
    targetPair.value = document.createNode(nextValue);
  } else {
    map.add(document.createPair(nextKey, nextValue));
  }

  return document.toString({ lineWidth: 0 }).trimEnd();
}

export function mergeFrontmatterYaml(currentYaml: string, pastedYaml: string): string {
  const currentDocument = parseDocument(currentYaml);
  const pasted = parseVisibleFrontmatter(pastedYaml);
  if (pasted.parseError) {
    throw new FrontmatterPropertyError('invalid-yaml', pasted.parseError);
  }

  const map = currentDocument.contents as unknown as YAMLMap;
  Object.entries(pasted.userData).forEach(([key, value]) => {
    map.set(key, value);
  });
  return currentDocument.toString({ lineWidth: 0 }).trimEnd();
}

export function replaceVisibleFrontmatterProperties(
  content: string,
  properties: FrontmatterPropertyValue[],
): string {
  const extracted = extractFrontmatter(content);
  const document = parseDocument(extracted.yamlContent);
  const map = document.contents as unknown as YAMLMap;
  const desiredKeys = new Set(properties.map(({ key }) => canonicalizePropertyKey(key)));

  for (let index = map.items.length - 1; index >= 0; index -= 1) {
    const key = nodeKeyToString(map.items[index].key);
    if (!SYSTEM_FRONTMATTER_KEYS.has(key) && !desiredKeys.has(key)) {
      map.items.splice(index, 1);
    }
  }
  properties.forEach(({ key, value }) => {
    const canonicalKey = canonicalizePropertyKey(key);
    map.set(
      canonicalKey,
      canonicalKey === 'tags' ? normalizeDocumentTags(value) : value,
    );
  });

  const yamlContent = document.toString({ lineWidth: 0 }).trimEnd() || '{}';
  return `---\n${yamlContent}\n---\n${extracted.body.replace(/^\r?\n/, '')}`;
}
