import { sortFields } from './field-order';
import { builtinTableFieldValue, builtinPresetTableField, builtinPresetValue, type BuiltinTableField } from './builtin-fields';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GripVertical, Minus, MoreHorizontal, Plus } from 'lucide-react';
import { ArrowUpRightIcon, LightningIcon, MinusCircleIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import type { NoteEntry } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { joinNotebookMemoPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { canonicalizePropertyKey } from '@features/properties/public/property-key-api';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { FlowixCheckbox } from '@shared/ui/flowix-checkbox';
import {
  ColorValueInput,
  DateValueInput,
  IconValueInput,
  ImageValueInput,
  MultiSelectValueInput,
  SelectValueInput,
} from '@features/document/public/table-property-input-api';
import { TableTagValueInput } from './table-tag-value-input';
import { TableTextValueInput } from './table-text-value-input';
import { NoteCreatePicker } from './note-create-picker';
import { ContentIcon } from '@features/content/public/content-api';
import type { TableField, TableRecord } from './model';
import type { TableCellSaveStatus } from './use-table-cell-writer';

function isWeakUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function TableBooleanInput({ value, disabled, ariaLabel, onChange }: {
  value: unknown;
  disabled: boolean;
  ariaLabel: string;
  onChange: (value: boolean) => void;
}) {
  const [checked, setChecked] = useState(Boolean(value));
  const pendingValueRef = useRef(checked);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const commit = () => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    if (disabled) return;
    if (pendingValueRef.current !== Boolean(value)) onChangeRef.current(pendingValueRef.current);
  };

  useEffect(() => {
    if (disabled) {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
      pendingValueRef.current = Boolean(value);
      setChecked(Boolean(value));
      return;
    }
    if (commitTimerRef.current) return;
    pendingValueRef.current = Boolean(value);
    setChecked(Boolean(value));
  }, [disabled, value]);

  useEffect(() => () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
  }, []);

  return <FlowixCheckbox
    aria-label={ariaLabel}
    checked={checked}
    disabled={disabled}
    onCheckedChange={(nextValue) => {
      pendingValueRef.current = nextValue;
      setChecked(nextValue);
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = setTimeout(() => {
        commit();
      }, 1000);
    }}
    onBlur={commit}
  />;
}

export function TableNumberInput({
  value: initialValue,
  disabled,
  placeholder,
  onChange,
}: {
  value: unknown;
  disabled: boolean;
  placeholder: string;
  onChange: (value: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initialValue == null || initialValue === '' ? '' : String(initialValue));
  const currentValue = initialValue == null || initialValue === '' ? null : Number(initialValue);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (disabled) return;
    if (nextOpen) {
      setDraft(currentValue == null ? '' : String(currentValue));
      setOpen(true);
      return;
    }
    const trimmed = draft.trim();
    const nextValue = trimmed === '' ? null : Number(trimmed);
    if ((nextValue === null || Number.isFinite(nextValue)) && !Object.is(nextValue, currentValue)) onChange(nextValue);
    setOpen(false);
  };

  const step = (direction: 'up' | 'down') => {
    const current = draft.trim() === '' ? 0 : Number(draft);
    if (!Number.isFinite(current)) return;
    setDraft(String(current + (direction === 'up' ? 1 : -1)));
  };

  return <Popover open={disabled ? false : open} onOpenChange={handleOpenChange} cellPopup>
    <PopoverTrigger asChild anchorToCell>
      <button
        type="button"
        disabled={disabled}
        aria-label={placeholder || '编辑数值'}
        className="multidimensional-table__text-value min-h-8 w-full min-w-0 border-0 bg-transparent px-0 py-1 text-left text-sm disabled:cursor-not-allowed"
      >
        {currentValue == null ? <span className="text-[var(--muted-foreground)] opacity-80">{placeholder}</span> : String(currentValue)}
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={4}
      className="multidimensional-table__field-editor-popover !z-[170]"
      matchAnchorWidth={1.02}
      matchAnchorHeight={1.08}
      style={{ maxWidth: 'calc(100vw - 8px)' }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" disabled={disabled} aria-label="减少数值" title="减少数值" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-transparent p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40" onMouseDown={(event) => event.preventDefault()} onClick={() => step('down')}>
          <Minus className="h-3 w-3" aria-hidden="true" />
        </button>
        <input
          autoFocus
          type="number"
          value={draft}
          disabled={disabled}
          aria-label={placeholder || '数值'}
          onChange={(event) => setDraft(event.target.value)}
          className="multidimensional-table__text-value multidimensional-table__number-input block h-8 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-1.5 py-1 text-center text-sm outline-none focus:border-0"
        />
        <button type="button" disabled={disabled} aria-label="增加数值" title="增加数值" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-transparent p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40" onMouseDown={(event) => event.preventDefault()} onClick={() => step('up')}>
          <Plus className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </PopoverContent>
  </Popover>;
}

interface TableRecordRowProps {
  record: TableRecord;
  isDropPreview?: boolean;
  canReorder?: boolean;
  isDragging?: boolean;
  showBottomBorder?: boolean;
  imagePaths: (value: unknown) => string[];
  notePropertyEditorValue: (note: NoteEntry | undefined, field: TableField) => unknown;
  fields: TableField[];
  builtinFields?: readonly BuiltinTableField[];
  fieldOrder?: readonly string[];
  allowSwitchNote?: boolean;
  titleField?: TableField;
  note?: NoteEntry;
  isRuleLinked: boolean;
  notebookPath: string | null;
  getAvailableNotes: () => NoteEntry[];
  subscribeAvailableNotes: (listener: () => void) => () => void;
  noteStatus: 'draft' | 'linked' | 'unknown' | 'missing';
  autoOpenPrimaryEditor: boolean;
  imageUrls: Record<string, string | null>;
  saving: boolean;
  cellStatuses: ReadonlyMap<string, TableCellSaveStatus>;
  rowActionOpen: boolean;
  isSelected?: boolean;
  onToggleSelected?: (recordId: string) => void;
  onRowContextMenu?: (recordId: string) => void;
  onRetryNoteLookup: () => void;
  onMissingNote: (record: TableRecord) => void;
  onReplaceNote: (recordId: string, noteKey: string) => void;
  onCreateAndLinkRecordNote: (recordId: string, title: string) => Promise<boolean>;
  onAutoOpenHandled: () => void;
  onRenameNote: (recordId: string, note: NoteEntry, title: string) => Promise<NoteEntry | null>;
  onOpenNote: (note: NoteEntry) => void;
  onDeleteNote: (note: NoteEntry) => void;
  onSelectImage: (record: TableRecord, note: NoteEntry, field: TableField) => Promise<void>;
  onUpdateCell: (record: TableRecord, note: NoteEntry | undefined, field: TableField, value: unknown) => void;
  onCreateFieldOption?: (field: TableField, label: string) => Promise<{ id: string; label: string } | null>;
  onDeleteRecord: (recordId: string) => void;
  onDeleteRow?: (recordId: string) => void;
  onRowActionOpenChange: (open: boolean, recordId: string) => void;
}

export const TableRecordRow = memo(function TableRecordRow({
  record,
  isDropPreview = false,
  canReorder = false,
  isDragging = false,
  showBottomBorder = true,
  imagePaths,
  notePropertyEditorValue,
  fields,
  builtinFields = [],
  fieldOrder,
  titleField,
  note,
  isRuleLinked,
  notebookPath,
  noteStatus,
  autoOpenPrimaryEditor,
  imageUrls,
  saving,
  cellStatuses,
  rowActionOpen,
  isSelected = false,
  onToggleSelected,
  onRowContextMenu,
  onRetryNoteLookup,
  onMissingNote,
  onCreateAndLinkRecordNote,
  onAutoOpenHandled,
  onRenameNote,
  onOpenNote,
  onDeleteNote,
  onSelectImage,
  onUpdateCell,
  onCreateFieldOption = async () => null,
  onDeleteRecord,
  onDeleteRow,
  onRowActionOpenChange,
}: TableRecordRowProps) {
  const { t } = useI18n();
  const [editingPrimary, setEditingPrimary] = useState(false);
  const [primaryTitleDraft, setPrimaryTitleDraft] = useState('');
  const [renamingPrimary, setRenamingPrimary] = useState(false);
  const [uploadingImageFieldId, setUploadingImageFieldId] = useState<string | null>(null);
  const primaryTitleInputRef = useRef<HTMLTextAreaElement>(null);
  const resizePrimaryTitleInput = useCallback((input = primaryTitleInputRef.current) => {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.5)}px`;
  }, []);
  const creatingDraftNoteRef = useRef(false);
  useLayoutEffect(() => {
    const input = primaryTitleInputRef.current;
    if (!editingPrimary || !input) return;
    resizePrimaryTitleInput(input);
  }, [editingPrimary, primaryTitleDraft, resizePrimaryTitleInput]);


  useEffect(() => {
    if (!autoOpenPrimaryEditor) return;
    setPrimaryTitleDraft('');
    setEditingPrimary(true);
    onAutoOpenHandled();
  }, [autoOpenPrimaryEditor, onAutoOpenHandled]);

  const finishPrimaryEdit = async (): Promise<NoteEntry | null> => {
    if (!note) return null;
    const nextTitle = primaryTitleDraft.trim();
    const currentTitle = displayTitleFromFilename(note.relativePath);
    setEditingPrimary(false);
    if (!nextTitle) {
      setPrimaryTitleDraft(currentTitle);
      return note;
    }
    if (nextTitle === currentTitle) return note;
    setRenamingPrimary(true);
    try {
      const renamed = await onRenameNote(record.id, note, nextTitle);
      return renamed;
    } finally {
      setRenamingPrimary(false);
    }
  };

  const createDraftPrimary = async () => {
    const title = primaryTitleDraft.trim();
    if ((noteStatus !== 'draft' && noteStatus !== 'missing') || !title || saving || creatingDraftNoteRef.current) return false;
    creatingDraftNoteRef.current = true;
    try {
      const created = await onCreateAndLinkRecordNote(record.id, title);
      if (created) {
        setEditingPrimary(false);
      }
      return created;
    } finally {
      creatingDraftNoteRef.current = false;
    }
  };

  const firstVisibleFieldId = sortFields(
    [...fields, ...builtinFields.flatMap((field) => builtinPresetTableField(field.id) ? [builtinPresetTableField(field.id)!] : [])],
    (field) => field.id,
    fieldOrder ?? [...fields.map((field) => field.id), ...builtinFields.map((field) => field.id)],
  )[0]?.id;

  const handlePrimaryEditorOpenChange = (open: boolean) => {
    if (open) {
      setPrimaryTitleDraft(note ? displayTitleFromFilename(note.relativePath) : '');
      setEditingPrimary(true);
    } else if (!open && editingPrimary) {
      if (note) void finishPrimaryEdit();
      else {
        setEditingPrimary(false);
        if (primaryTitleDraft.trim()) void createDraftPrimary();
      }
    }
  };

  return <ContextMenu>
    <ContextMenuTrigger asChild>
      <tr
        onContextMenu={() => onRowContextMenu?.(record.id)}
        data-table-record={isDropPreview ? undefined : record.id}
        data-table-reorderable-record={!isDropPreview && canReorder ? record.id : undefined}
        data-row-dragging-source={isDragging || undefined}
        data-selected={isSelected || undefined}
        aria-hidden={isDropPreview || undefined}
        inert={isDropPreview || undefined}
        className={`${isDropPreview ? 'pointer-events-none opacity-50' : ''}`}
      >
    <td className="multidimensional-table__row-control-cell">
      <div className="multidimensional-table__row-leading-controls" onClick={(event) => event.stopPropagation()}>
        {canReorder && !isDropPreview && <button
          type="button"
          disabled={saving}
          data-row-drag-handle
          aria-label={t('editor.table.reorderRow')}
          title={t('editor.table.reorderRow')}
          className="multidimensional-table__row-drag-handle"
        ><GripVertical aria-hidden="true" /></button>}
        <FlowixCheckbox
          checked={isSelected}
          aria-label={isSelected ? '取消选中行' : '选中行'}
          onCheckedChange={() => onToggleSelected?.(record.id)}
          className="multidimensional-table__row-selection-checkbox"
        />
      </div>
    </td>
    {sortFields([...[...fields, ...builtinFields.flatMap((field) => {
      const preset = builtinPresetTableField(field.id);
      return preset ? [preset] : [];
    })].map((field) => {
      if (!note && builtinPresetTableField(field.id)) return <td key={field.id} className={`${showBottomBorder ? 'border-b' : ''} border-r border-[var(--border)] p-0 align-middle`} />;
      const value = builtinPresetTableField(field.id) ? builtinPresetValue(field.id, note) : notePropertyEditorValue(note, field);
      const inputClass = 'h-8 w-full rounded-md border-0 bg-transparent px-0 text-sm outline-none placeholder:text-[var(--muted-foreground)] placeholder:opacity-80 focus:border-0 focus:bg-transparent focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50';
      const isWrappingContent = field.type === 'primary' || field.type === 'Text' || field.type === 'Tag' || field.type === 'MultiSelect';
      const cellStatus = cellStatuses.get(field.id);
      const cellDisabled = saving || Boolean(cellStatus?.saving) || noteStatus !== 'linked';
      const chooseImage = async () => {
        if (!note || cellDisabled || uploadingImageFieldId) return;
        setUploadingImageFieldId(field.id);
        try {
          await onSelectImage(record, note, field);
        } finally {
          setUploadingImageFieldId(null);
        }
      };
      const canOpenPrimaryEditorFromCell = field.type === 'primary'
        && (noteStatus === 'draft' || Boolean(note && notebookPath));
      return <td
        key={field.id}
        title={cellStatus?.error}
        className={`relative ${showBottomBorder ? 'border-b' : ''} border-r border-[var(--border)] p-0 ${field.id === firstVisibleFieldId || isWrappingContent ? 'overflow-visible align-middle' : 'h-10 max-h-10 overflow-hidden align-middle'} ${cellStatus?.error ? 'ring-1 ring-inset ring-[var(--destructive)]' : ''}`}
        onClick={canOpenPrimaryEditorFromCell ? (event) => {
          if (event.target instanceof Element && event.target.closest('.multidimensional-table__open-note')) return;
          setPrimaryTitleDraft(note ? displayTitleFromFilename(note.relativePath) : '');
          setEditingPrimary(true);
        } : undefined}
      >
        <div className={`multidimensional-table__cell-content${field.type === 'primary' ? ' multidimensional-table__primary-cell group' : ''}`}>
          {field.type === 'primary' ? (() => {
            const path = note && notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
            if (noteStatus === 'missing') return <button type="button" disabled={saving} className="multidimensional-table__primary-title multidimensional-table__primary-title--placeholder !py-1" onClick={() => onMissingNote(record)}>
              未找到笔记 {displayTitleFromFilename(record.note_path)}
            </button>;
            const canEditPrimary = Boolean((note && path) || noteStatus === 'draft');
            if (!canEditPrimary) {
              return noteStatus === 'unknown'
                ? <button
                  type="button"
                  disabled={saving}
                  title={record.note_path}
                  className="max-w-full truncate px-0 text-left text-sm text-[var(--muted-foreground)] opacity-80 hover:opacity-100 disabled:opacity-50"
                  onClick={onRetryNoteLookup}
                >无法确认关联状态，点击重试</button>
                : null;
            }
            return <>
              <Popover open={editingPrimary} onOpenChange={handlePrimaryEditorOpenChange} cellPopup>
                <PopoverTrigger asChild anchorToCell>
                  {note && path
                    ? <button type="button" disabled={saving} className="multidimensional-table__primary-title !py-1" title={displayTitleFromFilename(note.relativePath)}>
                      {isRuleLinked && !editingPrimary && <LightningIcon className="multidimensional-table__rule-link-icon" aria-hidden="true" />}
                      <ContentIcon content={{ kind: 'note' }} className="multidimensional-table__note-icon" />
                      <span>{displayTitleFromFilename(note.relativePath)}</span>
                    </button>
                    : <button type="button" disabled={saving} aria-label="创建笔记" className="multidimensional-table__primary-title multidimensional-table__primary-title--placeholder !py-1" />}
                </PopoverTrigger>
                <PopoverContent align="start" side="bottom" sideOffset={4} fitViewport matchAnchorWidth={1.02} matchAnchorHeight={1.08} className="multidimensional-table__cell-editor-popover max-w-[calc(100vw-1rem)] rounded-lg px-2 py-0 shadow-[0_0px_24px_-3px_rgb(0_0_0_/_0.12)]">
                  <NoteCreatePicker
                    value={primaryTitleDraft}
                    onChange={setPrimaryTitleDraft}
                    mode={note && path ? 'edit' : 'create'}
                    allowSelect={false}
                    showCreateButton={false}
                    disabled={renamingPrimary || saving}
                    onCreate={note && path ? finishPrimaryEdit : createDraftPrimary}
                    onCancel={() => {
                      setPrimaryTitleDraft(note && path ? displayTitleFromFilename(note.relativePath) : '');
                      setEditingPrimary(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              {note && path && <button
                type="button"
                aria-label={`打开笔记 ${note.title || note.relativePath}`}
                title="打开"
                className="multidimensional-table__open-note"
                onClick={() => onOpenNote(note)}
              >
                <ArrowUpRightIcon className="h-3.5 w-3.5" weight="bold" aria-hidden="true" />
              </button>}
            </>;
          })()
            : field.type === 'Image' ? (() => {
              const path = imagePaths(value)[0];
              return <ImageValueInput
                path={path}
                src={path ? imageUrls[`${record.id}:${field.id}:${path}`] : null}
                disabled={cellDisabled}
                uploading={uploadingImageFieldId === field.id}
                emptyLabel="Upload"
                onSelect={() => void chooseImage()}
              />;
            })()
              : field.type === 'Color' ? <ColorValueInput
                value={Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' ? value : ''}
                disabled={cellDisabled}
                variant="table"
                onChange={(next) => onUpdateCell(record, note, field, next ? next.split(',').map((item) => item.trim()).filter(Boolean) : [])}
              />
                : field.type === 'Icon' ? <IconValueInput
                  value={typeof value === 'string' ? value : ''}
                  disabled={cellDisabled}
                  variant="table"
                  onChange={(next) => onUpdateCell(record, note, field, next || null)}
                />
                  : field.type === 'Boolean' ? <TableBooleanInput value={value} disabled={cellDisabled} ariaLabel={field.name || field.property_key || field.id} onChange={(nextValue) => onUpdateCell(record, note, field, nextValue)} />
                    : field.type === 'MultiSelect' ? <MultiSelectValueInput
                      value={Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' ? value : ''}
                      options={field.options?.map((option) => ({ value: option.id, label: option.label })) ?? []}
                      disabled={cellDisabled}
                      variant="table"
                      onChange={(next) => onUpdateCell(record, note, field, next.split(',').map((item) => item.trim()).filter(Boolean))}
                      onCreateOption={async (label) => {
                        const option = await onCreateFieldOption(field, label);
                        if (option) onUpdateCell(record, note, { ...field, options: [...(field.options ?? []), option] }, option.id);
                        return null;
                      }}
                    />
                      : field.type === 'Date' ? <DateValueInput
                        value={typeof value === 'string' ? value : ''}
                        disabled={cellDisabled}
                        variant="table"
                        onChange={(next) => onUpdateCell(record, note, field, next || null)}
                      />
                        : field.type === 'Select' ? <SelectValueInput
                          value={String(value ?? '')}
                          options={field.options?.map((option) => ({ value: option.id, label: option.label })) ?? []}
                          disabled={cellDisabled}
                          variant="table"
                          onChange={(id) => onUpdateCell(record, note, field, id || null)}
                          onCreateOption={async (label) => {
                            const option = await onCreateFieldOption(field, label);
                            if (option) onUpdateCell(record, note, { ...field, options: [...(field.options ?? []), option] }, option.id);
                            return null;
                          }}
                        />
                          : field.type === 'Tag' ? <TableTagValueInput
                            value={Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : []}
                            disabled={cellDisabled}
                            isNoteTags={canonicalizePropertyKey(field.property_key ?? '') === 'tags'}
                            onChange={(next) => onUpdateCell(record, note, field, next)}
                          />
                            : field.type === 'Number' ? <TableNumberInput
                              value={value}
                              disabled={cellDisabled}
                              placeholder={field.id === titleField?.id ? '输入名称' : ''}
                              onChange={(nextValue) => onUpdateCell(record, note, field, nextValue)}
                            />
                              : field.type === 'Text' || field.type === 'URL' ? <TableTextValueInput
                                value={value == null ? '' : String(value)}
                                disabled={cellDisabled}
                                placeholder={field.id === titleField?.id ? '输入名称' : ''}
                                singleLineDisplay={field.type === 'URL'}
                                validate={field.type === 'URL' ? isWeakUrl : undefined}
                                validationMessage={field.type === 'URL' ? '请输入有效链接' : undefined}
                                onChange={(nextValue) => onUpdateCell(record, note, field, nextValue)}
                              />
                                : <input className={inputClass} type="text" disabled={cellDisabled} placeholder={field.id === titleField?.id ? '输入名称' : ''} onBlur={(event) => {
                                  if (cellDisabled) return;
                                  const nextValue = event.target.value || null;
                                  if (nextValue !== value) onUpdateCell(record, note, field, nextValue);
                                }} defaultValue={Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value)} />}
        </div>
      </td>;
    }),
    ...builtinFields.filter((field) => !builtinPresetTableField(field.id)).map((field) => {
      const value = builtinTableFieldValue(field.id, note, notebookPath);
      return <td key={field.id} className={`${showBottomBorder ? 'border-b' : ''} border-r border-[var(--border)] p-0 align-middle`}>
        <div className="multidimensional-table__cell-content">
          <span className="truncate" title={value}>{value}</span>
        </div>
      </td>;
    })], (cell) => String(cell.key), fieldOrder ?? [...fields.map((field) => field.id), ...builtinFields.map((field) => field.id)])}
    <td className={`multidimensional-table__row-action-cell px-2 text-left${showBottomBorder ? ' multidimensional-table__row-action-cell--bordered' : ''}`}>
      <Popover open={rowActionOpen} onOpenChange={(open) => onRowActionOpenChange(open, record.id)}>
        <PopoverTrigger asChild>
          <button type="button" disabled={saving} aria-label="更多行操作" title="更多行操作" className="ml-0.5 rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] disabled:opacity-40">
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" sideOffset={4} ignoreSelectOutside={false} className="w-36 rounded-xl p-1">
          <button type="button" disabled={saving || !note} onClick={() => {
            if (!note) return;
            onRowActionOpenChange(false, record.id);
            onOpenNote(note);
          }} className="flex h-7 w-full items-center justify-start rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-50">
            <ArrowUpRightIcon className="mr-2 h-4 w-4" aria-hidden="true" />打开笔记
          </button>
          <button type="button" disabled={saving || (!note && noteStatus !== 'missing')} onClick={() => {
            onRowActionOpenChange(false, record.id);
            if (note) onDeleteNote(note);
            else if (noteStatus === 'missing') onMissingNote(record);
          }} className="flex h-7 w-full items-center justify-start rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-50">
            <TrashSimpleIcon className="mr-2 h-4 w-4" aria-hidden="true" />删除笔记
          </button>
          {!record.note_path && <button type="button" disabled={saving} onClick={() => onDeleteRecord(record.id)} className="flex h-7 w-full items-center justify-start rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-50">
            <MinusCircleIcon className="mr-2 h-4 w-4" aria-hidden="true" />删除空记录
          </button>}
        </PopoverContent>
      </Popover>
    </td>
    </tr>
    </ContextMenuTrigger>
    <ContextMenuContent className="min-w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <ContextMenuItem
        disabled={saving || !note}
        onSelect={() => { if (note) onOpenNote(note); }}
        className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-sm hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
      >
        <ArrowUpRightIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t('editor.noteLink.openNote')}</span>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!onDeleteRow}
        onSelect={() => onDeleteRow?.(record.id)}
        className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-sm hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
      >
        <TrashSimpleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t('editor.table.deleteRow')}</span>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
});
