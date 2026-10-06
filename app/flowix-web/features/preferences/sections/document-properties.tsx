'use client';

import { useMemo, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { PropertyFieldConfig, PropertyFieldType } from '@/lib/constants';
import { getPropertyTypeDefinition } from '@/lib/property-types';
import { cn } from '@/lib/utils';
import {
  isBuiltinPresetKey,
  PROPERTY_KINDS,
} from '@features/document/properties/presets';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import { useI18n } from '@/lib/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';

type DraftField = {
  key: string;
  type: PropertyFieldType;
  optionsText: string;
};

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
    key: field.key,
    type: field.type,
    optionsText: field.options?.join(', ') ?? '',
  };
}

function parseOptionTags(value: string): string[] {
  return [...new Set(value.split(/[,，]/).map((option) => option.trim()).filter(Boolean))];
}

function OptionTagsInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [inputValue, setInputValue] = useState('');
  const options = parseOptionTags(value);

  const commitInput = () => {
    const pendingOptions = parseOptionTags(inputValue);
    if (pendingOptions.length === 0) return;
    onChange([...new Set([...options, ...pendingOptions])].join(', '));
    setInputValue('');
  };

  const removeOption = (optionToRemove: string) => {
    onChange(options.filter((option) => option !== optionToRemove).join(', '));
  };

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1 focus-within:border-[var(--primary)]">
      {options.map((option) => (
        <span
          key={option}
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--muted)] px-2 py-0.5 text-xs text-[var(--foreground)]"
        >
          <span className="min-w-0 truncate">{option}</span>
          <button
            type="button"
            className="shrink-0 rounded-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            aria-label={`删除选项 ${option}`}
            onClick={() => removeOption(option)}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={inputValue}
        onChange={(event) => {
          const nextValue = event.target.value;
          if (nextValue.includes(',') || nextValue.includes('，')) {
            const pendingOptions = parseOptionTags(nextValue);
            if (pendingOptions.length > 0) {
              onChange([...new Set([...options, ...pendingOptions])].join(', '));
            }
            setInputValue('');
            return;
          }
          setInputValue(nextValue);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commitInput();
          } else if (event.key === 'Backspace' && !inputValue && options.length > 0) {
            removeOption(options[options.length - 1]);
          }
        }}
        onBlur={commitInput}
        placeholder={options.length === 0 ? placeholder : undefined}
        className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
      />
    </div>
  );
}

export function DocumentPropertiesSection() {
  const { t } = useI18n();
  const fields = useUserSettingsStore((store) => store.settings.properties.fields);
  const updateSettings = useUserSettingsStore((store) => store.updateSettings);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftField | null>(null);
  const [isAdding, setIsAdding] = useState(false);

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

  const startAdd = () => {
    setEditingKey(null);
    setDraft({ key: '', type: 'Text', optionsText: '' });
    setIsAdding(true);
  };

  const cancelAdd = () => {
    setIsAdding(false);
    setDraft(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const key = draft.key.trim();
    if (!key) {
      toast.error(t('preferences.documentProperties.emptyKey'));
      return;
    }
    if (isBuiltinPresetKey(key)) {
      toast.error(t('preferences.documentProperties.builtinKey'));
      return;
    }
    if (fields.some((item) => (
      canonicalizePropertyKey(item.key).toLowerCase() === canonicalizePropertyKey(key).toLowerCase()
      && item.key !== editingKey
    ))) {
      toast.error(t('preferences.documentProperties.duplicateKey'));
      return;
    }
    const nextField: PropertyFieldConfig = {
      key,
      type: draft.type,
      options: normalizeOptions(draft.type, draft.optionsText),
    };
    const nextFields = isAdding
      ? [...fields, nextField]
      : fields.map((item) => (item.key === editingKey ? nextField : item));
    await updateSettings({ properties: { fields: nextFields } });
    if (isAdding) {
      cancelAdd();
      toast.success(t('preferences.documentProperties.addSuccess'));
    } else {
      cancelEdit();
      toast.success(t('preferences.documentProperties.updateSuccess'));
    }
  };

  const deleteField = async (field: PropertyFieldConfig) => {
    const confirmed = window.confirm(
      t('preferences.documentProperties.deleteConfirm').replace('{key}', field.key),
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

      <div className="flex justify-start">
        <Button type="button" variant="outline" size="sm" className="rounded-lg px-3" onClick={startAdd} disabled={isAdding}>
          <Plus />
          {t('preferences.documentProperties.add')}
        </Button>
      </div>

      {isAdding && draft ? (
        <div className="rounded-lg border border-[var(--primary)] bg-[var(--card)] p-3">
          <div className="grid gap-2 sm:grid-cols-[136px_1fr]">
            <Select value={draft.type} onValueChange={(value) => setDraft({ ...draft, type: value as PropertyFieldType })}>
              <SelectTrigger className="bg-[var(--background)]"><SelectValue>{t(getPropertyTypeDefinition(draft.type).labelKey)}</SelectValue></SelectTrigger>
              <SelectContent align="end" fitViewport className="flowix-preferences-select-content max-w-[calc(100vw-1rem)]">
                {PROPERTY_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{t(getPropertyTypeDefinition(kind).labelKey)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} placeholder={t('preferences.documentProperties.keyPlaceholder')} />
          </div>
          {draft.type === 'Select' ? (
            <div className="mt-2">
              <OptionTagsInput
                value={draft.optionsText}
                onChange={(optionsText) => setDraft({ ...draft, optionsText })}
                placeholder={t('preferences.documentProperties.optionsPlaceholder')}
              />
            </div>
          ) : draft.type === 'MultiSelect' ? (
            <Input className="mt-2" value={draft.optionsText} onChange={(event) => setDraft({ ...draft, optionsText: event.target.value })} placeholder={t('preferences.documentProperties.optionsPlaceholder')} />
          ) : null}
          <div className="mt-2 flex justify-start gap-1">
            <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={cancelAdd}>{t('preferences.documentProperties.cancel')}</Button>
            <Button type="button" size="sm" className="rounded-lg" onClick={() => void saveDraft()}>{t('preferences.documentProperties.save')}</Button>
          </div>
        </div>
      ) : null}

      {fields.length === 0 && !isAdding ? (
        <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-4 text-center text-sm text-[var(--muted-foreground)]">
          {t('preferences.documentProperties.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((field) => {
            const isEditing = editingKey === field.key;
            const currentDraft = isEditing ? draft : null;
            const typeLabel = t(getPropertyTypeDefinition(field.type).labelKey);
            const optionsLabel = field.options?.length ? field.options.join(', ') : '';

            return (
              <div
                key={field.key}
                className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5"
              >
                {isEditing && currentDraft ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-[136px_1fr] gap-2">
                      <Select
                        value={currentDraft.type}
                        onValueChange={(value) => setDraft({
                          ...currentDraft,
                          type: value as PropertyFieldType,
                        })}
                      >
                        <SelectTrigger className="bg-[var(--background)]">
                          <SelectValue>
                            {t(getPropertyTypeDefinition(currentDraft.type).labelKey)}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent align="end" fitViewport className="flowix-preferences-select-content max-w-[calc(100vw-1rem)]">
                          {PROPERTY_KINDS.map((kind) => (
                            <SelectItem key={kind} value={kind}>
                              {t(getPropertyTypeDefinition(kind).labelKey)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={currentDraft.key}
                        onChange={(event) => setDraft({ ...currentDraft, key: event.target.value })}
                        placeholder={t('preferences.documentProperties.keyPlaceholder')}
                      />
                    </div>
                    {currentDraft.type === 'Select' ? (
                      <OptionTagsInput
                        value={currentDraft.optionsText}
                        onChange={(optionsText) => setDraft({ ...currentDraft, optionsText })}
                        placeholder={t('preferences.documentProperties.optionsPlaceholder')}
                      />
                    ) : currentDraft.type === 'MultiSelect' ? (
                      <Input
                        value={currentDraft.optionsText}
                        onChange={(event) => setDraft({ ...currentDraft, optionsText: event.target.value })}
                        placeholder={t('preferences.documentProperties.optionsPlaceholder')}
                      />
                    ) : null}
                    <div className="flex items-center justify-start gap-2">
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          tooltip={t('preferences.documentProperties.cancel')}
                          aria-label={t('preferences.documentProperties.cancel')}
                          onClick={cancelEdit}
                          className="rounded-lg"
                        >
                          <X />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          tooltip={t('preferences.documentProperties.save')}
                          aria-label={t('preferences.documentProperties.save')}
                          onClick={() => void saveDraft()}
                          className="rounded-lg text-[var(--primary)]"
                        >
                          <Check />
                        </Button>
                      </div>
                      <span className="min-w-0 truncate font-mono text-xs text-[var(--muted-foreground)]">
                        {t('preferences.documentProperties.keyLabel')}: {field.key}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-10 items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-[var(--foreground)]">
                          {field.key}
                        </span>
                        <span className="shrink-0 rounded-md bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                          {typeLabel}
                        </span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
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
                        aria-label={`${t('preferences.documentProperties.edit')} ${field.key}`}
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
                        aria-label={`${t('preferences.documentProperties.delete')} ${field.key}`}
                        onClick={() => void deleteField(field)}
                        className="text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--destructive)]"
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
