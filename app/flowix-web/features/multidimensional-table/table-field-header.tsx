'use client';

import { useRef, useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { TrashSimpleIcon } from '@phosphor-icons/react';
import { files, type NotebookFolderOption } from '@platform/tauri/client';
import { ResourceFolderIcon } from '@features/surface/resource-file-icon';
import type { PropertyPreset } from '@features/document/properties/presets';
import { createPropertySvgIcon } from '@features/document/properties/property-type-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import type { I18nKey } from '@/lib/i18n';
import type { PropertyIconKind, PropertyKind } from '@/lib/property-types';
import { createUuidV7, type TableAutoCollectConfig, type TableAutoCollectCondition, type TableAutoCollectFileType, type TableAutoCollectPropertyCondition, type TableField, type TableFieldOption, type TableFieldType } from './model';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import type { ReactNode } from 'react';

export function FieldTypeIcon({ kind, title, compact = false }: { kind: PropertyIconKind; title: string; compact?: boolean }) {
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const icon = createPropertySvgIcon(kind);
    hostRef.current?.replaceChildren(icon);
    return () => icon.remove();
  }, [kind]);

  return <span ref={hostRef} title={title} aria-hidden="true" className={`inline-flex ${compact ? 'h-4 w-4' : 'h-5 w-5'} shrink-0 items-center justify-center text-[var(--muted-foreground)]`} />;
}

export function TablePresetMenu({
  customPresets,
  systemPresets,
  disabled,
  open,
  onOpenChange,
  t,
  onSelect,
  onManage,
}: {
  customPresets: PropertyPreset[];
  systemPresets: PropertyPreset[];
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: I18nKey) => string;
  onSelect: (preset: PropertyPreset) => void;
  onManage: () => void;
}) {
  const renderGroup = (title: string, presets: PropertyPreset[]) => presets.length > 0 && <section className="space-y-0.5">
    <p className="agent-thread-card__codex-settings-title">{title}</p>
    {presets.map((preset) => <button
      key={`${preset.source}:${preset.key}`}
      type="button"
      disabled={disabled}
      onClick={() => onSelect(preset)}
      className="flex h-8 w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50"
      title={preset.key}
    >
      <span className="min-w-0 truncate">{preset.label}</span>
      <span className="shrink-0 truncate text-xs text-[var(--muted-foreground)]">{preset.key}</span>
    </button>)}</section>;

  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] data-[state=open]:bg-[var(--hover-bg)] data-[state=open]:text-[var(--foreground)] disabled:opacity-50">
        <span>预设属性</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent side="left" align="start" sideOffset={0} ignoreSelectOutside={false} style={{ zIndex: 170 }} className="max-h-[min(70vh,420px)] w-[213px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl px-0.5 py-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <div className="space-y-2">
        {renderGroup(t('document.properties.category.system'), systemPresets)}
        {renderGroup(t('document.properties.category.custom'), customPresets)}
        <button type="button" disabled={disabled} onClick={onManage} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:opacity-50">
          预设属性管理
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" aria-hidden="true" />
        </button>
      </div>
    </PopoverContent>
  </Popover>;
}

interface TableFieldHeaderProps {
  field: TableField;
  label: string;
  conditionOnly?: boolean;
  compact?: boolean;
  showAutoCollect?: boolean;
  conditionPanelContent?: ReactNode;
  ignoreConditionPanelOutside?: boolean;
  notebookPath?: string | null;
  saving: boolean;
  open: boolean;
  typeChoices: TableFieldType[];
  customPresets: PropertyPreset[];
  systemPresets: PropertyPreset[];
  t: (key: I18nKey) => string;
  typeLabel: (type: PropertyKind | 'primary') => string;
  typeIconKind: (type: TableFieldType) => PropertyIconKind;
  onOpenChange: (open: boolean) => void;
  onSaveEdits: (field: TableField, name: string, options: TableFieldOption[]) => Promise<boolean>;
  onChangeType: (field: TableField, type: TableFieldType, options: TableFieldOption[]) => Promise<boolean>;
  onApplyPreset: (field: TableField, preset: PropertyPreset) => Promise<boolean>;
  onDelete: (field: TableField) => Promise<boolean>;
  onManagePresets: () => void;
  autoCollectFields: Array<{ id: string; label: string }>;
  autoCollectConfig?: TableAutoCollectConfig | null;
  onSaveAutoCollect: (field: TableField, condition: TableAutoCollectCondition) => Promise<boolean>;
}

type AutoCollectFieldOption = { id: string; label: string };

function normalizeAutoCollectFileType(value: string | undefined): TableAutoCollectFileType {
  if (value?.trim().toLowerCase() === 'markdown') return 'markdown';
  return '';
}

function readAutoCollectCondition(field: TableField, fields: AutoCollectFieldOption[], config: TableAutoCollectConfig | null): TableAutoCollectCondition {
  const condition = config?.condition ?? {};
  return {
    ...condition,
    property_match: condition.property_match ?? 'union',
    property_conditions: (condition.property_conditions ?? [{ field_id: field.id, operator: 'contains' as const, value: '' }]).map((item) => ({
      ...item,
      field_id: fields.find((fieldOption) => fieldOption.id === item.field_id)?.label ?? item.field_id,
    })),
    file_condition: {
      file_name_contains: '',
      path_contains: '',
      ...condition.file_condition,
      file_type: normalizeAutoCollectFileType(condition.file_condition?.file_type),
    },
  };
}

function resolveAutoCollectCondition(
  condition: TableAutoCollectCondition,
  fields: AutoCollectFieldOption[],
): TableAutoCollectCondition {
  const resolveField = (fieldId: string) => fields.find((item) => item.id === fieldId)
    ?? fields.find((item) => item.label === fieldId);
  const propertyConditions = condition.property_conditions?.map((item) => ({
    ...item,
    field_id: resolveField(item.field_id)?.id ?? item.field_id,
  }));
  return {
    ...condition,
    ...(propertyConditions ? { property_conditions: propertyConditions } : {}),
  };
}

export function TableFieldHeader({
  field,
  label,
  conditionOnly = false,
  compact = false,
  showAutoCollect = false,
  conditionPanelContent,
  ignoreConditionPanelOutside = false,
  notebookPath,
  saving,
  open,
  typeChoices,
  customPresets,
  systemPresets,
  t,
  typeLabel,
  typeIconKind,
  onOpenChange,
  onSaveEdits,
  onChangeType,
  onApplyPreset,
  onDelete,
  onManagePresets,
  autoCollectFields,
  autoCollectConfig = null,
  onSaveAutoCollect,
}: TableFieldHeaderProps) {
  const [propertyKeyDraft, setPropertyKeyDraft] = useState(label);
  const [optionsDraft, setOptionsDraft] = useState<TableFieldOption[]>(field.options ?? []);
  const [autoCollectDraft, setAutoCollectDraft] = useState<TableAutoCollectCondition>(() => readAutoCollectCondition(field, autoCollectFields, autoCollectConfig));
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [autoCollectMenuOpen, setAutoCollectMenuOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderOptions, setFolderOptions] = useState<NotebookFolderOption[]>([]);
  const [folderOptionsLoading, setFolderOptionsLoading] = useState(false);
  const wasOpenRef = useRef(open);
  const skipSaveOnCloseRef = useRef(false);

  useEffect(() => {
    if (wasOpenRef.current === open) return;
    wasOpenRef.current = open;
    setTypeMenuOpen(false);
    setPresetMenuOpen(false);
    setAutoCollectMenuOpen(false);
    setFolderPickerOpen(false);
    if (open) {
      setPropertyKeyDraft(label);
      setOptionsDraft(field.options ?? []);
      setAutoCollectDraft(readAutoCollectCondition(field, autoCollectFields, autoCollectConfig));
      return;
    }
    const skipSave = skipSaveOnCloseRef.current;
    skipSaveOnCloseRef.current = false;
    if (!skipSave) {
      if (conditionOnly) void onSaveAutoCollect(field, resolveAutoCollectCondition(autoCollectDraft, autoCollectFields));
      else if (field.type === 'primary') return;
      else void onSaveEdits(field, propertyKeyDraft, optionsDraft);
    }
  }, [autoCollectConfig, autoCollectDraft, autoCollectFields, conditionOnly, field, label, onSaveAutoCollect, onSaveEdits, open, optionsDraft, propertyKeyDraft]);

  useEffect(() => {
    if (!folderPickerOpen || !notebookPath) return;
    let active = true;
    setFolderOptionsLoading(true);
    void files.getNotebookFolderOptions(notebookPath).then((options) => {
      if (active) setFolderOptions(options);
    }).catch(() => {
      if (active) setFolderOptions([]);
    }).finally(() => {
      if (active) setFolderOptionsLoading(false);
    });
    return () => { active = false; };
  }, [folderPickerOpen, notebookPath]);

  const handleOpenChange = (nextOpen: boolean) => {
    setTypeMenuOpen(false);
    setPresetMenuOpen(false);
    setAutoCollectMenuOpen(false);
    setFolderPickerOpen(false);
    if (nextOpen) {
      setPropertyKeyDraft(label);
      setOptionsDraft(field.options ?? []);
      setAutoCollectDraft(readAutoCollectCondition(field, autoCollectFields, autoCollectConfig));
    }
    onOpenChange(nextOpen);
  };

  const closeMenu = () => {
    skipSaveOnCloseRef.current = true;
    setTypeMenuOpen(false);
    setPresetMenuOpen(false);
    setAutoCollectMenuOpen(false);
    setFolderPickerOpen(false);
    onOpenChange(false);
  };

  const submitName = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await onSaveEdits(field, propertyKeyDraft, optionsDraft)) closeMenu();
  };

  const selectPreset = async (preset: PropertyPreset) => {
    setPresetMenuOpen(false);
    if (await onApplyPreset(field, preset)) closeMenu();
  };

  const deleteField = async () => {
    if (await onDelete(field)) closeMenu();
  };

  const managePresets = async () => {
    if (!await onSaveEdits(field, propertyKeyDraft, optionsDraft)) return;
    onManagePresets();
    closeMenu();
  };

  const changeType = async (type: TableFieldType) => {
    setTypeMenuOpen(false);
    const nextOptions = type === 'Select' || type === 'MultiSelect'
      ? type === field.type || field.options?.length
        ? field.options ?? []
        : ['选项 1', '选项 2', '选项 3'].map((label) => ({ id: `opt_${createUuidV7()}`, label }))
      : [];
    if (await onChangeType(field, type, nextOptions)) setOptionsDraft(nextOptions);
  };

  return <Popover open={open} onOpenChange={handleOpenChange}>
    <PopoverTrigger asChild>
      <button type="button" disabled={saving} title={conditionOnly ? '管理数据集' : field.property_key ?? '笔记文档'} aria-label={conditionOnly ? '管理数据集' : `编辑属性 ${label}`} className={compact
        ? 'flex h-8 min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden rounded-lg px-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:opacity-50'
        : conditionOnly
          ? 'shrink-0 rounded-md px-2.5 py-1 text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]'
        : 'multidimensional-table__cell-content multidimensional-table__header-trigger group flex min-h-9 min-w-0 items-center gap-x-1.5 text-left text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-60'}>
        {!conditionOnly && <FieldTypeIcon kind={typeIconKind(field.type)} title={typeLabel(field.type)} compact={compact} />}
        <span className={compact ? 'block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap' : 'min-w-0 break-words'}>{conditionOnly ? '数据集' : label}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align={conditionOnly ? 'end' : 'start'} side="bottom" sideOffset={0} fitViewport style={{ zIndex: conditionOnly ? 150 : 160 }} ignorePopoverOutside={typeMenuOpen || presetMenuOpen || autoCollectMenuOpen || ignoreConditionPanelOutside} ignoreSelectOutside={field.type === 'primary'} className={`max-h-[min(70vh,420px)] ${conditionOnly ? 'w-[220px] px-1 py-1 overflow-x-hidden' : 'w-[213px] px-0.5 py-2'} max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]`}>
      <div className={conditionOnly ? 'space-y-1' : 'mx-1 space-y-1'}>
        {!conditionOnly && <form className="space-y-1" onSubmit={(event) => void submitName(event)}>
          <input autoFocus value={propertyKeyDraft} disabled={field.type === 'primary' || saving} onChange={(event) => setPropertyKeyDraft(event.target.value)} aria-label="名称" placeholder="名称" className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none disabled:opacity-50" />
          <Popover open={typeMenuOpen} onOpenChange={(nextOpen) => {
            setTypeMenuOpen(nextOpen);
            if (nextOpen) setPresetMenuOpen(false);
          }}>
            <PopoverTrigger asChild>
              <button type="button" disabled={field.type === 'primary' || saving} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--hover-bg)] data-[state=open]:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50">
                <span>类型</span>
                <span className="flex min-w-0 items-center gap-0 text-[var(--muted-foreground)]">
                  <span className="truncate">{typeLabel(field.type)}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </span>
              </button>
            </PopoverTrigger>
            {field.type !== 'primary' && <PopoverContent side="left" align="start" sideOffset={0} ignoreSelectOutside={false} fitViewport style={{ zIndex: 170 }} className="max-h-[min(70vh,420px)] w-[180px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <div className="space-y-1">
                {typeChoices.map((type) => <button
                  key={type}
                  type="button"
                  disabled={saving}
                  aria-pressed={field.type === type}
                  onClick={() => changeType(type)}
                  className={`flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50 ${field.type === type ? 'bg-[var(--muted)] text-[var(--foreground)]' : ''}`}
                >
                  <FieldTypeIcon kind={typeIconKind(type)} title={typeLabel(type)} />
                  <span className="truncate">{typeLabel(type)}</span>
                </button>)}
              </div>
            </PopoverContent>}
          </Popover>
        </form>}
        {showAutoCollect && field.type === 'primary' && <Popover open={autoCollectMenuOpen} onOpenChange={setAutoCollectMenuOpen}>
          <PopoverTrigger asChild>
            <button type="button" disabled={saving} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--hover-bg)] data-[state=open]:text-[var(--foreground)] disabled:opacity-50">
              <span>数据集</span>
              <span className="flex items-center gap-0 text-sm text-[var(--muted-foreground)]">
                {autoCollectDraft.property_match === 'intersection' ? '交集' : '并集'}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" align="start" sideOffset={0} ignorePopoverOutside={folderPickerOpen} fitViewport style={{ zIndex: 160 }} className="w-[320px] max-w-[calc(100vw-16px)] rounded-xl px-1 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            <div className="space-y-1">
                <div className="min-w-0">
                  <div role="group" aria-label="属性匹配方式" className="multidimensional-table__condition-tabs mx-2 mb-1">
                    <button
                      type="button"
                      aria-pressed={(autoCollectDraft.property_match ?? 'union') === 'union'}
                      onClick={() => setAutoCollectDraft((current) => ({ ...current, property_match: 'union' }))}
                      className="multidimensional-table__condition-tab"
                    >并集</button>
                    <button
                      type="button"
                      aria-pressed={autoCollectDraft.property_match === 'intersection'}
                      onClick={() => setAutoCollectDraft((current) => ({ ...current, property_match: 'intersection' }))}
                      className="multidimensional-table__condition-tab"
                    >交集</button>
                  </div>
                  <p className="agent-thread-card__codex-settings-title px-2">{t('multidimensionalTable.autoCollect.properties')}</p>
                </div>
                {(autoCollectDraft.property_conditions ?? []).map((condition, index) => <div key={index} className="flex min-w-0 items-center gap-1 px-2">
                  <input
                    value={condition.field_id === '名称' ? '' : condition.field_id}
                    disabled={saving}
                    onChange={(event) => setAutoCollectDraft((current) => ({
                      ...current,
                      property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, field_id: event.target.value } : item),
                    }))}
                    placeholder="属性名称"
                    aria-label={`属性条件 ${index + 1} 字段`}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm outline-none disabled:opacity-50"
                  />
                  <Select value={condition.operator} disabled={saving} onValueChange={(operator) => setAutoCollectDraft((current) => ({
                    ...current,
                    property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, operator: operator as TableAutoCollectPropertyCondition['operator'] } : item),
                  }))}>
                    <SelectTrigger className="h-8 w-[82px] shrink-0 rounded-lg bg-transparent px-2 text-left text-sm">
                      <SelectValue>{t(`editor.threadCard.featuredNotes.operator.${condition.operator}` as I18nKey)}</SelectValue>
                    </SelectTrigger>
                  <SelectContent align="start" fitViewport style={{ zIndex: 170 }} className="flowix-preferences-select-content">
                    <SelectItem value="contains">{t('editor.threadCard.featuredNotes.operator.contains')}</SelectItem>
                    <SelectItem value="equals">{t('editor.threadCard.featuredNotes.operator.equals')}</SelectItem>
                  </SelectContent>
                  </Select>
                  <input
                    value={condition.value}
                    disabled={saving}
                    onChange={(event) => setAutoCollectDraft((current) => ({
                      ...current,
                      property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item),
                    }))}
                    placeholder="内容"
                    aria-label={`属性条件 ${index + 1} 匹配值`}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm outline-none disabled:opacity-50"
                  />
                  {index > 0 && <button
                    type="button"
                    disabled={saving}
                    aria-label={`删除属性条件 ${index + 1}`}
                    onClick={() => setAutoCollectDraft((current) => ({
                      ...current,
                      property_conditions: (current.property_conditions ?? []).filter((_, itemIndex) => itemIndex !== index),
                    }))}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-50"
                  ><X className="h-3.5 w-3.5" aria-hidden="true" /></button>}
                </div>)}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setAutoCollectDraft((current) => ({
                    ...current,
                    property_conditions: [...(current.property_conditions ?? []), { field_id: '', operator: 'contains', value: '' }],
                  }))}
                  className="flex h-7 items-center gap-1 rounded-lg px-2 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] disabled:opacity-50"
                ><Plus className="h-3.5 w-3.5" aria-hidden="true" />添加条件</button>
                <p className="agent-thread-card__codex-settings-title px-2">{t('multidimensionalTable.autoCollect.file')}</p>
                <div className="space-y-1">
                  <label className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
                    <span className="px-0.5 text-sm text-[var(--foreground)]">{t('multidimensionalTable.autoCollect.fileName')}</span>
                    <input
                      value={autoCollectDraft.file_condition?.file_name_contains ?? ''}
                      disabled={saving}
                      onChange={(event) => setAutoCollectDraft((current) => ({ ...current, file_condition: { file_name_contains: event.target.value, file_type: current.file_condition?.file_type ?? '', path_contains: current.file_condition?.path_contains ?? '' } }))}
                      placeholder={t('multidimensionalTable.autoCollect.fileNameContains')}
                      aria-label={t('multidimensionalTable.autoCollect.fileName')}
                      className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none disabled:opacity-50"
                    />
                  </label>
                  <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
                    <span className="px-0.5 text-sm text-[var(--foreground)]">{t('multidimensionalTable.autoCollect.fileType')}</span>
                    <Select
                      value={autoCollectDraft.file_condition?.file_type || 'any'}
                      disabled={saving}
                      onValueChange={(type) => setAutoCollectDraft((current) => ({
                        ...current,
                        file_condition: { file_name_contains: current.file_condition?.file_name_contains ?? '', file_type: type === 'any' ? '' : type as TableAutoCollectFileType, path_contains: current.file_condition?.path_contains ?? '' },
                      }))}
                    >
                      <SelectTrigger className="h-8 min-w-0 w-full rounded-lg bg-transparent px-2 text-left">
                        <SelectValue>{autoCollectDraft.file_condition?.file_type
                          ? t(`multidimensionalTable.autoCollect.type.${autoCollectDraft.file_condition.file_type}` as I18nKey)
                          : t('multidimensionalTable.autoCollect.anyFileType')}</SelectValue>
                      </SelectTrigger>
                      <SelectContent align="start" fitViewport style={{ zIndex: 170 }} className="flowix-preferences-select-content">
                        <SelectItem value="any">{t('multidimensionalTable.autoCollect.anyFileType')}</SelectItem>
                        <SelectItem value="markdown">{t('multidimensionalTable.autoCollect.type.markdown')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
                    <span className="px-0.5 text-sm text-[var(--foreground)]">{t('multidimensionalTable.autoCollect.path')}</span>
                    <Popover open={folderPickerOpen} onOpenChange={setFolderPickerOpen}>
                      <PopoverTrigger asChild>
                        <button type="button" disabled={saving || !notebookPath} className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-transparent px-2 text-left text-sm disabled:opacity-50">
                          <span className="min-w-0 truncate">{autoCollectDraft.file_condition?.path_contains || t('multidimensionalTable.autoCollect.chooseFolder')}</span>
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="bottom" align="start" sideOffset={4} style={{ zIndex: 170 }} className="max-h-[min(60vh,280px)] w-[260px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                        {folderOptionsLoading ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('multidimensionalTable.autoCollect.loadingFolders')}</p>
                          : <div className="space-y-0.5">
                            <button
                              type="button"
                              aria-pressed={!autoCollectDraft.file_condition?.path_contains}
                              onClick={() => {
                                setAutoCollectDraft((current) => ({
                                  ...current,
                                  file_condition: { file_name_contains: current.file_condition?.file_name_contains ?? '', file_type: current.file_condition?.file_type ?? '', path_contains: '' },
                                }));
                                setFolderPickerOpen(false);
                              }}
                              className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${!autoCollectDraft.file_condition?.path_contains ? 'bg-[var(--muted)]' : ''}`}
                            >
                              <span className="flex min-w-0 flex-1 items-center gap-2 pl-2">
                                <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                                <span className="min-w-0 truncate">{t('multidimensionalTable.autoCollect.anyFolder')}</span>
                              </span>
                            </button>
                            {folderOptions.length === 0 ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('multidimensionalTable.autoCollect.noFolders')}</p> : folderOptions.map((option) => {
                              const segments = option.relativePath.split('/');
                              const folderName = segments[segments.length - 1] ?? option.relativePath;
                              const selected = autoCollectDraft.file_condition?.path_contains === option.relativePath;
                              return <button
                                key={option.relativePath}
                                type="button"
                                title={option.relativePath}
                                aria-pressed={selected}
                                onClick={() => {
                                  setAutoCollectDraft((current) => ({
                                    ...current,
                                    file_condition: { file_name_contains: current.file_condition?.file_name_contains ?? '', file_type: current.file_condition?.file_type ?? '', path_contains: option.relativePath },
                                  }));
                                  setFolderPickerOpen(false);
                                }}
                                className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${selected ? 'bg-[var(--muted)]' : ''}`}
                                style={{ paddingLeft: `${8 + option.depth * 16}px` }}
                              >
                                <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                                <span className="min-w-0 truncate">{folderName}</span>
                              </button>;
                            })}
                          </div>}
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
            </div>
            {showAutoCollect && <div className="mt-2 mx-2"><button type="button" disabled={saving} className="flex h-8 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-white text-sm text-gray-900 hover:bg-gray-100 disabled:opacity-50" onClick={async () => {
              if (await onSaveAutoCollect(field, resolveAutoCollectCondition(autoCollectDraft, autoCollectFields))) closeMenu();
            }}>应用</button></div>}
          </PopoverContent>
        </Popover>}
        {conditionOnly && conditionPanelContent}
        {(field.type === 'Select' || field.type === 'MultiSelect') && <div>
          <p className="agent-thread-card__codex-settings-title px-0.5">选项</p>
          <div className="space-y-1.5">
            {optionsDraft.map((option, index) => <div key={option.id} className="flex min-w-0 items-center gap-1">
              <input
                value={option.label}
                disabled={saving}
                onChange={(event) => setOptionsDraft((current) => current.map((item) => item.id === option.id ? { ...item, label: event.target.value } : item))}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  setOptionsDraft((current) => [...current, { id: `opt_${createUuidV7()}`, label: '' }]);
                }}
                placeholder={`选项 ${index + 1}`}
                aria-label={`选项 ${index + 1}`}
                className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none disabled:opacity-50"
              />
              <button
                type="button"
                aria-label={`删除选项 ${index + 1}`}
                title="删除选项"
                disabled={saving}
                onClick={() => setOptionsDraft((current) => current.filter((item) => item.id !== option.id))}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>)}
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => setOptionsDraft((current) => [...current, { id: `opt_${createUuidV7()}`, label: '' }])}
            className="mt-1.5 flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />添加选项
          </button>
        </div>}
        {field.type !== 'primary' && <TablePresetMenu
          customPresets={customPresets}
          systemPresets={systemPresets}
          disabled={saving}
          open={presetMenuOpen}
          onOpenChange={(nextOpen) => {
            setPresetMenuOpen(nextOpen);
            if (nextOpen) setTypeMenuOpen(false);
          }}
          t={t}
          onSelect={(preset) => void selectPreset(preset)}
          onManage={managePresets}
        />}
      </div>
      {field.type !== 'primary' && <div className="mt-1 flex justify-end px-1">
        <button type="button" aria-label="删除此列" title="删除此列" disabled={saving} onClick={() => void deleteField()} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:cursor-not-allowed disabled:opacity-45">
          <TrashSimpleIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>}
    </PopoverContent>
  </Popover>;
}
