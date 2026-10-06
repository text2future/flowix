import YAML, { isMap, isScalar, isSeq, type YAMLMap } from 'yaml';
import type { PropertyKind } from '@features/document/properties/presets';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import { isValidTagPath } from '@/lib/tag-path';
import { NOTE_COLORS } from '@/types/note-item';

export const FRONTMATTER_RE = /^\uFEFF?(?:[ \t]*\r?\n)*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
export const SYSTEM_FRONTMATTER_KEYS = new Set(['flowix_key', 'key']);

const FLOWIX_COLOR_SET = new Set<string>(NOTE_COLORS);

export type FrontmatterPropertyErrorCode =
  | 'empty-key'
  | 'reserved-key'
  | 'duplicate-key'
  | 'invalid-tag'
  | 'invalid-color'
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

export interface FrontmatterRepair {
  /** The valid YAML prefix that remains in the frontmatter block. */
  yamlContent: string;
  /** The malformed suffix that should be displayed as document content. */
  bodyContent: string;
}

export interface ExtractedFrontmatter extends ParsedVisibleFrontmatter {
  yamlContent: string;
  body: string;
  hasFrontmatter: boolean;
}

export interface FrontmatterPropertyValue {
  key: string;
  value: unknown;
  /** Optional semantic type supplied by the guided property editor. */
  kind?: FrontmatterInputKind;
}

type FrontmatterInputKind = PropertyKind;

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

/**
 * Find a conservative repair for malformed frontmatter.
 *
 * The first parser error is treated as a boundary only when everything before
 * that line is still a valid YAML mapping. The suffix is returned separately
 * so callers can move it into the document body without silently discarding
 * any authored text.
 */
export function suggestFrontmatterRepair(yamlContent: string): FrontmatterRepair | null {
  const source = yamlContent.trim();
  if (!source) return null;

  const document = YAML.parseDocument(source);
  const firstError = document.errors[0];
  const errorStart = firstError?.pos?.[0];
  if (typeof errorStart !== 'number' || errorStart < 0 || errorStart > source.length) {
    return null;
  }

  const lineStart = source.lastIndexOf('\n', Math.max(0, errorStart - 1)) + 1;
  const yamlPrefix = source.slice(0, lineStart).trimEnd();
  const bodyContent = source.slice(lineStart);
  if (!yamlPrefix || !bodyContent.trim()) return null;

  const prefixDocument = YAML.parseDocument(yamlPrefix);
  if (prefixDocument.errors.length > 0 || !isMap(prefixDocument.contents)) {
    return null;
  }

  return { yamlContent: yamlPrefix, bodyContent };
}

/** Returns whether a property's YAML value uses flow collection syntax. */
export function isFrontmatterPropertyFlowSequence(
  yamlContent: string,
  propertyKey: string,
): boolean {
  try {
    const document = parseDocument(yamlContent);
    const map = document.contents as unknown as YAMLMap;
    const pair = map.items.find((item) => nodeKeyToString(item.key) === propertyKey);
    return Boolean(pair && isSeq(pair.value) && pair.value.flow === true);
  } catch {
    return false;
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
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

export function normalizeTagInput(value: string): string {
  return value.trim().replace(/^#+/, '').trim();
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
    const tag = normalizeTagInput(item);
    if (!isValidTagPath(tag)) {
      throw new FrontmatterPropertyError(
        'invalid-tag',
        'Tags cannot contain whitespace or punctuation other than - and _; use / only for hierarchy',
      );
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
    }
  }
  return normalized;
}

function normalizeFlowixColors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new FrontmatterPropertyError('invalid-color', 'Flowix colors must be a list');
  }
  const selected = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !FLOWIX_COLOR_SET.has(item.trim())) {
      throw new FrontmatterPropertyError(
        'invalid-color',
        'Flowix colors must use the product color palette',
      );
    }
    selected.add(item.trim());
  }
  return NOTE_COLORS.filter((color) => selected.has(color));
}

function parsePropertyInput(
  value: string,
  kind: FrontmatterInputKind | undefined,
  previousValue: unknown,
): unknown {
  switch (kind) {
    case 'Number': {
      if (!value.trim()) return '';
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new FrontmatterPropertyError('invalid-number', 'Property value must be a number');
      }
      if (!Number.isInteger(number)) {
        throw new FrontmatterPropertyError('invalid-number', 'Property value must be an integer');
      }
      return number;
    }
    case 'Boolean':
      return value.trim() === 'true';
    case 'MultiSelect':
    case 'Tag':
    case 'Tags':
    case 'Color':
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

function parsePluginMetadataJson(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new FrontmatterPropertyError('invalid-yaml', 'Plugin metadata must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || typeof (parsed as Record<string, unknown>).id !== 'string') {
    throw new FrontmatterPropertyError('invalid-yaml', 'Plugin metadata must include an id');
  }
  return parsed as Record<string, unknown>;
}

export function updateVisibleFrontmatterProperty(
  yamlContent: string,
  previousKey: string | null,
  nextKeyInput: string,
  nextValueInput: string,
  kind?: FrontmatterInputKind,
): string {
  const nextKey = canonicalizePropertyKey(nextKeyInput);
  if (!nextKey) {
    throw new FrontmatterPropertyError('empty-key', 'Property key is required');
  }
  if (SYSTEM_FRONTMATTER_KEYS.has(nextKey)) {
    throw new FrontmatterPropertyError(
      'reserved-key',
      'The system key property is managed by Flowix',
    );
  }

  const document = parseDocument(yamlContent);
  const map = document.contents as unknown as YAMLMap;
  // An empty source is parsed from '{}' above, which creates a flow-style map.
  // Newly added properties should use regular block-style frontmatter.
  if (!yamlContent.trim()) map.flow = false;
  const targetPair = previousKey
    ? map.items.find((pair) => nodeKeyToString(pair.key) === previousKey)
    : undefined;
  const duplicatePair = map.items.find((pair) => (
    canonicalizePropertyKey(nodeKeyToString(pair.key)) === nextKey
    && pair !== targetPair
  ));
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
  const parsedValue = nextKey === 'flowix_plugin'
    ? parsePluginMetadataJson(nextValueInput)
    : parsePropertyInput(nextValueInput, kind, previousValue);
  const collectionKey = kind === 'Tag' || kind === 'Tags' || kind === 'Color'
    || nextKey === 'tags' || nextKey === 'flowix_colors';
  // A key-only edit starts with the old scalar value. Switch collection
  // properties to an empty collection until the user chooses their items,
  // instead of rejecting the key change because the old value has the wrong
  // shape.
  const collectionValue = collectionKey && kind === undefined && !Array.isArray(parsedValue)
    ? []
    : parsedValue;
  const nextValue = kind === 'Tags' || nextKey === 'tags'
    ? normalizeDocumentTags(collectionValue)
    : kind === 'Color' || nextKey === 'flowix_colors'
      ? normalizeFlowixColors(collectionValue)
      : collectionValue;
  const valueNode = nextKey === 'flowix_plugin'
    ? YAML.parseDocument(JSON.stringify(nextValue)).contents
    : document.createNode(nextValue);
  if (
    Array.isArray(nextValue)
    && (kind === 'MultiSelect' || kind === 'Tag' || kind === 'Tags' || kind === 'Color' || nextKey === 'tags' || nextKey === 'flowix_colors')
    && isSeq(valueNode)
  ) {
    valueNode.flow = true;
  }
  if (targetPair && isScalar(targetKey)) {
    targetKey.value = nextKey;
    targetPair.value = valueNode;
  } else {
    map.add(document.createPair(nextKey, valueNode));
  }

  return document.toString({ lineWidth: 0 }).trimEnd();
}

export function moveVisibleFrontmatterProperty(
  yamlContent: string,
  propertyKey: string,
  direction: 'up' | 'down',
): string {
  const document = parseDocument(yamlContent);
  const map = document.contents as unknown as YAMLMap;
  const visiblePairs = map.items.filter((pair) => {
    const key = nodeKeyToString(pair.key);
    return key && !SYSTEM_FRONTMATTER_KEYS.has(key);
  });
  const currentIndex = visiblePairs.findIndex(
    (pair) => nodeKeyToString(pair.key) === propertyKey,
  );
  if (currentIndex < 0) return document.toString({ lineWidth: 0 }).trimEnd();

  const offset = direction === 'up' ? -1 : 1;
  const nextIndex = currentIndex + offset;
  if (nextIndex < 0 || nextIndex >= visiblePairs.length) {
    return document.toString({ lineWidth: 0 }).trimEnd();
  }

  const currentPair = visiblePairs[currentIndex];
  const nextPair = visiblePairs[nextIndex];
  const currentMapIndex = map.items.indexOf(currentPair);
  const nextMapIndex = map.items.indexOf(nextPair);
  [map.items[currentMapIndex], map.items[nextMapIndex]] = [
    map.items[nextMapIndex],
    map.items[currentMapIndex],
  ];

  return document.toString({ lineWidth: 0 }).trimEnd();
}

export function reorderVisibleFrontmatterProperty(
  yamlContent: string,
  propertyKey: string,
  targetPropertyKey: string,
  placement: 'before' | 'after',
): string {
  const document = parseDocument(yamlContent);
  const map = document.contents as unknown as YAMLMap;
  const visiblePairs = map.items.filter((pair) => {
    const key = nodeKeyToString(pair.key);
    return key && !SYSTEM_FRONTMATTER_KEYS.has(key);
  });
  const sourceIndex = visiblePairs.findIndex(
    (pair) => nodeKeyToString(pair.key) === propertyKey,
  );
  const targetIndex = visiblePairs.findIndex(
    (pair) => nodeKeyToString(pair.key) === targetPropertyKey,
  );
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return document.toString({ lineWidth: 0 }).trimEnd();
  }

  const insertionIndex = placement === 'before' ? targetIndex : targetIndex + 1;
  const [sourcePair] = visiblePairs.splice(sourceIndex, 1);
  if (!sourcePair) return document.toString({ lineWidth: 0 }).trimEnd();
  const adjustedIndex = sourceIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
  visiblePairs.splice(adjustedIndex, 0, sourcePair);

  const visibleMapIndexes = map.items
    .map((pair, index) => visiblePairs.includes(pair) ? index : -1)
    .filter((index) => index >= 0);
  visibleMapIndexes.forEach((mapIndex, index) => {
    map.items[mapIndex] = visiblePairs[index];
  });

  return document.toString({ lineWidth: 0 }).trimEnd();
}

export function deleteVisibleFrontmatterProperty(
  yamlContent: string,
  propertyKey: string,
): string {
  const document = parseDocument(yamlContent);
  const map = document.contents as unknown as YAMLMap;
  const propertyIndex = map.items.findIndex((pair) => (
    nodeKeyToString(pair.key) === propertyKey
    && !SYSTEM_FRONTMATTER_KEYS.has(propertyKey)
  ));
  if (propertyIndex >= 0) map.items.splice(propertyIndex, 1);
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
  properties.forEach(({ key, value, kind }) => {
    const canonicalKey = canonicalizePropertyKey(key);
    if (SYSTEM_FRONTMATTER_KEYS.has(canonicalKey)) return;
    if (canonicalKey === 'flowix_plugin') {
      const plugin = typeof value === 'string' ? parsePluginMetadataJson(value) : value;
      map.set(canonicalKey, YAML.parseDocument(JSON.stringify(plugin)).contents);
      return;
    }
    map.set(
      canonicalKey,
      kind === 'Tags' || canonicalKey === 'tags'
        ? normalizeDocumentTags(value)
        : kind === 'Color' || canonicalKey === 'flowix_colors'
          ? normalizeFlowixColors(value)
          : value,
    );
  });

  const yamlContent = document.toString({ lineWidth: 0 }).trimEnd() || '{}';
  return `---\n${yamlContent}\n---\n${extracted.body.replace(/^\r?\n/, '')}`;
}
