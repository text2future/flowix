import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronUp, FileText, ImagePlus, MoreHorizontal, Plus } from 'lucide-react';
import { ArrowUpRightIcon, ArrowsLeftRightIcon, LightningIcon, MinusCircleIcon } from '@phosphor-icons/react';
import type { NoteEntry } from '@platform/tauri/client';
import { joinNotebookMemoPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { useI18n } from '@/lib/i18n';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { DateValueInput } from '@features/document/components/note-properties/date-value-input';
import { ColorValueInput } from '@features/document/properties/color-value-input';
import { IconValueInput } from '@features/document/properties/icon-value-input';
import { MultiSelectValueInput } from '@features/document/properties/multi-select-value-input';
import { SelectValueInput } from '@features/document/properties/select-value-input';
import { TableTagValueInput } from './table-tag-value-input';
import { TableTextValueInput } from './table-text-value-input';
import type { TableField, TableRecord } from './model';
import type { TableCellSaveStatus } from './use-table-cell-writer';

const EMPTY_AVAILABLE_NOTES: NoteEntry[] = [];

function TableBooleanInput({ value, disabled, onChange }: {
  value: unknown;
  disabled: boolean;
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

  return <input
    type="checkbox"
    className="h-4 w-4 accent-[var(--brand)]"
    checked={checked}
    disabled={disabled}
    onChange={(event) => {
      const nextValue = event.target.checked;
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

function TableNumberInput({
  value: initialValue,
  disabled,
  placeholder,
  className,
  onChange,
}: {
  value: unknown;
  disabled: boolean;
  placeholder: string;
  className: string;
  onChange: (value: number | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const stepCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = () => {
    if (stepCommitTimerRef.current) {
      clearTimeout(stepCommitTimerRef.current);
      stepCommitTimerRef.current = null;
    }
    if (disabled) return;
    const rawValue = inputRef.current?.value ?? '';
    const nextValue = rawValue === '' ? null : Number(rawValue);
    const currentValue = initialValue == null || initialValue === '' ? null : Number(initialValue);
    if (Object.is(nextValue, currentValue)) return;
    onChange(nextValue);
  };
  const step = (direction: 'up' | 'down') => {
    if (disabled) return;
    const input = inputRef.current;
    if (!input) return;
    if (direction === 'up') input.stepUp();
    else input.stepDown();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (stepCommitTimerRef.current) clearTimeout(stepCommitTimerRef.current);
    stepCommitTimerRef.current = setTimeout(() => {
      stepCommitTimerRef.current = null;
      commit();
    }, 1000);
  };

  useEffect(() => () => {
    if (stepCommitTimerRef.current) clearTimeout(stepCommitTimerRef.current);
  }, []);

  return <div className="relative flex min-w-0 items-center">
    <input
      ref={inputRef}
      type="number"
      className={`${className} multidimensional-table__number-input pr-6 disabled:cursor-not-allowed disabled:opacity-50`}
      disabled={disabled}
      placeholder={placeholder}
      defaultValue={initialValue == null ? '' : String(initialValue)}
      onBlur={commit}
    />
    <span className="absolute right-0 flex flex-col items-center">
      <button type="button" disabled={disabled} aria-label="增加数值" title="增加数值" className="flex h-3 w-6 items-center justify-center bg-transparent p-0 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40" onMouseDown={(event) => event.preventDefault()} onClick={() => step('up')}>
        <ChevronUp className="h-3 w-3" aria-hidden="true" />
      </button>
      <button type="button" disabled={disabled} aria-label="减少数值" title="减少数值" className="flex h-3 w-6 items-center justify-center bg-transparent p-0 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40" onMouseDown={(event) => event.preventDefault()} onClick={() => step('down')}>
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  </div>;
}

interface TableRecordRowProps {
  record: TableRecord;
  showBottomBorder?: boolean;
  imagePaths: (value: unknown) => string[];
  fieldColumnWidth: (type: TableField['type']) => string;
  notePropertyEditorValue: (note: NoteEntry | undefined, field: TableField) => unknown;
  fields: TableField[];
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
  onOpenNotePicker: (anchorRect: DOMRect, recordId: string | null) => void;
  onRetryNoteLookup: () => void;
  onReplaceNote: (recordId: string, noteKey: string) => void;
  onCreateAndLinkRecordNote: (recordId: string, title: string) => Promise<boolean>;
  onAutoOpenHandled: () => void;
  onRenameNote: (recordId: string, note: NoteEntry, title: string) => Promise<NoteEntry | null>;
  onOpenNote: (note: NoteEntry) => void;
  onSelectImage: (record: TableRecord, note: NoteEntry, field: TableField) => Promise<void>;
  onUpdateCell: (record: TableRecord, note: NoteEntry | undefined, field: TableField, value: unknown) => void;
  onDeleteRecord: (recordId: string) => void;
  onRowActionOpenChange: (open: boolean, recordId: string) => void;
}

export const TableRecordRow = memo(function TableRecordRow({
  record,
  showBottomBorder = true,
  imagePaths,
  fieldColumnWidth,
  notePropertyEditorValue,
  fields,
  titleField,
  note,
  isRuleLinked,
  notebookPath,
  getAvailableNotes,
  subscribeAvailableNotes,
  noteStatus,
  autoOpenPrimaryEditor,
  imageUrls,
  saving,
  cellStatuses,
  rowActionOpen,
  onOpenNotePicker,
  onRetryNoteLookup,
  onReplaceNote,
  onCreateAndLinkRecordNote,
  onAutoOpenHandled,
  onRenameNote,
  onOpenNote,
  onSelectImage,
  onUpdateCell,
  onDeleteRecord,
  onRowActionOpenChange,
}: TableRecordRowProps) {
  const { t } = useI18n();
  const [editingPrimary, setEditingPrimary] = useState(false);
  const [primaryTitleDraft, setPrimaryTitleDraft] = useState('');
  const primaryTitleInput = useComposingValue(primaryTitleDraft, setPrimaryTitleDraft);
  const [renamingPrimary, setRenamingPrimary] = useState(false);
  const [switchNoteOpen, setSwitchNoteOpen] = useState(false);
  const [switchNoteSearch, setSwitchNoteSearch] = useState('');
  const [uploadingImageFieldId, setUploadingImageFieldId] = useState<string | null>(null);
  const primaryTitleInputRef = useRef<HTMLTextAreaElement>(null);
  const creatingDraftNoteRef = useRef(false);
  const cancelDraftEditRef = useRef(false);
  const subscribeToAvailableNotes = useCallback((listener: () => void) => (
    switchNoteOpen ? subscribeAvailableNotes(listener) : () => {}
  ), [subscribeAvailableNotes, switchNoteOpen]);
  const getAvailableNotesSnapshot = useCallback(() => (
    switchNoteOpen ? getAvailableNotes() : EMPTY_AVAILABLE_NOTES
  ), [getAvailableNotes, switchNoteOpen]);
  const availableNotes = useSyncExternalStore(
    subscribeToAvailableNotes,
    getAvailableNotesSnapshot,
    getAvailableNotesSnapshot,
  );
  const filteredAvailableNotes = availableNotes.filter((availableNote) => {
    const query = switchNoteSearch.trim().toLocaleLowerCase();
    return !query || `${availableNote.title ?? ''} ${availableNote.relativePath}`.toLocaleLowerCase().includes(query);
  });

  useEffect(() => {
    const input = primaryTitleInputRef.current;
    if (!editingPrimary || !input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.5)}px`;
  }, [editingPrimary, primaryTitleDraft]);

  useEffect(() => {
    if (!autoOpenPrimaryEditor) return;
    cancelDraftEditRef.current = false;
    setPrimaryTitleDraft('');
    setEditingPrimary(true);
    setSwitchNoteOpen(true);
    onAutoOpenHandled();
  }, [autoOpenPrimaryEditor, onAutoOpenHandled]);

  const finishPrimaryEdit = async (keepOpen = false): Promise<NoteEntry | null> => {
    if (!note) return null;
    const nextTitle = primaryTitleDraft.trim();
    const currentTitle = displayTitleFromFilename(note.relativePath);
    if (!keepOpen) setEditingPrimary(false);
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
    if (noteStatus !== 'draft' || !title || saving || creatingDraftNoteRef.current) return false;
    creatingDraftNoteRef.current = true;
    try {
      const created = await onCreateAndLinkRecordNote(record.id, title);
      if (created) {
        setEditingPrimary(false);
        setSwitchNoteOpen(false);
      }
      return created;
    } finally {
      creatingDraftNoteRef.current = false;
    }
  };

  const handlePrimaryEditorOpenChange = (open: boolean) => {
    if (open) {
      cancelDraftEditRef.current = false;
      setPrimaryTitleDraft(note ? displayTitleFromFilename(note.relativePath) : '');
      setEditingPrimary(true);
    } else if (!open && editingPrimary) {
      if (note) void finishPrimaryEdit();
      else {
        if (!cancelDraftEditRef.current) void createDraftPrimary();
        cancelDraftEditRef.current = false;
        setEditingPrimary(false);
        setSwitchNoteOpen(false);
      }
    }
  };

  return <tr className="hover:bg-[var(--muted)]/25">
    {fields.map((field) => {
      const value = notePropertyEditorValue(note, field);
      const inputClass = 'h-8 w-full rounded-md border-0 bg-transparent px-0 text-sm outline-none placeholder:text-[var(--muted-foreground)] placeholder:opacity-80 focus:border-0 focus:bg-transparent focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50';
      const isWrappingContent = field.type === 'primary' || field.type === 'Text' || field.type === 'Tag' || field.type === 'Tags';
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
      return <td
        key={field.id}
        title={cellStatus?.error}
        className={`${fieldColumnWidth(field.type)} ${showBottomBorder ? 'border-b' : ''} border-r border-[var(--border)] p-0 ${isWrappingContent ? 'overflow-visible align-middle' : 'h-10 max-h-10 overflow-hidden align-middle'} ${cellStatus?.error ? 'ring-1 ring-inset ring-[var(--destructive)]' : ''}`}
      >
        <div className={`multidimensional-table__cell-content${field.type === 'primary' ? ' multidimensional-table__primary-cell group' : ''}`}>
          {field.type === 'primary' ? (() => {
            const path = note && notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
            return note && path
              ? <>
                <Popover open={editingPrimary} onOpenChange={handlePrimaryEditorOpenChange} cellPopup>
                  <PopoverTrigger asChild anchorToCell>
                    <button type="button" disabled={saving} className="multidimensional-table__primary-title !py-1" title={displayTitleFromFilename(note.relativePath)}>
                      {isRuleLinked && !editingPrimary && <LightningIcon className="multidimensional-table__rule-link-icon" aria-hidden="true" />}
                      <span>{displayTitleFromFilename(note.relativePath)}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" side="bottom" sideOffset={4} fitViewport className="w-[240px] max-w-[calc(100vw-1rem)] rounded-xl px-2 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                    <div className="multidimensional-table__primary-editor">
                      <textarea
                        ref={primaryTitleInputRef}
                        autoFocus
                        aria-label="笔记文件名"
                        rows={1}
                        value={primaryTitleInput.value}
                        disabled={renamingPrimary || saving}
                        className="multidimensional-table__primary-title-input"
                        onChange={primaryTitleInput.onChange}
                        onCompositionStart={primaryTitleInput.onCompositionStart}
                        onCompositionEnd={primaryTitleInput.onCompositionEnd}
                        onKeyDown={(event) => {
                          if (primaryTitleInput.isComposingKeyboardEvent(event.nativeEvent)) {
                            if (event.key === 'Escape' || event.key === 'Enter') event.stopPropagation();
                            return;
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            setPrimaryTitleDraft(displayTitleFromFilename(note.relativePath));
                            setEditingPrimary(false);
                          }
                        }}
                      />
                      <div className="multidimensional-table__primary-editor-actions">
                        <button type="button" aria-label="跳转到目标文档" title="跳转到目标文档" disabled={renamingPrimary || saving} onMouseDown={(event) => event.preventDefault()} onClick={async () => {
                          const renamed = await finishPrimaryEdit();
                          if (renamed) onOpenNote(renamed);
                        }}>
                          <ArrowUpRightIcon size={14} weight="bold" aria-hidden="true" />
                        </button>
                        <button type="button" aria-label="切换文档" aria-expanded={switchNoteOpen} title="切换文档" disabled={renamingPrimary || saving} onMouseDown={(event) => event.preventDefault()} onClick={async () => {
                          const renamed = await finishPrimaryEdit(true);
                          if (renamed) setSwitchNoteOpen((open) => {
                            const next = !open;
                            if (next) setSwitchNoteSearch('');
                            return next;
                          });
                        }}>
                          <ArrowsLeftRightIcon size={14} weight="bold" aria-hidden="true" />
                        </button>
                        <button type="button" aria-label="从表格移除此行" title="从表格移除此行" disabled={renamingPrimary || saving} onMouseDown={(event) => event.preventDefault()} onClick={async () => {
                          const renamed = await finishPrimaryEdit();
                          if (renamed) onDeleteRecord(record.id);
                        }}>
                          <MinusCircleIcon size={14} weight="bold" aria-hidden="true" />
                        </button>
                      </div>
                      {switchNoteOpen && <div className="min-w-0">
                        <input
                          autoFocus
                          type="search"
                          aria-label="搜索并添加笔记"
                          placeholder={availableNotes.length ? '搜索并添加笔记' : '没有可更换的文档'}
                          value={switchNoteSearch}
                          disabled={saving || renamingPrimary || availableNotes.length === 0}
                          onChange={(event) => setSwitchNoteSearch(event.target.value)}
                          className="h-8 w-full border-0 bg-transparent px-0 text-sm outline-none placeholder:text-[var(--muted-foreground)]"
                        />
                        <div role="listbox" aria-label="新文档" className="-mx-1 max-h-48 overflow-y-auto">
                          {filteredAvailableNotes.map((availableNote) => <button
                            key={availableNote.relativePath}
                            type="button"
                            role="option"
                            aria-selected={false}
                            disabled={saving || renamingPrimary}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              onReplaceNote(record.id, availableNote.relativePath.replace(/\\/g, '/'));
                              setSwitchNoteOpen(false);
                              setEditingPrimary(false);
                            }}
                            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--hover-bg)] disabled:opacity-50"
                            title={availableNote.relativePath}
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
                            <span className="truncate">{availableNote.title || availableNote.relativePath}</span>
                          </button>)}
                          {availableNotes.length > 0 && filteredAvailableNotes.length === 0 && <p className="px-1 py-2 text-sm text-[var(--muted-foreground)]">没有匹配的文档</p>}
                        </div>
                      </div>}
                    </div>
                  </PopoverContent>
                </Popover>
                <button
                  type="button"
                  aria-label={`打开笔记 ${note.title || note.relativePath}`}
                  title="打开"
                  className="multidimensional-table__open-note"
                  onClick={() => onOpenNote(note)}
                >
                  <ArrowUpRightIcon className="h-3.5 w-3.5" weight="bold" aria-hidden="true" />
                </button>
              </>
                : noteStatus === 'draft'
                ? <Popover open={editingPrimary} onOpenChange={handlePrimaryEditorOpenChange} cellPopup>
                  <PopoverTrigger asChild anchorToCell>
                    <button type="button" disabled={saving} className="multidimensional-table__primary-title multidimensional-table__primary-title--placeholder !py-1" title="新建或选择笔记">新建或选择笔记</button>
                  </PopoverTrigger>
                  <PopoverContent align="start" side="bottom" sideOffset={4} fitViewport className="w-[240px] max-w-[calc(100vw-1rem)] rounded-xl px-2 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                    <div className="multidimensional-table__primary-editor">
                      <textarea
                        ref={primaryTitleInputRef}
                        autoFocus
                        aria-label="新笔记标题"
                        placeholder="输入笔记标题"
                        rows={1}
                        value={primaryTitleInput.value}
                        disabled={saving}
                        className="multidimensional-table__primary-title-input"
                        onChange={primaryTitleInput.onChange}
                        onCompositionStart={primaryTitleInput.onCompositionStart}
                        onCompositionEnd={primaryTitleInput.onCompositionEnd}
                        onKeyDown={(event) => {
                          if (primaryTitleInput.isComposingKeyboardEvent(event.nativeEvent)) {
                            if (event.key === 'Escape' || event.key === 'Enter') event.stopPropagation();
                            return;
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            cancelDraftEditRef.current = true;
                            setPrimaryTitleDraft('');
                            setEditingPrimary(false);
                          }
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            event.stopPropagation();
                            void createDraftPrimary();
                          }
                        }}
                        onBlur={() => {
                          if (cancelDraftEditRef.current) return;
                          void createDraftPrimary();
                        }}
                      />
                      <div className="multidimensional-table__primary-editor-actions">
                        <button type="button" aria-label="创建并关联笔记" title="创建并关联笔记" disabled={!primaryTitleDraft.trim() || saving} onMouseDown={(event) => event.preventDefault()} onClick={() => void createDraftPrimary()}>
                          <Plus size={14} aria-hidden="true" />
                        </button>
                        <button type="button" aria-label="切换笔记" aria-expanded={switchNoteOpen} title="切换笔记" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={() => setSwitchNoteOpen((open) => {
                          const next = !open;
                          if (next) setSwitchNoteSearch('');
                          return next;
                        })}>
                          <ArrowsLeftRightIcon size={14} weight="bold" aria-hidden="true" />
                        </button>
                        <button type="button" aria-label="从表格移除此行" title="从表格移除此行" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={() => onDeleteRecord(record.id)}>
                          <MinusCircleIcon size={14} weight="bold" aria-hidden="true" />
                        </button>
                      </div>
                      {switchNoteOpen && <div className="min-w-0">
                        <input
                          type="search"
                          aria-label="搜索并添加笔记"
                          placeholder={availableNotes.length ? '搜索并添加笔记' : '没有可更换的文档'}
                          value={switchNoteSearch}
                          disabled={saving || availableNotes.length === 0}
                          onChange={(event) => setSwitchNoteSearch(event.target.value)}
                          className="h-8 w-full border-0 bg-transparent px-0 text-sm outline-none placeholder:text-[var(--muted-foreground)]"
                        />
                        <div role="listbox" aria-label="新文档" className="-mx-1 max-h-48 overflow-y-auto">
                          {filteredAvailableNotes.map((availableNote) => <button
                            key={availableNote.relativePath}
                            type="button"
                            role="option"
                            aria-selected={false}
                            disabled={saving}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              onReplaceNote(record.id, availableNote.relativePath.replace(/\\/g, '/'));
                              setSwitchNoteOpen(false);
                              setEditingPrimary(false);
                            }}
                            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--hover-bg)] disabled:opacity-50"
                            title={availableNote.relativePath}
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
                            <span className="truncate">{availableNote.title || availableNote.relativePath}</span>
                          </button>)}
                          {availableNotes.length > 0 && filteredAvailableNotes.length === 0 && <p className="px-1 py-2 text-sm text-[var(--muted-foreground)]">没有匹配的文档</p>}
                        </div>
                      </div>}
                    </div>
                  </PopoverContent>
                </Popover>
                : noteStatus === 'unknown'
                  ? <button
                    type="button"
                    disabled={saving}
                    title={record.note_path}
                    className="max-w-full truncate px-0 text-left text-sm text-[var(--muted-foreground)] opacity-80 hover:opacity-100 disabled:opacity-50"
                    onClick={onRetryNoteLookup}
                  >无法确认关联状态，点击重试</button>
                  : <button
                    type="button"
                    disabled={saving}
                    title={record.note_path}
                    className="max-w-full truncate px-0 text-left text-sm text-[var(--muted-foreground)] opacity-80 hover:opacity-100 disabled:opacity-50"
                    onClick={(event) => onOpenNotePicker(event.currentTarget.closest('td')?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect(), record.id)}
                  >未在笔记列表找到，关联失效：{record.note_path} · 点击更换</button>;
          })()
            : field.type === 'Image' ? (() => {
              const path = imagePaths(value)[0];
              const uploading = uploadingImageFieldId === field.id;
              return <div className="flex h-10 min-w-0 items-center gap-1 overflow-hidden px-0">
              {path ? (() => {
                const key = `${record.id}:${field.id}:${path}`;
                return <button
                  type="button"
                  disabled={cellDisabled || uploading}
                  onClick={() => void chooseImage()}
                  className="group relative h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-[var(--border)] bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-50"
                  title={t('document.properties.selectImage')}
                  aria-label={t('document.properties.selectImage')}
                >
                  {imageUrls[key]
                    ? <img src={imageUrls[key] ?? undefined} alt="" className="h-full w-full object-cover" />
                    : <ImagePlus className="m-auto h-4 w-4 text-[var(--muted-foreground)]" aria-hidden="true" />}
                  <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100">
                    <ImagePlus className="h-4 w-4" aria-hidden="true" />
                  </span>
                </button>;
              })()
                : <button
                    type="button"
                    disabled={cellDisabled || uploading}
                    onClick={() => void chooseImage()}
                    className="frontmatter-property__date-picker-trigger flex h-8 min-w-0 flex-1 items-center rounded-lg border-0 bg-transparent px-0 text-left text-sm text-[var(--muted-foreground)] opacity-80 hover:bg-transparent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >{uploading ? t('document.properties.selectingImage') : t('document.properties.selectImage')}</button>}
              </div>;
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
                  : field.type === 'Boolean' ? <TableBooleanInput value={value} disabled={cellDisabled} onChange={(nextValue) => onUpdateCell(record, note, field, nextValue)} />
                    : field.type === 'MultiSelect' ? <MultiSelectValueInput
                      value={Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' ? value : ''}
                      options={field.options?.map((option) => ({ value: option.id, label: option.label })) ?? []}
                      disabled={cellDisabled}
                      variant="table"
                      onChange={(next) => onUpdateCell(record, note, field, next.split(',').map((item) => item.trim()).filter(Boolean))}
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
                        />
                          : field.type === 'Tag' || field.type === 'Tags' ? <TableTagValueInput
                            value={Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : []}
                            disabled={cellDisabled}
                            isNoteTags={field.type === 'Tags' || canonicalizePropertyKey(field.property_key ?? '') === 'tags'}
                            onChange={(next) => onUpdateCell(record, note, field, next)}
                          />
                            : field.type === 'Number' ? <TableNumberInput
                              value={value}
                              disabled={cellDisabled}
                              placeholder={field.id === titleField?.id ? '输入名称' : ''}
                              className={inputClass}
                              onChange={(nextValue) => onUpdateCell(record, note, field, nextValue)}
                            />
                              : field.type === 'Text' ? <TableTextValueInput
                                value={value == null ? '' : String(value)}
                                disabled={cellDisabled}
                                placeholder={field.id === titleField?.id ? '输入名称' : ''}
                                onChange={(nextValue) => onUpdateCell(record, note, field, nextValue)}
                              />
                                : <input className={inputClass} type={field.type === 'URL' ? 'url' : 'text'} disabled={cellDisabled} placeholder={field.id === titleField?.id ? '输入名称' : ''} onBlur={(event) => {
                                  if (cellDisabled) return;
                                  const nextValue = event.target.value || null;
                                  if (nextValue !== value) onUpdateCell(record, note, field, nextValue);
                                }} defaultValue={Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value)} />}
        </div>
      </td>;
    })}
    <td className={`multidimensional-table__row-action-cell px-2 text-left${showBottomBorder ? ' multidimensional-table__row-action-cell--bordered' : ''}`}>
      <Popover open={rowActionOpen} onOpenChange={(open) => onRowActionOpenChange(open, record.id)}>
        <PopoverTrigger asChild>
          <button type="button" disabled={saving} aria-label="更多行操作" title="更多行操作" className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] disabled:opacity-40">
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" sideOffset={4} ignoreSelectOutside={false} className="w-36 rounded-xl p-1">
          <button type="button" disabled={saving} onClick={() => onDeleteRecord(record.id)} className="flex h-7 w-full items-center justify-start rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-transparent hover:text-[var(--destructive)] disabled:opacity-50">
            <MinusCircleIcon className="mr-2 h-4 w-4" aria-hidden="true" />从表格移除
          </button>
        </PopoverContent>
      </Popover>
    </td>
  </tr>;
});
