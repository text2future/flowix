import { canonicalizePropertyKey } from './property-key';
import type { PropertyFieldConfig } from '@/lib/constants';
import { getPropertyTypeDefinition, type PropertyDisplayKind, type PropertyKind } from '@/lib/property-types';
import { resolvePropertyPreset } from './presets';

export type { PropertyDisplayKind } from '@/lib/property-types';

export interface ResolvedPropertyType {
  kind: PropertyKind;
  displayKind: PropertyDisplayKind;
}

export const FIXED_PROPERTY_KINDS: Readonly<Record<string, PropertyKind>> = {
  name: 'Text',
  description: 'Text',
  tags: 'Tags',
  flowix_colors: 'Color',
  flowix_icon: 'Icon',
  flowix_favorited: 'Boolean',
};

export const PROPERTY_URL_RE = /^https?:\/\/\S+$/i;
export const PROPERTY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function inferValueKind(value: unknown): PropertyKind {
  if (typeof value === 'boolean') return 'Boolean';
  if (Array.isArray(value)) return 'MultiSelect';
  if (typeof value === 'number') return 'Number';
  if (typeof value === 'string' && PROPERTY_DATE_RE.test(value)) return 'Date';
  if (typeof value === 'string' && PROPERTY_URL_RE.test(value)) return 'URL';
  return 'Text';
}

export function resolvePropertyType(
  key: string,
  value: unknown,
  _isFlowSequence = false,
  customPresets: readonly PropertyFieldConfig[] = [],
): ResolvedPropertyType {
  const canonicalKey = canonicalizePropertyKey(key);
  const kind = FIXED_PROPERTY_KINDS[canonicalKey]
    ?? resolvePropertyPreset(canonicalKey, customPresets)?.kind
    ?? inferValueKind(value);

  return {
    kind,
    // Keep the legacy key-based color rendering for documents created before
    // Color became an explicit semantic preset type.
    displayKind: canonicalKey === 'flowix_colors'
      ? 'color'
      : kind === 'Select' && typeof value === 'boolean'
        ? 'boolean'
        : getPropertyTypeDefinition(kind).displayKind,
  };
}
