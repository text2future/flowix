'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { useI18n } from '@/lib/i18n';
import { usePropertyFieldPreferences } from '@features/preferences/public/runtime-api';
import type { PropertyPreset } from '@features/document/properties/presets';
import { SelectValueInput } from '@features/document/properties/select-value-input';
import { MultiSelectValueInput } from '@features/document/properties/multi-select-value-input';
import { IconValueInput } from '@features/document/properties/icon-value-input';
import { generatePropertyKey } from '@features/document/properties/property-key';
import { extractFrontmatter } from '@features/document/properties/frontmatter-model';
import type { PropertyFieldConfig } from '@/lib/constants';
import { cn } from '@/lib/utils';

import {
  buildContentWithFrontmatter,
  coerceValueForType,
  createRowId,
  getDuplicateKeys,
  normalizeFieldOptions,
  rowsFromData,
  type PropertyRow,
  type PropertyType,
} from './note-properties/property-row-model';
import { DateValueInput } from './note-properties/date-value-input';
import {
  AnchoredPropertyPopover,
  CommonPropertyChips,
  PropertyKeyButton,
  type PopoverAnchor,
} from './note-properties/property-editor-popover';

interface NotePropertiesDialogProps {
  open: boolean;
  content: string;
  onOpenChange: (open: boolean) => void;
  onSave: (nextContent: string) => void | Promise<void>;
}


export function NotePropertiesDialog({
  open,
  content,
  onOpenChange,
  onSave,
}: NotePropertiesDialogProps) {
  const { t } = useI18n();
  const { fields: savedPropertyFields, saveFields } = usePropertyFieldPreferences();
  const frontmatter = useMemo(() => extractFrontmatter(content), [content]);
  const savedFieldsByKey = useMemo(() => {
    return new Map(savedPropertyFields.map((field) => [field.key, field]));
  }, [savedPropertyFields]);
  const savedFieldsByKeyRef = useRef(savedFieldsByKey);
  const [rows, setRows] = useState<PropertyRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  // 共享 Popover 状态: 既用于 "添加属性" 按钮 (mode='add'), 也用于
  // 行内 key cell 点击 (mode='edit')。 anchor 记录触发按钮的 viewport
  // 坐标, AnchoredPropertyPopover 再决定显示在按钮上方或下方。
  const [popoverState, setPopoverState] = useState<{
    open: boolean;
    mode: 'add' | 'edit';
    rowId: string | null;
    anchor: PopoverAnchor | null;
  }>({
    open: false,
    mode: 'add',
    rowId: null,
    anchor: null,
  });

  const closePopover = () => {
    setPopoverState({
      open: false,
      mode: 'add',
      rowId: null,
      anchor: null,
    });
  };

  const openAddPopover = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopoverState({
      open: true,
      mode: 'add',
      rowId: null,
      anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    });
  };

  const openEditPopover = (row: PropertyRow, e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopoverState({
      open: true,
      mode: 'edit',
      rowId: row.id,
      anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    });
  };

  useEffect(() => {
    savedFieldsByKeyRef.current = savedFieldsByKey;
  }, [savedFieldsByKey]);

  useEffect(() => {
    if (!open) return;
    setRows(rowsFromData(frontmatter.data, savedFieldsByKeyRef.current));
  }, [frontmatter.data, open]);

  const duplicateKeys = useMemo(() => getDuplicateKeys(rows), [rows]);
  const hasInvalidKey = rows.some((row) => !row.key.trim());
  const canSave = !isSaving && !frontmatter.parseError && !hasInvalidKey && duplicateKeys.size === 0;

  const updateRow = (id: string, patch: Partial<PropertyRow>) => {
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      const nextType = patch.type ?? row.type;
      const nextValue = patch.type ? coerceValueForType(row.value, nextType) : row.value;
      return { ...row, ...patch, value: patch.value ?? nextValue };
    }));
  };

  // 直接添加一个预设行 (面板 "推荐" chip 命中)。 type 取 preset.kind,
  // value 留空。 选项走 preset.options (UI-only)。
  const addPresetRow = (preset: PropertyPreset) => {
    setRows((current) => [
      ...current,
      {
        id: createRowId(),
        key: preset.key,
        type: preset.kind as PropertyType,
        value: '',
        preset,
      },
    ]);
    closePopover();
  };

  const persistCustomFieldDefinition = (
    field: { key: string; name: string; type: PropertyType; options?: string[] },
    previousKey?: string
  ) => {
    const key = field.key.trim();
    const name = field.name.trim();
    if (!key || !name) return;
    const definition: PropertyFieldConfig = {
      key,
      name,
      type: field.type,
      options: normalizeFieldOptions(field.type, field.options),
    };
    const nextFields = [
      ...savedPropertyFields.filter((item) => item.key !== key && item.key !== previousKey),
      definition,
    ];
    void saveFields(nextFields);
  };

  // 自定义添加: name 是展示名, key 按固定 kebab-case 规则生成。
  const addCustomField = async (payload: { name: string; type: PropertyType; options?: string[] }) => {
    const name = payload.name.trim();
    if (!name) return;
    const key = await generatePropertyKey(name);
    const options = normalizeFieldOptions(payload.type, payload.options);
    setRows((current) => [
      ...current,
      {
        id: createRowId(),
        key,
        type: payload.type,
        value: '',
        customLabel: name,
        options,
      },
    ]);
    persistCustomFieldDefinition({ key, name, type: payload.type, options });
    closePopover();
  };

  const addSavedCustomField = (field: PropertyFieldConfig) => {
    setRows((current) => [
      ...current,
      {
        id: createRowId(),
        key: field.key,
        type: field.type,
        value: '',
        customLabel: field.name,
        options: normalizeFieldOptions(field.type, field.options),
      },
    ]);
    closePopover();
  };

  // 编辑现有行: 把整行替换成预设 — 重置 key/type/customLabel/options,
  // preset.options 由 preset 字段在渲染时取。 该路径会清空用户的 customLabel
  // 和 options, 因为切预设就是切语义, 旧的自定义数据不再适用。
  const switchRowToPreset = (id: string, preset: PropertyPreset) => {
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      return {
        ...row,
        key: preset.key,
        type: preset.kind as PropertyType,
        preset,
        customLabel: undefined,
        options: undefined,
      };
    }));
    closePopover();
  };

  // 编辑现有行: 自定义路径, 以展示名重新生成 key, 并更新 type/options。
  // 与 addCustomField 区别: 改的是已有行而不是 push 新行; preset 字段清掉。
  const updateRowFromEdit = async (
    id: string,
    payload: { name: string; type: PropertyType; options?: string[] }
  ) => {
    const name = payload.name.trim();
    if (!name) return;
    const key = await generatePropertyKey(name);
    const options = normalizeFieldOptions(payload.type, payload.options);
    const previousKey = rows.find((row) => row.id === id)?.key;
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      return {
        ...row,
        key,
        type: payload.type,
        customLabel: name,
        options,
        preset: undefined,
      };
    }));
    persistCustomFieldDefinition({ key, name, type: payload.type, options }, previousKey);
    closePopover();
  };

  const switchRowToSavedCustomField = (id: string, field: PropertyFieldConfig) => {
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      return {
        ...row,
        key: field.key,
        type: field.type,
        customLabel: field.name,
        options: normalizeFieldOptions(field.type, field.options),
        preset: undefined,
      };
    }));
    closePopover();
  };

  const removeRow = (id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await onSave(buildContentWithFrontmatter(content, rows));
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[640px] max-w-[calc(100vw-32px)] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DialogHeader>
          <DialogTitle>{t('document.properties.title')}</DialogTitle>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          {frontmatter.parseError && (
            <div className="rounded-lg border border-[color-mix(in_oklch,var(--destructive)_35%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_8%,transparent)] px-3 py-2 text-xs text-[var(--destructive)]">
              {t('document.properties.yamlParseError')}
            </div>
          )}

          <div className="max-h-[360px] overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            {/* 顶部列名 (字段 / 值) 已去掉 — 表头文案对引导式 picker 来说
                噪音大于信息, key 列触发键的 placeholder 已经说明了用法,
                值列因 type 不同形态各异也不宜硬贴一个 "值" 标签。 */}
            <div className="grid grid-cols-[minmax(88px,0.67fr)_minmax(192px,1.73fr)_32px] gap-2 pb-1">
              <span />
              <span />
              <span />
            </div>

            <div className="space-y-2">
              {rows.map((row) => {
                const keyInvalid = !row.key.trim() || duplicateKeys.has(row.key.trim());
                const isKeyField = row.key.trim() === 'key';
                // 类型列已去掉: 类型只在 Custom 弹窗内设置一次, 行内不再
                // 暴露 type 编辑入口。 row.type 仍用于值列分发 (MultiSelect /
                // Select / Date / 通用 Input) 与 Select 选项。
                // Select 的 option 列表优先级: row.options (自定义) >
                // row.preset.options (预设)。 MultiSelect 行无 option 上限,
                // 由用户在 chips 输入里随意加, 不读这个字段。
                const presetOptions = row.options ?? row.preset?.options ?? [];
                return (
                  <div
                    key={row.id}
                    className="grid grid-cols-[minmax(88px,0.67fr)_minmax(192px,1.73fr)_32px] items-center gap-2"
                  >
                    <PropertyKeyButton
                      row={row}
                      disabled={isKeyField}
                      invalid={keyInvalid}
                      onClick={(e: React.MouseEvent<HTMLButtonElement>) => openEditPopover(row, e)}
                    />
                    {row.type === 'MultiSelect' ? (
                      <MultiSelectValueInput
                        value={row.value}
                        disabled={isKeyField}
                        onChange={(value) => updateRow(row.id, { value })}
                      />
                    ) : row.type === 'Date' ? (
                      <DateValueInput
                        value={row.value}
                        disabled={isKeyField}
                        onChange={(value) => updateRow(row.id, { value })}
                      />
                    ) : row.type === 'Icon' ? (
                      <IconValueInput
                        value={row.value}
                        disabled={isKeyField}
                        onChange={(value) => updateRow(row.id, { value })}
                      />
                    ) : row.type === 'Select' ? (
                      <SelectValueInput
                        value={row.value}
                        options={presetOptions}
                        disabled={isKeyField}
                        onChange={(value) => updateRow(row.id, { value })}
                      />
                    ) : (
                      <Input
                        type={row.type === 'URL' ? 'url' : row.type === 'Number' ? 'number' : 'text'}
                        value={row.value}
                        onChange={(event) => updateRow(row.id, { value: event.target.value })}
                        disabled={isKeyField}
                        className="h-8"
                      />
                    )}
                    {isKeyField ? (
                      <div className="h-8 w-8" />
                    ) : (
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
                      aria-label={t('document.properties.deleteField')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    )}
                  </div>
                );
              })}
            </div>

            {rows.length === 0 && !frontmatter.parseError && (
              <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-sm text-[var(--muted-foreground)]">
                {t('document.properties.empty')}
              </div>
            )}
          </div>

          {duplicateKeys.size > 0 && (
            <div className="text-xs text-[var(--destructive)]">{t('document.properties.duplicateKey')}</div>
          )}
          {hasInvalidKey && (
            <div className="text-xs text-[var(--destructive)]">{t('document.properties.emptyKey')}</div>
          )}

          {popoverState.open && popoverState.anchor && (
            <AnchoredPropertyPopover
              popoverState={popoverState}
              rows={rows}
              savedFields={savedPropertyFields}
              addPresetRow={addPresetRow}
              addCustomField={addCustomField}
              addSavedCustomField={addSavedCustomField}
              switchRowToPreset={switchRowToPreset}
              switchRowToSavedCustomField={switchRowToSavedCustomField}
              updateRowFromEdit={updateRowFromEdit}
              onCancel={closePopover}
            />
          )}

          {/* "添加属性" 按钮 — 单独挂在 Popover 外, 通过 openAddPopover
              把自己的 rect 写入 popoverState.anchor 触发 Popover 打开。
              这里不能用 PopoverTrigger asChild, 因为 PopoverTrigger 会
              接管 onClick 并尝试 toggle, 而我们想完全受控。 */}
          <button
            type="button"
            disabled={!!frontmatter.parseError}
            onClick={openAddPopover}
            className={cn(
              'inline-flex h-8 items-center gap-0.5 rounded-lg text-sm text-[var(--muted-foreground)] transition-colors',
              'hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50',
              'data-[state=open]:text-[var(--foreground)]'
            )}
          >
            <Plus className="h-4 w-4 transition-transform duration-150 [[data-state=open]_&]:rotate-45" />
            {t('document.properties.addField')}
          </button>

          <div className="mt-2 flex flex-col gap-1.5">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              {t('document.properties.addFieldPanel.common')}
            </span>
            <CommonPropertyChips
              savedFields={savedPropertyFields}
              onPickPreset={addPresetRow}
              onPickSavedField={addSavedCustomField}
              disabled={!!frontmatter.parseError}
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]"
          >
            {t('document.properties.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="h-8 rounded-lg bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('document.properties.save')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
