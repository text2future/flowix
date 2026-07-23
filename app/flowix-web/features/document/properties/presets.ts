/**
 * Note property preset catalog.
 *
 * Single source of truth for the guided property input in
 * `note-properties-dialog.tsx`. The catalog is render-time only — preset
 * metadata (category, icon, mapped label) is never written to the YAML
 * frontmatter. The storage layer (`properties: Value` in Rust, opaque
 * `Record<string, unknown>` in TypeScript) is unchanged.
 *
 * Adding a new preset:
 *  1. Append an entry to `PRESETS`.
 *  2. Add its label / hint / option i18n keys to `locales.ts` (both
 *     `zh-CN` and `en-US`).
 *  3. If the preset's kind needs a new value, extend `PropertyKind`
 *     and the dialog's value-column switch.
 */

import type { Icon } from '@phosphor-icons/react';
import {
  HashIcon,
  LinkIcon,
  SmileyIcon,
  CircleHalfTiltIcon,
  TagIcon,
  UserCircleIcon,
} from '@phosphor-icons/react';
import type { I18nKey } from '@features/i18n';

/** UI-side data types. PascalCase to match the existing `PROPERTY_TYPES` array.
 *  'Tags' 已移除 — 多选统一走 'MultiSelect' (YAML 都是 array, UI 上 chips
 *  也一致), 旧 Tags 行加载时 inferType 直接映射到 MultiSelect。 */
export type PropertyKind =
  | 'Text'
  | 'Number'
  | 'Date'
  | 'URL'
  | 'Icon'
  | 'Select'
  | 'MultiSelect';

/** Field types in display order. Single source for both the dialog's type
 *  column and the Custom popup's type chip group. */
export const PROPERTY_KINDS: readonly PropertyKind[] = [
  'Text',
  'Number',
  'Date',
  'URL',
  'Icon',
  'Select',
  'MultiSelect',
];

/**
 * Categories that drive the picker grouping. Values are camelCase to align
 * 1:1 with `document.properties.category.<value>` i18n keys in `locales.ts`.
 * Note that the YAML key for a preset (`preset.key`) is independently
 * kebab-case — category and key are separate concepts.
 */
export type PropertyCategory =
  | 'kind'
  | 'status'
  | 'icon'
  | 'agentRole'
  | 'refUrl'
  | 'tags'
  | 'keywords'
  | 'custom';

export interface PropertyPreset {
  /** Built-in category slot. `custom` is reserved for the free-input path. */
  category: Exclude<PropertyCategory, 'custom'>;
  /** The literal key written to YAML. */
  key: string;
  /** Mapped display name (i18n key). */
  labelKey: I18nKey;
  /** Default UI kind. User can still override via the type column. */
  kind: PropertyKind;
  /** Option values for `Select` / `MultiSelect`. */
  options?: readonly string[];
  /** Optional description / hint (i18n key). */
  hintKey?: I18nKey;
  /** Phosphor icon rendered in the picker item and the trigger button. */
  icon: Icon;
}

export const PRESETS: readonly PropertyPreset[] = [
  {
    category: 'kind',
    key: 'type',
    labelKey: 'document.properties.category.kind',
    kind: 'Select',
    options: ['note', 'prompt'],
    icon: TagIcon,
  },
  {
    category: 'status',
    key: 'status',
    labelKey: 'document.properties.category.status',
    kind: 'Select',
    options: ['todo', 'in-progress', 'done'],
    icon: CircleHalfTiltIcon,
  },
  {
    category: 'icon',
    key: 'icon',
    labelKey: 'document.properties.category.icon',
    kind: 'Icon',
    icon: SmileyIcon,
  },
  {
    category: 'agentRole',
    key: 'agent-role',
    labelKey: 'document.properties.category.agentRole',
    kind: 'Text',
    icon: UserCircleIcon,
  },
  {
    category: 'refUrl',
    key: 'ref-url',
    labelKey: 'document.properties.category.refUrl',
    kind: 'URL',
    icon: LinkIcon,
  },
  {
    category: 'tags',
    key: 'tags',
    labelKey: 'document.properties.category.tags',
    kind: 'MultiSelect',
    icon: HashIcon,
  },
  {
    category: 'keywords',
    key: 'keywords',
    labelKey: 'document.properties.category.keywords',
    kind: 'MultiSelect',
    icon: HashIcon,
  },
];

/** O(1) lookup table built once at module load. */
const PRESET_BY_KEY: ReadonlyMap<string, PropertyPreset> = new Map(
  PRESETS.map((preset) => [preset.key, preset])
);

export function resolvePreset(key: string): PropertyPreset | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  return PRESET_BY_KEY.get(trimmed) ?? null;
}

/**
 * Keys that must never be reused as note properties. These collide with
 * the top-level fields on `Memo` / `MemoIndexEntry` (`types.rs:64-87`):
 * `key` is the memo id, the rest are decorations sourced from the memo
 * index, not from frontmatter. Reserved even though the YAML keyspace
 * is technically independent, to keep the door closed for future
 * confusion.
 */
export const RESERVED_KEYS: readonly string[] = [
  'key',
  'icon',
  'colors',
  'tags',
  'favorited',
  'todos',
  'agents',
  'preview',
  'thumbnail',
];

const RESERVED_KEY_SET: ReadonlySet<string> = new Set(RESERVED_KEYS);

export function isReservedKey(key: string): boolean {
  return RESERVED_KEY_SET.has(key.trim());
}

/** Returns the picker groups, each prefixed with a category header. */
export function getPresetGroups(): Array<{
  category: PropertyCategory;
  presets: readonly PropertyPreset[];
}> {
  return PRESETS.map((preset) => ({
    category: preset.category,
    presets: [preset],
  }));
}
