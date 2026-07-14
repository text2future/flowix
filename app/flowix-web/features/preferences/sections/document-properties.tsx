'use client';

import { useMemo, useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { PropertyFieldConfig, PropertyFieldType } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { PROPERTY_KINDS, type PropertyKind } from '@features/document/properties/presets';
import { useI18n } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';

type DraftField = {
  name: string;
  type: PropertyFieldType;
  optionsText: string;
};

function getPropertyTypeLabelKey(kind: PropertyKind) {
  return `document.properties.type.${kind === 'MultiSelect' ? 'multiSelect' : kind.toLowerCase()}` as
    | 'document.properties.type.text'
    | 'document.properties.type.number'
    | 'document.properties.type.date'
    | 'document.properties.type.url'
    | 'document.properties.type.icon'
    | 'document.properties.type.select'
    | 'document.properties.type.multiSelect';
}

function normalizeOptions(type: PropertyFieldType, optionsText: string): string[] | undefined {
  if (type !== 'Select' && type !== 'MultiSelect') return undefined;
  const options = optionsText
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean);
  return [...new Set(options)];
}

function fieldToDraft(field: PropertyFieldConfig): DraftField {
  return {
    name: field.name,
    type: field.type,
    optionsText: field.options?.join(', ') ?? '',
  };
}

export function DocumentPropertiesSection() {
  const { t } = useI18n();
  const fields = useUserSettingsStore((store) => store.settings.properties.fields);
  const updateSettings = useUserSettingsStore((store) => store.updateSettings);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftField | null>(null);

  const fieldsByKey = useMemo(() => {
    return new Map(fields.map((field) => [field.key, field]));
  }, [fields]);

  const startEdit = (field: PropertyFieldConfig) => {
    setEditingKey(field.key);
    setDraft(fieldToDraft(field));
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setDraft(null);
  };

  const saveEdit = async (field: PropertyFieldConfig) => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error(t('preferences.documentProperties.emptyName'));
      return;
    }

    const nextField: PropertyFieldConfig = {
      ...field,
      name,
      type: draft.type,
      options: normalizeOptions(draft.type, draft.optionsText),
    };
    const nextFields = fields.map((item) => (item.key === field.key ? nextField : item));
    await updateSettings({ properties: { fields: nextFields } });
    cancelEdit();
    toast.success(t('preferences.documentProperties.updateSuccess'));
  };

  const deleteField = async (field: PropertyFieldConfig) => {
    const confirmed = window.confirm(
      t('preferences.documentProperties.deleteConfirm').replace('{name}', field.name),
    );
    if (!confirmed) return;

    await updateSettings({
      properties: {
        fields: fields.filter((item) => item.key !== field.key),
      },
    });
    if (editingKey === field.key) cancelEdit();
    toast.success(t('preferences.documentProperties.deleteSuccess'));
  };

  return (
    <div className="space-y-4 pt-2">
      <SectionHeader title={t('preferences.documentProperties.title')} />
      <p className="text-sm text-[var(--muted-foreground)]">
        {t('preferences.documentProperties.description')}
      </p>

      {fields.length === 0 ? (
        <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-4 text-center text-sm text-[var(--muted-foreground)]">
          {t('preferences.documentProperties.empty')}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]">
          {fields.map((field) => {
            const isEditing = editingKey === field.key;
            const currentDraft = isEditing ? draft : null;
            const typeLabel = t(getPropertyTypeLabelKey(field.type as PropertyKind));
            const optionsLabel = field.options?.length ? field.options.join(', ') : '';

            return (
              <div
                key={field.key}
                className="border-b border-[var(--divider)] px-3 py-2.5 last:border-b-0"
              >
                {isEditing && currentDraft ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-[1fr_136px] gap-2">
                      <Input
                        value={currentDraft.name}
                        onChange={(event) => setDraft({ ...currentDraft, name: event.target.value })}
                        placeholder={t('preferences.documentProperties.namePlaceholder')}
                      />
                      <Select
                        value={currentDraft.type}
                        onValueChange={(value) => setDraft({
                          ...currentDraft,
                          type: value as PropertyFieldType,
                        })}
                      >
                        <SelectTrigger className="bg-[var(--background)]">
                          <SelectValue>
                            {t(getPropertyTypeLabelKey(currentDraft.type as PropertyKind))}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent align="start">
                          {PROPERTY_KINDS.map((kind) => (
                            <SelectItem key={kind} value={kind}>
                              {t(getPropertyTypeLabelKey(kind))}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {(currentDraft.type === 'Select' || currentDraft.type === 'MultiSelect') && (
                      <Input
                        value={currentDraft.optionsText}
                        onChange={(event) => setDraft({ ...currentDraft, optionsText: event.target.value })}
                        placeholder={t('preferences.documentProperties.optionsPlaceholder')}
                      />
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-mono text-xs text-[var(--muted-foreground)]">
                        {t('preferences.documentProperties.keyLabel')}: {field.key}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          tooltip={t('preferences.documentProperties.cancel')}
                          aria-label={t('preferences.documentProperties.cancel')}
                          onClick={cancelEdit}
                        >
                          <X />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          tooltip={t('preferences.documentProperties.save')}
                          aria-label={t('preferences.documentProperties.save')}
                          onClick={() => void saveEdit(field)}
                          className="text-[var(--primary)]"
                        >
                          <Check />
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-10 items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-[var(--foreground)]">
                          {field.name}
                        </span>
                        <span className="shrink-0 rounded-md bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                          {typeLabel}
                        </span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
                        <span className="truncate font-mono">{field.key}</span>
                        {optionsLabel ? (
                          <span className="truncate">{optionsLabel}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className={cn('flex shrink-0 items-center gap-1', !fieldsByKey.has(field.key) && 'hidden')}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        tooltip={t('preferences.documentProperties.edit')}
                        aria-label={`${t('preferences.documentProperties.edit')} ${field.name}`}
                        onClick={() => startEdit(field)}
                        className="rounded-lg"
                      >
                        <Pencil />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        tooltip={t('preferences.documentProperties.delete')}
                        aria-label={`${t('preferences.documentProperties.delete')} ${field.name}`}
                        onClick={() => void deleteField(field)}
                        className="rounded-lg text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
