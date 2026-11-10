'use client';
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ChevronRight, Plus, X } from 'lucide-react';
import { files, type NotebookFolderOption } from '@platform/tauri/client';
import { ResourceFolderIcon } from '@features/surface/resource-file-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { CollectionDatasetMenu } from '@shared/ui/collection-dataset-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { FlowixCheckbox } from '@shared/ui/flowix-checkbox';
import { DateValueInput } from '@features/document/components/note-properties/date-value-input';
import { ColorValueInput } from '@features/document/properties/color-value-input';
import { IconValueInput } from '@features/document/properties/icon-value-input';
import { NotePropertyImageValue } from '@features/document/properties/image-value-input';
import { SelectValueInput } from '@features/document/properties/select-value-input';
import { TagValueInput } from '@features/document/properties/tag-value-input';
import type { I18nKey } from '@/lib/i18n';
import { getAllPresets, moveNameAndDescriptionPresetsToEnd } from '@features/document/properties/presets';
import { usePropertyPresets } from '@features/properties/public-api';
import { NOTE_FILTER_READONLY_FIELDS, NOTE_TITLE_FIELD_ID } from './note-filter-fields';
import { normalizeNoteFilterCondition, type NoteFilterConfig, type NoteFilterCondition, type NoteFilterPropertyCondition } from './note-filter';

import {
  findConditionFilterOption, readNoteFilterDraft, resolveNoteFilterDraft, supportsOrdering,
  type NoteFilterEditorField, type NoteFilterOption,
} from './note-filter-draft';

const EMPTY_FILTER_FIELDS: NoteFilterEditorField[] = [];
const autoCollectValueFrameClassName = 'min-w-0 flex-1 rounded-lg px-2 ring-1 ring-inset ring-[var(--border)]';

export function NoteFilterMenu({ defaultFieldId = '', fields: autoCollectFields = EMPTY_FILTER_FIELDS, config: autoCollectConfig = null, notebookId, notebookPath, fixedFolderPath, saving, t, onSave, onSavePath, open: controlledOpen, onOpenChange, children, assetFilter, ignoreOutside = false, filterOnly = false, embedded = false, folderLabel, folderPickerTitle, folderIcon, filterIcon, filterLabel, filterOpen, onFilterOpenChange }: {
  defaultFieldId?: string;
  fields?: NoteFilterEditorField[];
  config?: NoteFilterConfig | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  /** A folder collection is always scoped to its containing folder. */
  fixedFolderPath?: string;
  saving: boolean;
  t: (key: I18nKey) => string;
  onSave: (condition: NoteFilterCondition) => Promise<boolean>;
  onSavePath?: (path: string | null) => Promise<boolean>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  assetFilter?: ReactNode;
  ignoreOutside?: boolean;
  filterOnly?: boolean;
  /** Render the existing data-condition row, supplied menu items, then location row inside another menu. */
  embedded?: boolean;
  folderLabel?: string;
  folderPickerTitle?: string;
  folderIcon?: ReactNode;
  filterIcon?: ReactNode;
  filterLabel?: string;
  filterOpen?: boolean;
  onFilterOpenChange?: (open: boolean) => void;
}) {
  const { fields: presetFields } = usePropertyPresets();
  const presets = useMemo(() => getAllPresets(presetFields, (key) => t(key)), [presetFields, t]);
  const propertyOptionGroups = useMemo(() => {
    const choicesForPreset = (preset: (typeof presets)[number]) => {
      const configured = presetFields.find((field) => field.key === preset.key)?.options;
      return configured?.map((option) => ({ value: option.id, label: option.label }))
        ?? preset.options?.map((label) => ({ value: label, label }));
    };
    const presetOptions = presets.map((preset) => ({
      source: preset.source,
      option: { value: preset.key, label: preset.label, type: preset.kind, options: choicesForPreset(preset) },
    }));
    const system = moveNameAndDescriptionPresetsToEnd(
      presetOptions.filter(({ source }) => source === 'builtin').map(({ option }) => option),
      (option) => option.value,
    );
    const mine = presetOptions.filter(({ source }) => source === 'custom').map(({ option }) => option);
    for (const field of autoCollectFields) {
      if (!field.type || field.type === 'primary' || !field.propertyKey) continue;
      const existingPreset = presetOptions.find(({ option }) => option.value === field.propertyKey)?.option;
      if (existingPreset) {
        existingPreset.type = field.type;
        if (field.options?.length) existingPreset.options = field.options.map((option) => ({ value: option.id, label: option.label }));
        continue;
      }
      mine.push({ value: field.propertyKey, label: field.label, type: field.type, options: field.options?.map((option) => ({ value: option.id, label: option.label })) });
    }
    const readOnly: NoteFilterOption[] = [{
      value: NOTE_TITLE_FIELD_ID,
      label: t('multidimensionalTable.autoCollect.title'),
      type: 'Text',
    }];
    readOnly.push(...NOTE_FILTER_READONLY_FIELDS.map((field) => ({
      value: field.id,
      label: field.label,
      type: field.type,
    })));
    return [
      { label: t('multidimensionalTable.autoCollect.readOnly'), options: readOnly },
      { label: t('preferences.documentProperties.group.presets'), options: system },
      { label: t('preferences.documentProperties.group.mine'), options: mine },
    ];
  }, [autoCollectFields, presetFields, presets, t]);
  const propertyOptions = useMemo(() => propertyOptionGroups.flatMap((group) => group.options), [propertyOptionGroups]);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const [autoCollectDraft, setAutoCollectDraft] = useState(() => readNoteFilterDraft(defaultFieldId, autoCollectFields, autoCollectConfig, propertyOptions));
  const [localAutoCollectMenuOpen, setLocalAutoCollectMenuOpen] = useState(false);
  const autoCollectMenuOpen = filterOpen ?? localAutoCollectMenuOpen;
  const wasFilterOpen = useRef(autoCollectMenuOpen);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const [openValuePickerIds, setOpenValuePickerIds] = useState<Set<number>>(() => new Set());
  const [folderOptions, setFolderOptions] = useState<NotebookFolderOption[]>([]);
  const [folderOptionsLoading, setFolderOptionsLoading] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const draftOpen = filterOnly ? autoCollectMenuOpen : open;
  const resolvedFolderLabel = folderLabel ?? t('multidimensionalTable.autoCollect.browseAndSave');
  const resolvedFolderPickerTitle = folderPickerTitle ?? t('multidimensionalTable.autoCollect.browseLocation');
  const folderPathLabel = fixedFolderPath !== undefined
    ? fixedFolderPath || '笔记本根目录'
    : autoCollectDraft.path === ''
      ? t('multidimensionalTable.autoCollect.anyFolder')
      : autoCollectDraft.path ?? '空';
  const canClearFolderPath = fixedFolderPath === undefined
    && autoCollectDraft.path !== null && autoCollectDraft.path !== undefined;
  const notebook = notebookId && notebookPath ? { id: notebookId, path: notebookPath } : undefined;
  const setValuePickerOpen = (conditionIndex: number, nextOpen: boolean) => {
    setOpenValuePickerIds((current) => {
      if (current.has(conditionIndex) === nextOpen) return current;
      const next = new Set(current);
      if (nextOpen) next.add(conditionIndex);
      else next.delete(conditionIndex);
      return next;
    });
  };
  useEffect(() => {
    if (fixedFolderPath !== undefined) setFolderPickerOpen(false);
  }, [fixedFolderPath]);
  const wasOpen = useRef(draftOpen);
  const changeOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const closeMenu = () => {
    changeOpen(false);
    if (filterOpen === undefined) setLocalAutoCollectMenuOpen(false);
    onFilterOpenChange?.(false);
  };
  const cancelHoverClose = () => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  };
  const scheduleHoverClose = (close: () => void) => {
    if (!embedded) return;
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      close();
    }, 160);
  };
  const handleHoverLeave = (event: ReactMouseEvent<HTMLDivElement>, close: () => void) => {
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-flowix-menu-child]')) return;
    scheduleHoverClose(close);
  };
  const changeFilterOpen = (next: boolean) => {
    if (next) setFolderPickerOpen(false);
    else setOpenValuePickerIds((current) => current.size ? new Set() : current);
    if (filterOpen === undefined) setLocalAutoCollectMenuOpen(next);
    onFilterOpenChange?.(next);
  };
  const changeFolderPickerOpen = (next: boolean) => {
    if (next) changeFilterOpen(false);
    setFolderPickerOpen(next);
  };
  const openFolderPickerOnHover = () => {
    if (!embedded || saving || !notebookPath || fixedFolderPath !== undefined) return;
    cancelHoverClose();
    changeFolderPickerOpen(true);
  };
  const openFilterOnHover = () => {
    if (!embedded || saving) return;
    cancelHoverClose();
    changeFilterOpen(true);
  };
  useEffect(() => () => {
    if (hoverCloseTimerRef.current !== null) window.clearTimeout(hoverCloseTimerRef.current);
  }, []);
  const savePathImmediately = async (path: string | null) => {
    const withPath = (condition: NoteFilterCondition): NoteFilterCondition => ({
      ...condition,
      path: path === null ? '' : path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || null,
    });
    const nextDraft = withPath(autoCollectDraft);
    if (onSavePath && !(await onSavePath(path))) return false;
    setAutoCollectDraft(nextDraft);
    return true;
  };
  useEffect(() => {
    if (wasOpen.current === draftOpen) return;
    wasOpen.current = draftOpen;
    if (!filterOnly && filterOpen === undefined) setLocalAutoCollectMenuOpen(false);
    setFolderPickerOpen(false);
    setOpenValuePickerIds((current) => current.size ? new Set() : current);
    if (draftOpen) {
      const draft = readNoteFilterDraft(defaultFieldId, autoCollectFields, autoCollectConfig, propertyOptions);
      setAutoCollectDraft(draft);
    }
  }, [draftOpen, defaultFieldId, autoCollectFields, autoCollectConfig, propertyOptions, filterOnly, filterOpen]);
  useEffect(() => {
    if (wasFilterOpen.current === autoCollectMenuOpen) return;
    wasFilterOpen.current = autoCollectMenuOpen;
    // The standalone filter already uses its own open state as draftOpen.
    if (filterOnly) return;
    const saved = readNoteFilterDraft(defaultFieldId, autoCollectFields, autoCollectConfig, propertyOptions);
    setAutoCollectDraft((current) => ({ ...saved, path: current.path }));
    setOpenValuePickerIds((current) => current.size ? new Set() : current);
  }, [autoCollectMenuOpen, filterOnly, defaultFieldId, autoCollectFields, autoCollectConfig, propertyOptions]);
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
  useEffect(() => {
    if (!folderPickerOpen) return;
    setCollapsedFolders(new Set(folderOptions
      .filter((option) => folderOptions.some((candidate) => candidate.relativePath.startsWith(`${option.relativePath}/`)))
      .map((option) => option.relativePath)));
  }, [folderPickerOpen, folderOptions]);

  const folderPathRow = <Popover open={folderPickerOpen} onOpenChange={changeFolderPickerOpen}>
    <div
      data-table-dataset-location-menu
      data-state={folderPickerOpen ? 'open' : 'closed'}
      onMouseEnter={openFolderPickerOnHover}
      onMouseLeave={(event) => handleHoverLeave(event, () => changeFolderPickerOpen(false))}
      /* 行外观与「标签」item 同规范：h-7 + pl-[6px] pr-2，hover/open 都用中性 hover-bg。 */
      className={`group flex h-7 min-w-0 items-center gap-0 rounded-lg py-0 pl-[6px] pr-2 transition-colors ${saving || !notebookPath || fixedFolderPath !== undefined ? '' : 'hover:bg-[var(--hover-bg)] data-[state=open]:bg-[var(--hover-bg)]'}`}
    >
      <PopoverTrigger asChild>
        <button type="button" disabled={saving || !notebookPath || fixedFolderPath !== undefined} className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 text-left text-sm disabled:opacity-50">
          <span className="flex min-w-0 items-center gap-2">{folderIcon}<span className="truncate">{resolvedFolderLabel}</span></span>
          <span className="flex min-w-0 flex-1 items-center justify-end text-[var(--muted-foreground)]">
            {folderPathLabel && <span title={fixedFolderPath !== undefined ? `固定：${folderPathLabel}` : folderPathLabel} className="max-w-[150px] truncate text-right text-xs">{folderPathLabel}</span>}
          </span>
        </button>
      </PopoverTrigger>
      {canClearFolderPath && <button
        type="button"
        disabled={saving}
        aria-label="清空路径"
        title="清空路径"
        onClick={(event) => {
          event.stopPropagation();
          void savePathImmediately('');
        }}
        className="inline-flex h-6 w-4 shrink-0 items-center justify-center rounded-md pl-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:opacity-50"
      ><X className="h-3 w-3" aria-hidden="true" /></button>}
      <PopoverTrigger asChild>
        <button type="button" aria-label={resolvedFolderLabel} disabled={saving || !notebookPath || fixedFolderPath !== undefined} className="inline-flex h-6 w-5 shrink-0 items-center justify-center text-[var(--muted-foreground)] disabled:opacity-50">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
    </div>
      <PopoverContent
        anchorSelector="[data-table-dataset-location-menu]"
        side="left"
        align="start"
        sideOffset={0}
        keepParentMenuOpen={embedded}
        onMouseEnter={cancelHoverClose}
        onMouseLeave={(event) => handleHoverLeave(event, () => changeFolderPickerOpen(false))}
        style={{ zIndex: 170 }}
        className="max-h-[min(60vh,280px)] w-[260px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      >
        <div className="mention-note-header">{resolvedFolderPickerTitle}</div>
        <OverlayScrollbar className="mention-note-items-frame max-h-[calc(min(60vh,280px)_-_36px)]" scrollerClassName="mention-note-items max-h-[calc(min(60vh,280px)_-_36px)] overflow-y-auto overflow-x-hidden">
          {folderOptionsLoading ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('multidimensionalTable.autoCollect.loadingFolders')}</p>
            : <div className="space-y-0.5">
                <button
                  type="button"
                  aria-pressed={autoCollectDraft.path === ''}
                  onClick={async () => {
                    if (await savePathImmediately(null)) setFolderPickerOpen(false);
                  }}
                  className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${autoCollectDraft.path === '' ? 'bg-[var(--muted)]' : ''}`}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 pl-2">
                    <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                    <span className="min-w-0 truncate">{t('multidimensionalTable.autoCollect.anyFolder')}</span>
                  </span>
                </button>
                {folderOptions.length === 0 ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('multidimensionalTable.autoCollect.noFolders')}</p> : folderOptions.filter((option) => {
                  const segments = option.relativePath.split('/');
                  return !segments.slice(0, -1).some((_, index) => collapsedFolders.has(segments.slice(0, index + 1).join('/')));
                }).map((option) => {
                  const segments = option.relativePath.split('/');
                  const folderName = segments[segments.length - 1] ?? option.relativePath;
                  const selected = autoCollectDraft.path === option.relativePath;
                  const hasChildren = folderOptions.some((candidate) => candidate.relativePath.startsWith(`${option.relativePath}/`));
                  const collapsed = collapsedFolders.has(option.relativePath);
                  return <div key={option.relativePath} className={`flex h-8 min-w-0 items-center rounded-lg pr-2 text-sm hover:bg-[var(--muted)] ${selected ? 'bg-[var(--muted)]' : ''}`} style={{ paddingLeft: `${8 + option.depth * 12}px` }}>
                    {hasChildren ? <button
                      type="button"
                      aria-label={`${collapsed ? '展开' : '折叠'}文件夹 ${folderName}`}
                      aria-expanded={!collapsed}
                      onClick={() => setCollapsedFolders((current) => {
                        const next = new Set(current);
                        if (next.has(option.relativePath)) next.delete(option.relativePath);
                        else next.add(option.relativePath);
                        return next;
                      })}
                      className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    ><ChevronRight className={`h-3.5 w-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden="true" /></button>
                      : <span className="w-5 shrink-0" aria-hidden="true" />}
                    <button
                      type="button"
                      title={option.relativePath}
                      aria-pressed={selected}
                      onClick={async () => {
                        if (await savePathImmediately(option.relativePath)) setFolderPickerOpen(false);
                      }}
                      className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg text-left"
                    >
                      <ResourceFolderIcon expanded={!collapsed && hasChildren} className="h-[18px] w-[18px] shrink-0" />
                      <span className="min-w-0 truncate">{folderName}</span>
                    </button>
                  </div>;
                })}
              </div>}
        </OverlayScrollbar>
      </PopoverContent>
    </Popover>;

  const dataSelectionConfigured = Boolean(
    autoCollectDraft.property_conditions?.some((condition) => condition.field_id.trim() && condition.value.trim()),
  );
  const propertyMatchAll = (autoCollectDraft.match ?? 'all') === 'all';
  const hasMultiplePropertyConditions = (autoCollectDraft.property_conditions ?? [])
    .filter((condition) => condition.field_id.trim()).length > 1;
  const resetDataSelection = () => setAutoCollectDraft((current) => {
    const reset = readNoteFilterDraft(defaultFieldId, autoCollectFields, null, propertyOptions);
    return {
      ...reset,
      path: current.path,
    };
  });
  const filterMenu = <div
    onMouseEnter={openFilterOnHover}
    onMouseLeave={(event) => handleHoverLeave(event, () => changeFilterOpen(false))}
  >
        <Popover open={autoCollectMenuOpen} onOpenChange={changeFilterOpen}>
          <PopoverTrigger asChild>
            <button type="button" disabled={saving} className="group flex h-7 w-full items-center justify-between rounded-lg py-0 pl-[6px] pr-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] data-[state=open]:bg-[var(--hover-bg)] hover:text-[var(--foreground)] data-[state=open]:text-[var(--foreground)] disabled:opacity-50">
              <span className="flex min-w-0 items-center gap-2">{filterIcon}<span className="truncate">{filterLabel ?? t('multidimensionalTable.autoCollect.dataConditions')}</span></span>
              <span className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                {dataSelectionConfigured ? '已设置' : '未设置'}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="start"
            sideOffset={0}
            ignorePopoverOutside={folderPickerOpen || openValuePickerIds.size > 0}
            keepParentMenuOpen={embedded}
            onMouseEnter={cancelHoverClose}
            onMouseLeave={(event) => handleHoverLeave(event, () => changeFilterOpen(false))}
            fitViewport
            style={{ zIndex: 160 }}
            className="w-[360px] max-w-[calc(100vw-16px)] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
          >
            <div className="space-y-2">
              <div className="space-y-1 pb-2">
                <div className="space-y-1">
                  <div className="mention-note-header">{t('multidimensionalTable.autoCollect.properties')}</div>
                </div>
                {(autoCollectDraft.property_conditions ?? []).map((condition, index) => {
                  const selectedOption = findConditionFilterOption(condition.field_id, autoCollectFields, propertyOptions);
                  const conditionValueOptions = selectedOption?.options ?? [];
                  const canOrder = supportsOrdering(selectedOption?.type);
                  const showValueSelect = selectedOption?.type === 'Select'
                    || selectedOption?.type === 'MultiSelect';
                  const updateConditionValue = (value: string) => setAutoCollectDraft((current) => ({
                    ...current,
                    property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, value } : item),
                  }));
                  return <div key={index} className="flex min-w-0 items-center gap-1">
                    <div className="w-[100px] shrink-0">
                      <Select value={selectedOption?.value ?? condition.field_id} disabled={saving} onValueChange={(fieldId) => {
                        setValuePickerOpen(index, false);
                        const selectedFieldType = propertyOptions.find((option) => option.value === fieldId)?.type;
                        setAutoCollectDraft((current) => ({
                          ...current,
                          property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index
                            ? item.field_id === fieldId ? item : {
                              ...item,
                              field_id: fieldId,
                              operator: fieldId === defaultFieldId || fieldId === NOTE_TITLE_FIELD_ID ? 'contains' as const : 'equals' as const,
                              value: selectedFieldType === 'Boolean' ? 'false' : '',
                            }
                            : item),
                        }));
                      }}>
                        <SelectTrigger aria-label={`属性条件 ${index + 1} 字段`} className="h-8 w-full min-w-0 rounded-lg bg-transparent px-2 text-left text-sm">
                          <SelectValue placeholder={t('multidimensionalTable.autoCollect.selectProperty')}>
                            <span className="min-w-0 flex-1 truncate">{(selectedOption?.label ?? condition.field_id) || t('multidimensionalTable.autoCollect.selectProperty')}</span>
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent align="start" keepParentMenuOpen={embedded} fitViewport maxHeight="33vh" style={{ zIndex: 170 }} className="flowix-preferences-select-content w-[180px] !min-w-[180px]">
                          {propertyOptionGroups.map((group) => group.options.length > 0 && <div key={group.label} role="group" aria-label={group.label}>
                            <p className="agent-thread-card__codex-settings-title px-2">{group.label}</p>
                            {group.options.map((option) => <SelectItem key={`${group.label}:${option.value}`} value={option.value}>{option.label}</SelectItem>)}
                          </div>)}
                        </SelectContent>
                      </Select>
                    </div>
                    {selectedOption?.type !== 'Boolean' && <Select value={condition.operator} disabled={saving} onValueChange={(operator) => setAutoCollectDraft((current) => ({
                      ...current,
                      property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, operator: operator as NoteFilterPropertyCondition['operator'] } : item),
                    }))}>
                      <SelectTrigger className="h-8 w-[100px] shrink-0 rounded-lg bg-transparent px-2 text-left text-sm">
                        <SelectValue>{condition.operator === 'gt'
                          ? t('multidimensionalTable.autoCollect.operator.gt')
                          : condition.operator === 'lt'
                            ? t('multidimensionalTable.autoCollect.operator.lt')
                            : t(`editor.threadCard.featuredNotes.operator.${condition.operator}` as I18nKey)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent align="start" keepParentMenuOpen={embedded} fitViewport style={{ zIndex: 170 }} className="flowix-preferences-select-content">
                        <SelectItem value="equals">{t('editor.threadCard.featuredNotes.operator.equals')}</SelectItem>
                        <SelectItem value="contains">{t('editor.threadCard.featuredNotes.operator.contains')}</SelectItem>
                        {canOrder && <>
                          <SelectItem value="gt">{t('multidimensionalTable.autoCollect.operator.gt')}</SelectItem>
                          <SelectItem value="lt">{t('multidimensionalTable.autoCollect.operator.lt')}</SelectItem>
                        </>}
                      </SelectContent>
                    </Select>}
                    {selectedOption?.type === 'Boolean' ? <div className={`${autoCollectValueFrameClassName} flex h-8 items-center gap-2`}>
                      <FlowixCheckbox
                        checked={condition.value === 'true'}
                        disabled={saving}
                        aria-label={`${selectedOption.label}: ${condition.value === 'true' ? t('multidimensionalTable.autoCollect.boolean.true') : t('multidimensionalTable.autoCollect.boolean.false')}`}
                        onCheckedChange={(checked) => setAutoCollectDraft((current) => ({
                          ...current,
                          property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index
                            ? { ...item, operator: 'equals' as const, value: String(checked) }
                            : item),
                        }))}
                      />
                      <span className="text-sm text-[var(--foreground)]">{condition.value === 'true' ? t('multidimensionalTable.autoCollect.boolean.true') : t('multidimensionalTable.autoCollect.boolean.false')}</span>
                    </div> : selectedOption?.type === 'Date' ? <div className={autoCollectValueFrameClassName}><DateValueInput
                      value={condition.value}
                      disabled={saving}
                      variant="table"
                      keepParentMenuOpen={embedded}
                      onOpenChange={(isOpen) => setValuePickerOpen(index, isOpen)}
                      onChange={updateConditionValue}
                    /></div> : showValueSelect ? <div className="min-w-0 flex-1"><SelectValueInput
                      value={condition.value}
                      options={conditionValueOptions}
                      disabled={saving}
                      variant="table"
                      placeholder={t('document.properties.select.placeholder')}
                      outlined
                      keepParentMenuOpen={embedded}
                      onChange={updateConditionValue}
                    /></div> : selectedOption?.type === 'Tag' ? <div className={autoCollectValueFrameClassName}><TagValueInput
                      value={condition.value ? [condition.value] : []}
                      disabled={saving}
                      isNoteTags={selectedOption.value === 'tags'}
                      singleValue
                      keepParentMenuOpen={embedded}
                      onOpenChange={(isOpen) => setValuePickerOpen(index, isOpen)}
                      onChange={(values) => updateConditionValue(values[0] ?? '')}
                    /></div> : selectedOption?.type === 'Color' ? <div className={autoCollectValueFrameClassName}><ColorValueInput
                      value={condition.value}
                      disabled={saving}
                      variant="table"
                      singleSelection
                      keepParentMenuOpen={embedded}
                      onOpenChange={(isOpen) => setValuePickerOpen(index, isOpen)}
                      onChange={updateConditionValue}
                    /></div> : selectedOption?.type === 'Icon' ? <div className={autoCollectValueFrameClassName}><IconValueInput
                      value={condition.value}
                      disabled={saving}
                      variant="table"
                      keepParentMenuOpen={embedded}
                      onOpenChange={(isOpen) => setValuePickerOpen(index, isOpen)}
                      onChange={updateConditionValue}
                    /></div> : selectedOption?.type === 'Image' && notebook ? <div className={autoCollectValueFrameClassName}><NotePropertyImageValue
                      value={condition.value}
                      notebook={notebook}
                      disabled={saving}
                      onChange={updateConditionValue}
                    /></div> : <input
                      value={condition.value}
                      disabled={saving}
                      type={selectedOption?.type === 'Number' ? 'number' : selectedOption?.type === 'URL' ? 'url' : 'text'}
                      step={selectedOption?.type === 'Number' ? 'any' : undefined}
                      onChange={(event) => updateConditionValue(event.target.value)}
                      placeholder="内容"
                      aria-label={`属性条件 ${index + 1} 匹配值`}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm outline-none disabled:opacity-50"
                    />}
                    <button
                      type="button"
                      disabled={saving || index === 0}
                      aria-label={`删除属性条件 ${index + 1}`}
                      onClick={() => setAutoCollectDraft((current) => ({
                        ...current,
                        property_conditions: (current.property_conditions ?? []).filter((_, itemIndex) => itemIndex !== index),
                      }))}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-50"
                    ><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  </div>;
                })}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setAutoCollectDraft((current) => ({
                    ...current,
                    property_conditions: [...(current.property_conditions ?? []), { field_id: '', operator: 'equals', value: '' }],
                  }))}
                  className="flex h-7 items-center gap-1 rounded-lg px-1.5 text-left text-sm text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] disabled:opacity-50"
                ><Plus className="h-3.5 w-3.5" aria-hidden="true" /></button>
              </div>
              {hasMultiplePropertyConditions && (
                <div role="group" aria-label="属性匹配方式" className="!mt-0 flex items-center justify-start gap-3">
                  {(['all', 'any'] as const).map((match) => {
                    const checked = propertyMatchAll === (match === 'all');
                    const label = match === 'all' ? '同时满足' : '任意其一';
                    return (
                      <button
                        key={match}
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={label}
                        disabled={saving}
                        onClick={() => setAutoCollectDraft((current) => ({ ...current, match }))}
                        className="inline-flex h-7 items-center gap-2 rounded-md px-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <FlowixCheckbox interactive={false} checked={checked} />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" disabled={saving} className="flex h-8 min-w-0 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--inverse-background)] px-2 text-sm text-[var(--inverse-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" onClick={async () => {
                  if (await onSave(normalizeNoteFilterCondition(resolveNoteFilterDraft(autoCollectDraft, autoCollectFields)))) closeMenu();
                }}>应用</button>
                <button type="button" disabled={saving} className="flex h-8 min-w-0 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50" onClick={resetDataSelection}>{t('multidimensionalTable.autoCollect.reset')}</button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
  </div>;
  if (filterOnly) return filterMenu;
  if (embedded) return <div className="space-y-0.5">{filterMenu}{children}{folderPathRow}</div>;
  return <CollectionDatasetMenu open={open} onOpenChange={changeOpen} disabled={saving}
    ignoreOutside={autoCollectMenuOpen || folderPickerOpen || ignoreOutside}
    location={folderPathRow} noteFilter={filterMenu} assetFilter={assetFilter}>
    {children}
  </CollectionDatasetMenu>;
}
