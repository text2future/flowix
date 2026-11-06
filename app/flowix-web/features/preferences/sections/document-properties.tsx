'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, GripVertical, Plus, X } from 'lucide-react';
import { PencilSimpleIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { toast } from '@/lib/toast';
import type { PropertyFieldConfig, PropertyFieldType } from '@/lib/constants';
import { createPropertyOptionId } from '@/lib/property-identity';
import { getPropertyTypeDefinition } from '@/lib/property-types';
import { cn } from '@/lib/utils';
import {
  getBuiltinPresets,
  isBuiltinPresetKey,
  PROPERTY_KINDS,
} from '@features/document/properties/presets';
import { canonicalizePropertyKey } from '@features/properties/property-key';
import { useI18n } from '@/lib/i18n';
import { persistPropertyRegistry, usePropertyPresetStore } from '@features/properties/property-preset-store';
import { countPresetTableReferences, deletePresetEverywhere, migrateNotePropertyKey, updatePresetFromTable } from '@features/properties/property-preset-service';
import { DeletePresetDialog } from '@features/properties/delete-preset-dialog';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';

type DraftField = {
  key: string;
  revision: number | null;
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
    revision: field.revision ?? 1,
    type: field.type,
    optionsText: field.options?.map((option) => option.label).join(', ') ?? '',
  };
}

function movePropertyField(
  fields: PropertyFieldConfig[],
  sourceKey: string,
  targetKey: string,
  insertAfter: boolean,
): PropertyFieldConfig[] | null {
  const sourceIndex = fields.findIndex((field) => field.key === sourceKey);
  if (sourceIndex < 0 || sourceKey === targetKey || !fields.some((field) => field.key === targetKey)) return null;
  const next = [...fields];
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return null;
  let insertIndex = next.findIndex((field) => field.key === targetKey);
  if (insertAfter) insertIndex += 1;
  next.splice(insertIndex, 0, moved);
  return next;
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

export function DocumentPropertiesSection({ hideSectionHeader = false }: { hideSectionHeader?: boolean }) {
  const { t } = useI18n();
  const fields = usePropertyPresetStore((store) => store.registry.fields);
  const presetsLoaded = usePropertyPresetStore((store) => store.loaded);
  const loadPresets = usePropertyPresetStore((store) => store.load);

  // 偏好设置窗不再在启动期预载属性预设 (省一次 IPC / 文件读取), 由本页按需补齐。
  // 主窗口已经加载过时 loaded 为 true, 这里直接跳过, 与 memo-title-editor 等调用方同一约定。
  useEffect(() => {
    if (presetsLoaded) return;
    void loadPresets().catch(() => undefined);
  }, [loadPresets, presetsLoaded]);
  const systemFields = usePropertyPresetStore((store) => store.registry.systemFields ?? []);
  const properties = usePropertyPresetStore((store) => store.registry);
  const systemPresets = getBuiltinPresets(t, systemFields);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftField | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [deletingPreset, setDeletingPreset] = useState<PropertyFieldConfig | null>(null);
  const [deletingTableCount, setDeletingTableCount] = useState(0);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [draggedFieldKey, setDraggedFieldKey] = useState<string | null>(null);
  const [dragOverField, setDragOverField] = useState<{ key: string; insertAfter: boolean } | null>(null);
  const fieldListRef = useRef<HTMLDivElement | null>(null);
  const dragSessionRef = useRef<{ key: string; pointerId: number; startX: number; startY: number; active: boolean } | null>(null);
  const dragOverFieldRef = useRef<{ key: string; insertAfter: boolean } | null>(null);
  const previousRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const visibleFields = (() => {
    if (!draggedFieldKey || !dragOverField) return fields;
    return movePropertyField(fields, draggedFieldKey, dragOverField.key, dragOverField.insertAfter) ?? fields;
  })();

  const fieldsByKey = useMemo(() => {
    return new Map(fields.map((field) => [field.key, field]));
  }, [fields]);

  const captureFieldPositions = () => {
    const rows = fieldListRef.current?.querySelectorAll<HTMLElement>('[data-property-field-key]');
    previousRectsRef.current = new Map(
      [...(rows ?? [])].map((row) => [row.dataset.propertyFieldKey ?? '', row.getBoundingClientRect()]),
    );
  };

  const setDropPreview = (target: { key: string; insertAfter: boolean } | null) => {
    const current = dragOverFieldRef.current;
    if (current?.key === target?.key && current?.insertAfter === target?.insertAfter) return;
    captureFieldPositions();
    dragOverFieldRef.current = target;
    setDragOverField(target);
  };

  useLayoutEffect(() => {
    const previousRects = previousRectsRef.current;
    previousRectsRef.current = null;
    if (!previousRects || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rows = fieldListRef.current?.querySelectorAll<HTMLElement>('[data-property-field-key]');
    rows?.forEach((row) => {
      const key = row.dataset.propertyFieldKey;
      const previous = key ? previousRects.get(key) : null;
      if (!previous) return;
      const next = row.getBoundingClientRect();
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaY) < 1) return;
      row.getAnimations().forEach((animation) => animation.cancel());
      row.animate([{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }], {
        duration: 180,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      });
    });
  }, [dragOverField, fields]);

  const getFieldDropTarget = (x: number, y: number, sourceKey: string) => {
    const bounds = fieldListRef.current?.getBoundingClientRect();
    if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    const rows = [...(fieldListRef.current?.querySelectorAll<HTMLElement>('[data-property-field-key]') ?? [])]
      .filter((row) => row.dataset.propertyFieldKey !== sourceKey);
    for (const row of rows) {
      const key = row.dataset.propertyFieldKey;
      if (!key) continue;
      const rowBounds = row.getBoundingClientRect();
      if (y < rowBounds.top + rowBounds.height / 2) return { key, insertAfter: false };
    }
    const lastKey = rows[rows.length - 1]?.dataset.propertyFieldKey;
    return lastKey ? { key: lastKey, insertAfter: true } : null;
  };

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, key: string) => {
    if (event.button !== 0 || isAdding || editingKey !== null) return;
    event.preventDefault();
    dragSessionRef.current = { key, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window listeners finish the drag. */ }
  };

  useEffect(() => {
    const cancelActiveDrag = () => {
      if (!dragSessionRef.current) return;
      dragSessionRef.current = null;
      captureFieldPositions();
      dragOverFieldRef.current = null;
      setDraggedFieldKey(null);
      setDragOverField(null);
    };
    const onPointerMove = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      if (!session.active) {
        if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < 6) return;
        session.active = true;
        setDraggedFieldKey(session.key);
      }
      setDropPreview(getFieldDropTarget(event.clientX, event.clientY, session.key));
    };
    const finishPointerDrag = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      const target = session.active ? getFieldDropTarget(event.clientX, event.clientY, session.key) : null;
      dragSessionRef.current = null;
      if (target) {
        const next = movePropertyField(fields, session.key, target.key, target.insertAfter);
        if (next) {
          captureFieldPositions();
          void persistPropertyRegistry(next, properties.deletedFields ?? [], properties.systemFields ?? []).catch((error) => toast.error(error instanceof Error ? error.message : '保存预设顺序失败'));
        }
      } else {
        captureFieldPositions();
      }
      dragOverFieldRef.current = null;
      setDraggedFieldKey(null);
      setDragOverField(null);
    };
    const cancelPointerDrag = (event: PointerEvent) => {
      if (dragSessionRef.current?.pointerId === event.pointerId) cancelActiveDrag();
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishPointerDrag);
    window.addEventListener('pointercancel', cancelPointerDrag);
    window.addEventListener('lostpointercapture', cancelPointerDrag);
    window.addEventListener('blur', cancelActiveDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishPointerDrag);
      window.removeEventListener('pointercancel', cancelPointerDrag);
      window.removeEventListener('lostpointercapture', cancelPointerDrag);
      window.removeEventListener('blur', cancelActiveDrag);
    };
  }, [fields, properties.deletedFields, properties.systemFields]);

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
    setDraft({ key: '', revision: null, type: 'Text', optionsText: '' });
    setIsAdding(true);
  };

  const cancelAdd = () => {
    setIsAdding(false);
    setDraft(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const key = canonicalizePropertyKey(draft.key.trim());
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
    const previous = fields.find((item) => item.key === editingKey);
    const options = normalizeOptions(draft.type, draft.optionsText);
    const nextField: PropertyFieldConfig = {
      ...(previous ? { ...previous, revision: (previous.revision ?? 1) + 1 } : {}),
      key,
      type: draft.type,
      options: options?.map((label, index) => ({ label, id: previous?.options?.find((option) => option.label === label)?.id
        ?? (previous?.options?.[index] && !options.includes(previous.options[index].label) ? previous.options[index].id : createPropertyOptionId()) })),
    };
    const nextFields = isAdding
      ? [nextField, ...fields]
      : fields.map((item) => (item.key === editingKey ? nextField : item));
    try {
      if (previous?.id) {
        await updatePresetFromTable({ id: previous.id, type: previous.type, property_key: previous.key, preset_revision: draft.revision ?? 1 }, nextField);
        if (previous.key !== key) await migrateNotePropertyKey(previous.key, key);
      } else {
        await persistPropertyRegistry(nextFields, properties.deletedFields ?? []);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存属性预设失败');
      return;
    }
    if (isAdding) {
      cancelAdd();
      toast.success(t('preferences.documentProperties.addSuccess'));
    } else {
      cancelEdit();
      toast.success(t('preferences.documentProperties.updateSuccess'));
    }
  };

  const deleteField = async (field: PropertyFieldConfig) => {
    const tableCount = field.id ? await countPresetTableReferences(field.id) : 0;
    setDeletingPreset(field);
    setDeletingTableCount(tableCount);
  };

  const confirmDeletePreset = async () => {
    const field = deletingPreset;
    if (!field) return;
    setDeletingBusy(true);
    try {
      const result = await deletePresetEverywhere(field);
      if (result.failed) {
        toast.error(t('preferences.documentProperties.deleteNoteValuesFailed').replace('{count}', String(result.failed)));
      } else {
        toast.success(t('preferences.documentProperties.deleteSuccess'));
      }
      if (editingKey === field.key) cancelEdit();
      setDeletingPreset(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除属性预设失败');
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {!hideSectionHeader && (
        <SectionHeader
          title={t('preferences.documentProperties.title')}
          description={t('preferences.documentProperties.description')}
        />
      )}

      <section className="space-y-2" aria-labelledby="document-properties-mine-heading">
        <div className="flex items-center justify-between pt-2">
          <h4 id="document-properties-mine-heading" className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
            {t('preferences.documentProperties.group.mine')}
          </h4>
          <Button type="button" variant="outline" className="h-8 gap-0.5" onClick={startAdd} disabled={isAdding}>
            <Plus className="size-3.5" />
            {t('preferences.documentProperties.add')}
          </Button>
        </div>

        {isAdding && draft ? (
          <div className="rounded-xl border border-[var(--primary)] bg-[var(--card)] p-3">
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

        {fields.length > 0 ? <div ref={fieldListRef} className="space-y-2">
          {visibleFields.map((field) => {
            const isEditing = editingKey === field.key;
            const currentDraft = isEditing ? draft : null;
            const typeLabel = t(getPropertyTypeDefinition(field.type).labelKey);
            const optionsLabel = field.options?.length ? field.options.map((option) => option.label).join(', ') : '';

            return (
              <div
                key={field.key}
                data-property-field-key={field.key}
                className={`rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-[5px] transition-all ${dragOverField?.key === field.key ? 'border-[var(--brand)] bg-[var(--brand)]/5' : ''} ${draggedFieldKey === field.key ? 'opacity-50' : ''}`}
              >
                {isEditing && currentDraft ? (
                  <div className="space-y-2">
                    <div className="mt-2 grid grid-cols-[136px_1fr] gap-2">
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
                      <Input value={currentDraft.key} onChange={(event) => setDraft({ ...currentDraft, key: event.target.value })} placeholder={t('preferences.documentProperties.keyPlaceholder')} />
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
                          size="sm"
                          aria-label={t('preferences.documentProperties.save')}
                          onClick={() => void saveDraft()}
                          className="h-8 gap-1 rounded-lg px-2 text-[var(--primary)]"
                        >
                          <Check className="h-4 w-4" />
                          {t('preferences.documentProperties.save')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t('preferences.documentProperties.cancel')}
                          onClick={cancelEdit}
                          className="h-8 gap-1 rounded-lg px-2"
                        >
                          <X className="h-4 w-4" />
                          {t('preferences.documentProperties.cancel')}
                        </Button>
                      </div>
                      <span className="ml-auto min-w-0 truncate text-right font-mono text-xs text-[var(--muted-foreground)]">
                        {t('preferences.documentProperties.keyLabel')}: {field.key}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-8 items-center gap-3">
                    <button
                      type="button"
                      title={t('preferences.documentProperties.dragToReorder')}
                      aria-label={`${t('preferences.documentProperties.dragToReorder')} ${field.key}`}
                      disabled={isAdding || editingKey !== null}
                      onPointerDown={(event) => onHandlePointerDown(event, field.key)}
                      className="flex h-7 w-5 shrink-0 touch-none cursor-grab select-none items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--muted)] active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <GripVertical className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-[var(--foreground)]">{field.key}</span>
                        <span className="shrink-0 rounded-md bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                          {typeLabel}
                        </span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
                        {optionsLabel ? <span className="truncate">{optionsLabel}</span> : null}
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
                        <PencilSimpleIcon className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        tooltip={t('preferences.documentProperties.delete')}
                        aria-label={`${t('preferences.documentProperties.delete')} ${field.key}`}
                        onClick={() => void deleteField(field)}
                        className="size-7 hover:text-[var(--destructive)]"
                      >
                        <TrashSimpleIcon className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div> : <p className="px-1 py-2 text-sm text-[var(--muted-foreground)]">{t('preferences.documentProperties.empty')}</p>}
      </section>

      <section className="space-y-2" aria-labelledby="document-properties-presets-heading">
        <div className="flex items-center justify-between pt-2">
          <h4 id="document-properties-presets-heading" className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
            {t('preferences.documentProperties.group.presets')}
          </h4>
        </div>
        {systemPresets.map((preset) => (
          <div key={preset.key} className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-[5px]">
            <div className="flex min-h-8 items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
                  <span className="truncate text-sm text-[var(--foreground)]">{preset.label}</span>
                  <span className="shrink-0 font-mono text-xs text-[var(--muted-foreground)]">{preset.key}</span>
                  <span className="shrink-0 rounded-md bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                    {t(getPropertyTypeDefinition(preset.kind).labelKey)}
                  </span>
                </div>
              </div>
              <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{t('document.properties.category.system')}</span>
            </div>
          </div>
        ))}
      </section>

      <DeletePresetDialog
        preset={deletingPreset}
        tableCount={deletingTableCount}
        busy={deletingBusy}
        onCancel={() => { if (!deletingBusy) setDeletingPreset(null); }}
        onConfirm={() => { void confirmDeletePreset(); }}
      />
    </div>
  );
}
