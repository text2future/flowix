import type { I18nKey } from '@/lib/i18n';

export type PropertyDisplayKind = 'text' | 'number' | 'date' | 'url' | 'boolean' | 'array' | 'color' | 'icon';
export type PropertyIconKind = PropertyDisplayKind | 'note' | 'select' | 'image';

/** Shared semantic property types and the contexts that support each one. */
export const PROPERTY_TYPE_CATALOG = [
  { kind: 'Text', labelKey: 'document.properties.type.text', displayKind: 'text', iconKind: 'text', custom: true, preset: true, table: true, tableAddable: true },
  { kind: 'Boolean', labelKey: 'document.properties.type.boolean', displayKind: 'boolean', iconKind: 'boolean', custom: true, preset: true, table: true, tableAddable: true },
  { kind: 'Number', labelKey: 'document.properties.type.number', displayKind: 'number', iconKind: 'number', custom: true, preset: true, table: true, tableAddable: true },
  { kind: 'Date', labelKey: 'document.properties.type.date', displayKind: 'date', iconKind: 'date', custom: true, preset: true, table: true, tableAddable: true },
  { kind: 'URL', labelKey: 'document.properties.type.url', displayKind: 'url', iconKind: 'url', custom: false, preset: false, table: true, tableAddable: true },
  { kind: 'Select', labelKey: 'document.properties.type.select', displayKind: 'text', iconKind: 'select', custom: false, preset: true, table: true, tableAddable: true },
  { kind: 'MultiSelect', labelKey: 'document.properties.type.multiSelect', displayKind: 'array', iconKind: 'select', custom: false, preset: true, table: true, tableAddable: true },
  { kind: 'Tag', labelKey: 'document.properties.type.tag', displayKind: 'array', iconKind: 'array', custom: true, preset: true, table: true, tableAddable: true },
  { kind: 'Tags', labelKey: 'document.properties.type.tags', displayKind: 'array', iconKind: 'array', custom: false, preset: true, table: true, tableAddable: true },
  { kind: 'Color', labelKey: 'document.properties.type.color', displayKind: 'color', iconKind: 'color', custom: false, preset: true, table: true, tableAddable: true },
  { kind: 'Icon', labelKey: 'document.properties.type.icon', displayKind: 'icon', iconKind: 'icon', custom: false, preset: true, table: true, tableAddable: true },
  { kind: 'Note', labelKey: 'document.properties.type.note', displayKind: 'url', iconKind: 'note', custom: false, preset: false, table: true, tableAddable: false },
  { kind: 'Image', labelKey: 'document.properties.type.image', displayKind: 'array', iconKind: 'image', custom: false, preset: false, table: true, tableAddable: true },
] as const satisfies readonly {
  kind: string;
  labelKey: I18nKey;
  displayKind: PropertyDisplayKind;
  iconKind: PropertyIconKind;
  custom: boolean;
  preset: boolean;
  table: boolean;
  tableAddable: boolean;
}[];

type PropertyTypeDefinition = (typeof PROPERTY_TYPE_CATALOG)[number];
export type PropertyKind = PropertyTypeDefinition['kind'];
export type PresetPropertyKind = Extract<PropertyTypeDefinition, { preset: true }>['kind'];
export type CustomPropertyKind = Extract<PropertyTypeDefinition, { custom: true }>['kind'];
export type TablePropertyKind = Extract<PropertyTypeDefinition, { table: true }>['kind'];

export const PROPERTY_KINDS: readonly PresetPropertyKind[] = PROPERTY_TYPE_CATALOG
  .filter((definition) => definition.preset)
  .map((definition) => definition.kind as PresetPropertyKind);

export const CUSTOM_PROPERTY_KINDS: readonly CustomPropertyKind[] = PROPERTY_TYPE_CATALOG
  .filter((definition) => definition.custom)
  .map((definition) => definition.kind as CustomPropertyKind);

export const TABLE_PROPERTY_KINDS: readonly TablePropertyKind[] = PROPERTY_TYPE_CATALOG
  .filter((definition) => definition.table)
  .map((definition) => definition.kind as TablePropertyKind);

export const ADDABLE_TABLE_PROPERTY_KINDS: readonly TablePropertyKind[] = PROPERTY_TYPE_CATALOG
  .filter((definition) => definition.tableAddable)
  .map((definition) => definition.kind as TablePropertyKind);

const PROPERTY_TYPE_BY_KIND = new Map<PropertyKind, PropertyTypeDefinition>(
  PROPERTY_TYPE_CATALOG.map((definition) => [definition.kind, definition]),
);

const PROPERTY_KIND_SETS = {
  all: new Set<PropertyKind>(PROPERTY_TYPE_CATALOG.map((definition) => definition.kind)),
  preset: new Set<PropertyKind>(PROPERTY_TYPE_CATALOG.filter((definition) => definition.preset).map((definition) => definition.kind)),
  table: new Set<PropertyKind>(PROPERTY_TYPE_CATALOG.filter((definition) => definition.table).map((definition) => definition.kind)),
} as const;

export function getPropertyTypeDefinition(kind: PropertyKind): PropertyTypeDefinition {
  return PROPERTY_TYPE_BY_KIND.get(kind)!;
}

export function isPropertyKind(value: unknown): value is PropertyKind {
  return typeof value === 'string' && PROPERTY_KIND_SETS.all.has(value as PropertyKind);
}

export function isPresetPropertyKind(value: unknown): value is PresetPropertyKind {
  return typeof value === 'string' && PROPERTY_KIND_SETS.preset.has(value as PropertyKind);
}

export function isTablePropertyKind(value: unknown): value is TablePropertyKind {
  return typeof value === 'string' && PROPERTY_KIND_SETS.table.has(value as PropertyKind);
}
