'use client';

import { mutateCollectionFile } from '@features/collection/mutations';
import { reviseCollection } from '@features/collection/model';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, FileText, Plus, Table2, X } from 'lucide-react';
import { ArrowsLeftRightIcon, MinusCircleIcon } from '@phosphor-icons/react';
import { attachments, dialogs, files, collections, notes as notesClient, windows, type NoteEntry } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import { removeDocumentProperty, setDocumentProperties } from '@features/document/public/path-properties';
import { PROPERTY_URL_RE } from '@features/document/properties/property-type';
import { getAllPresets, resolvePropertyDisplayName, type PropertyPreset } from '@features/document/properties/presets';
import { usePropertyFieldPreferences } from '@features/preferences/public/runtime-api';
import { createFileBrowserTarget, openBrowserColumnTarget } from '@features/workspace/use-cases/browser-column-navigation';
import { replaceExternalDocumentPath } from '@features/workspace/use-cases/workspace-navigation';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import { renameMarkdownTitle } from '@features/document/use-cases/local-document-operations';
import { ensureFileDisplayIdentity, findFileDisplayIdentity, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { displayTitleFromFilename, tableDocumentExtension } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { ADDABLE_TABLE_PROPERTY_KINDS, getPropertyTypeDefinition, type PropertyKind, type PropertyIconKind } from '@/lib/property-types';
import {
  createUuidV7,
  addTableView,
  type MultidimensionalTableDocument,
  type TableField,
  type TableView,
  type TableRecord,
  type TableFieldType,
  type TableFieldOption,
  type TableAutoCollectCondition,
  type TableAutoCollectConfig,
  NOTE_CREATED_AT_FIELD_ID,
  NOTE_UPDATED_AT_FIELD_ID,
} from './model';
import { groupRecordsByValue } from './view-index';
import { noteMatchesAutoCollect } from './record-auto-collect';
import { asyncMapLimit } from './async-map-limit';
import { TableCalendarView, TableGalleryView, TableKanbanView } from './table-secondary-views';
import { TableRecordRow } from './table-record-row';
import { FieldTypeIcon, TableFieldHeader, TablePresetMenu } from './table-field-header';
import { useTableSession } from './use-table-session';
import { useTableCellWriter, type TableCellSaveStatus } from './use-table-cell-writer';
import { changeFieldType as changeFieldTypeInDocument, removeField, viewsIncompatibleWithFieldType, viewsRequiringField } from './table-commands';

export interface TableDocumentViewProps {
  filePath: string;
  /** Stable runtime identity for the table file; survives a rename. */
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId: string | null;
  expectedCollectionId?: string | null;
  initialViewId?: string | null;
  onActiveViewChange?: (viewId: string) => void;
  editable?: boolean;
  canCreateFields?: boolean;
  canCreateRecords?: boolean;
  /** Show the explicit “关联笔记” entry independently from generic record creation controls. */
  showAssociateNoteAction?: boolean;
  canDeleteViews?: boolean;
  /** The table is rendered as a node inside the Markdown editor. */
  embeddedInEditor?: boolean;
  /** Removes the reference node when an embedded table cannot be loaded. */
  onRemoveReference?: () => void;
  /** Renders title bar actions and receives the table dataset action. */
  trailingActions?: (datasetAction: ReactNode) => ReactNode;
  /** Called after the table file has been renamed. */
  onFilePathChange?: (filePath: string) => void;
}

const FIELD_TYPE_CHOICES: TableFieldType[] = ADDABLE_TABLE_PROPERTY_KINDS.filter((kind) => kind !== 'Note');
const NOTE_CALENDAR_DATE_FIELDS = [
  { id: NOTE_CREATED_AT_FIELD_ID, label: '创建时间', timestamp: 'createdAt' as const },
  { id: NOTE_UPDATED_AT_FIELD_ID, label: '更新时间', timestamp: 'updatedAt' as const },
];
const TABLE_PAGE_SIZE = 100;
const TABLE_ACTION_COLUMN_MIN_WIDTH = 60;
type TableFieldWidthConfig = {
  minWidth: number;
  maxWidth?: number;
  columnWidth: number | string;
  cellClassName: string;
  fitContent?: boolean;
};
const TABLE_FIELD_WIDTHS: Partial<Record<TableFieldType, TableFieldWidthConfig>> = {
  primary: {
    minWidth: 160,
    maxWidth: 280,
    columnWidth: 160,
    cellClassName: 'min-w-40 max-w-[280px]',
    fitContent: true,
  },
  Text: {
    minWidth: 160,
    maxWidth: 280,
    columnWidth: 160,
    cellClassName: 'min-w-40 max-w-[280px]',
    fitContent: true,
  },
  Number: { minWidth: 120, maxWidth: 120, columnWidth: 120, cellClassName: 'w-[120px] min-w-[120px] max-w-[120px]' },
  Boolean: { minWidth: 120, maxWidth: 120, columnWidth: 120, cellClassName: 'w-[120px] min-w-[120px] max-w-[120px]' },
};
const DEFAULT_TABLE_FIELD_WIDTH: TableFieldWidthConfig = { minWidth: 160, columnWidth: 160, cellClassName: 'min-w-40' };
function TableLoadingSkeleton() {
  return <div className="flex h-full min-h-0 flex-col gap-3 p-5" role="status" aria-label="正在打开多维表格…">
    <div className="text-xs text-[var(--muted-foreground)]">正在打开多维表格…</div>
    <div className="min-h-0 flex-1 overflow-hidden">
      <table className="multidimensional-table w-full min-w-[640px] table-fixed border-collapse text-sm" aria-hidden="true">
        <thead><tr>{['w-2/3', 'w-1/2', 'w-3/5', 'w-2/5'].map((width, index) => <th key={index} className="h-10 border-r border-[var(--border)] px-2 text-left">
          <div className={`h-3 animate-pulse rounded bg-[var(--muted)] ${width}`} />
        </th>)}</tr></thead>
        <tbody>{Array.from({ length: 7 }, (_, row) => <tr key={row}>{['w-3/4', 'w-1/2', 'w-2/3', 'w-1/3'].map((width, column) => <td key={column} className="h-10 border-b border-r border-[var(--border)] px-2">
          <div className={`h-3 animate-pulse rounded bg-[var(--muted)] ${width}`} />
        </td>)}</tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function valueMatchesFieldType(value: unknown, type: TableFieldType, options: TableField['options'] = [], multiple = false): boolean {
  if (value == null || value === '') return true;
  switch (type) {
    case 'primary': case 'Text': case 'Icon': return typeof value === 'string';
    case 'URL': return typeof value === 'string' && PROPERTY_URL_RE.test(value);
    case 'Boolean': return typeof value === 'boolean';
    case 'Number': return typeof value === 'number' && Number.isFinite(value);
    case 'Date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'Select': return typeof value === 'string' && options.some((option) => option.id === value || option.label === value);
    case 'MultiSelect': return Array.isArray(value) && value.every((item) => typeof item === 'string' && options.some((option) => option.id === item || option.label === item));
    case 'Tag': case 'Tags': case 'Color': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'Image': return multiple
      ? Array.isArray(value) && value.every((item) => typeof item === 'string')
      : typeof value === 'string';
  }
  return false;
}

function fieldTypeLabel(type: PropertyKind | 'primary', t: (key: I18nKey) => string): string {
  return t(getPropertyTypeDefinition(type === 'primary' ? 'Note' : type).labelKey);
}

function fieldTypeIconKind(type: TableFieldType): PropertyIconKind {
  return type === 'primary' ? 'note' : getPropertyTypeDefinition(type).iconKind;
}

function fieldLabel(
  field: TableField,
  propertyFields: ReturnType<typeof usePropertyFieldPreferences>['fields'],
  t: (key: I18nKey) => string,
): string {
  return field.name ?? resolvePropertyDisplayName(field.property_key ?? '', propertyFields, t);
}

function imagePaths(value: unknown): string[] {
  if (typeof value === 'string' && value) return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && Boolean(item));
  return [];
}

function fieldWidthConfig(type: TableFieldType) {
  return TABLE_FIELD_WIDTHS[type] ?? DEFAULT_TABLE_FIELD_WIDTH;
}

function fieldColumnWidth(type: TableFieldType): string {
  return fieldWidthConfig(type).cellClassName;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function calendarDateKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value)?.[1] ?? null;
}

function calendarDateTimeForTimestamp(timestamp: number | undefined): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${isoDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function noteKeyForRecord(record: TableRecord): string {
  return record.note_path;
}

function upsertTableRecord(records: TableRecord[], nextRecord: TableRecord): TableRecord[] {
  if (!records.some((record) => record.id === nextRecord.id)) return [...records, nextRecord];
  return records.map((record) => record.id === nextRecord.id ? nextRecord : record);
}

function notePropertyEditorValue(note: NoteEntry | undefined, field: TableField): unknown {
  if (field.type === 'primary') return note?.relativePath ?? null;
  const propertyKey = field.property_key ?? '';
  const value = note && Object.prototype.hasOwnProperty.call(note.properties, propertyKey)
    ? note.properties[propertyKey]
    : null;
  if (field.type === 'Select') {
    return field.options?.find((option) => option.label === value)?.id
      ?? field.options?.find((option) => option.id === value)?.id
      ?? '';
  }
  if (field.type === 'MultiSelect' && Array.isArray(value)) {
    return value.map((entry) => field.options?.find((option) => option.label === entry)?.id
      ?? field.options?.find((option) => option.id === entry)?.id
      ?? String(entry));
  }
  return value;
}

const EMPTY_CELL_STATUSES: ReadonlyMap<string, TableCellSaveStatus> = new Map();

export function TableDocumentView(props: TableDocumentViewProps) {
  const fileSessionId = props.fileIdentity?.displayId ?? props.filePath;
  // Display identity owns the session; resolved path/scope are mutable locators.
  const sessionKey = props.fileIdentity?.displayId ?? JSON.stringify([fileSessionId, props.notebookPath ? canonicalDirectoryPath(props.notebookPath) : null, props.notebookId]);
  return <TableDocumentViewSession key={sessionKey} {...props} />;
}

function TableDocumentViewSession({ filePath, fileIdentity, notebookPath, notebookId, expectedCollectionId, initialViewId, onActiveViewChange, editable = true, canCreateFields = true, canCreateRecords = true, showAssociateNoteAction = canCreateRecords, canDeleteViews = true, embeddedInEditor = false, onRemoveReference, trailingActions, onFilePathChange }: TableDocumentViewProps) {
  const { t } = useI18n();
  const { fields: propertyFields } = usePropertyFieldPreferences();
  const tablePresets = useMemo(() => {
    const presets = getAllPresets(propertyFields, (key) => t(key));
    return {
      custom: presets.filter((preset) => preset.source === 'custom'),
      system: presets.filter((preset) => preset.source === 'builtin'),
    };
  }, [propertyFields, t]);
  const {
    document, loadError, saving, setSaving, notes, setNotes, resolvedNotebookId,
    notesLoadError, load, acceptContent, save: saveSession, loadSequenceRef, loadGeneration, isCurrentSession, pendingNotePropertiesRef,
  } = useTableSession({ filePath, fileIdentity, notebookPath, notebookId });
  useEffect(() => {
    if (!embeddedInEditor || !expectedCollectionId || !notebookId || !notebookPath || !onFilePathChange) return;
    const pathIsUnusable = Boolean(loadError)
      || Boolean(document && document.collection.id !== expectedCollectionId);
    if (!pathIsUnusable) return;

    let active = true;
    void collections.resolve(notebookId, expectedCollectionId).then((indexedTable) => {
      if (!active) return;
      if (indexedTable.identityConflict || indexedTable.parseState !== 'valid') return;
      const indexedPath = joinNotebookMemoPath(notebookPath, indexedTable.relativePath);
      if (!indexedPath || canonicalPath(indexedPath) === canonicalPath(filePath)) return;
      onFilePathChange(indexedPath);
    }).catch(() => undefined);

    return () => { active = false; };
  }, [document, embeddedInEditor, expectedCollectionId, filePath, loadError, notebookId, notebookPath, onFilePathChange]);
  const save = useCallback(async (...args: Parameters<typeof saveSession>) => {
    if (!editable) return false;
    return saveSession(...args);
  }, [editable, saveSession]);
  const [activeViewId, setActiveViewId] = useState<string | null>(() => initialViewId ?? null);
  const previousInitialViewIdRef = useRef(initialViewId ?? null);
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [editingViewName, setEditingViewName] = useState('');
  const [editingViewWidth, setEditingViewWidth] = useState(48);
  const [editingTableName, setEditingTableName] = useState(false);
  const [tableNameDraft, setTableNameDraft] = useState('');
  const [renamingTableFile, setRenamingTableFile] = useState(false);
  const tableNameInputRef = useRef<HTMLInputElement | null>(null);
  const renameTableFile = useCallback(async (rawTitle: string) => {
    setEditingTableName(false);
    const title = rawTitle.trim();
    const currentTitle = document?.collection.name ?? displayTitleFromFilename(filePath);
    if (!editable || saving || renamingTableFile || !notebookPath || !title || title === currentTitle) return;
    if (/[\\/]/.test(title)) {
      toast.error('文件名不能包含路径分隔符');
      return;
    }
    const extension = tableDocumentExtension(filePath);
    if (!extension) {
      toast.error('无法识别多维表格文件后缀');
      return;
    }

    setRenamingTableFile(true);
    const previousPath = canonicalPath(filePath);
    const identity = fileIdentity ?? findFileDisplayIdentity(previousPath) ?? ensureFileDisplayIdentity(previousPath);
    try {
      if (!document || !resolvedNotebookId) throw new Error('集合尚未加载完成');
      const result = await mutateCollectionFile({ notebookId: resolvedNotebookId, notebookPath, collectionId: document.collection.id, expectedRevision: document.collection.revision, newName: title });
      replaceExternalDocumentPath(identity.displayId, previousPath, result.filePath);
      acceptContent(result.content);
      onFilePathChange?.(result.filePath);
      if (result.errorCode) toast.error(`集合已更新，后续操作待恢复：${result.errorCode}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重命名多维表格失败');
    } finally {
      setRenamingTableFile(false);
    }
  }, [acceptContent, document, editable, fileIdentity, filePath, notebookPath, onFilePathChange, renamingTableFile, resolvedNotebookId, saving]);
  const editingViewInputRef = useRef<HTMLInputElement | null>(null);
  const editingViewMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [viewAddOpen, setViewAddOpen] = useState(false);
  const [fieldPanelHeaderId, setFieldPanelHeaderId] = useState<string | null>(null);
  const [matchingOpen, setMatchingOpen] = useState(false);
  const [viewAddStep, setViewAddStep] = useState<'kind' | 'field'>('kind');
  const [pendingViewType, setPendingViewType] = useState<'calendar' | 'kanban' | null>(null);
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const calendarViewForSettings = document?.table.views.find((view) => view.id === activeViewId) ?? document?.table.views[0];
  const calendarWeekStart: 0 | 1 = calendarViewForSettings?.type === 'calendar' && calendarViewForSettings.config.week_start === 1 ? 1 : 0;
  const [tablePage, setTablePage] = useState(0);
  const [contentColumnWidths, setContentColumnWidths] = useState<Record<string, number>>({});
  const tableElementRef = useRef<HTMLTableElement | null>(null);
  const { cellStatusesByRecord, updateCell } = useTableCellWriter({
    enabled: Boolean(document) && !saving && editable,
    loadGeneration,
    notebookPath,
    loadSequenceRef,
    setNotes,
    pendingNotePropertiesRef,
  });
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const [newFieldAnchorRect, setNewFieldAnchorRect] = useState<DOMRect | null>(null);
  const [newFieldPropertyKey, setNewFieldPropertyKey] = useState('');
  const [newFieldType, setNewFieldType] = useState<TableFieldType>('Text');
  const [newFieldTypeMenuOpen, setNewFieldTypeMenuOpen] = useState(false);
  const [newFieldPresetMenuOpen, setNewFieldPresetMenuOpen] = useState(false);
  const [newFieldOptions, setNewFieldOptions] = useState<string[]>([]);
  const [headerMenuFieldId, setHeaderMenuFieldId] = useState<string | null>(null);
  const [rowActionRecordId, setRowActionRecordId] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string | null>>({});
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [notePickerAnchorRect, setNotePickerAnchorRect] = useState<DOMRect | null>(null);
  const [notePickerRecordId, setNotePickerRecordId] = useState<string | null>(null);
  const [notePickerCalendarDate, setNotePickerCalendarDate] = useState<{ fieldId: string; date: string } | null>(null);
  const [selectedNoteKey, setSelectedNoteKey] = useState('');
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [calendarAddOpen, setCalendarAddOpen] = useState(false);
  const [calendarAddAnchorRect, setCalendarAddAnchorRect] = useState<DOMRect | null>(null);
  const [calendarAddDate, setCalendarAddDate] = useState<{ fieldId: string; date: string } | null>(null);
  const [calendarAddTitle, setCalendarAddTitle] = useState('');
  const calendarAddTitleInput = useComposingValue(calendarAddTitle, setCalendarAddTitle);
  const [calendarAddSearchOpen, setCalendarAddSearchOpen] = useState(false);
  const [calendarAddSearch, setCalendarAddSearch] = useState('');
  const calendarAddTitleInputRef = useRef<HTMLTextAreaElement>(null);
  const [autoOpenPrimaryRecordId, setAutoOpenPrimaryRecordId] = useState<string | null>(null);
  const conditionRecordIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    setImageUrls({});
    setTablePage(0);
  }, [loadGeneration]);

  useEffect(() => {
    const requestedViewId = initialViewId ?? null;
    const requestedViewChanged = previousInitialViewIdRef.current !== requestedViewId;
    previousInitialViewIdRef.current = requestedViewId;
    setActiveViewId((current) => {
      const currentIsValid = Boolean(current && document?.table.views.some((view) => view.id === current));
      if (!requestedViewChanged && currentIsValid) return current;
      return document?.table.views.find((view) => view.id === requestedViewId)?.id
        ?? (currentIsValid ? current : document?.table.views[0]?.id ?? null);
    });
  }, [document?.table.views, initialViewId]);

  useLayoutEffect(() => {
    if (!editingViewId) return;
    const input = editingViewInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editingViewId]);

  useLayoutEffect(() => {
    if (!editingTableName) return;
    const input = tableNameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editingTableName]);

  useLayoutEffect(() => {
    if (!editingViewId) return;
    const measuredWidth = editingViewMeasureRef.current?.getBoundingClientRect().width;
    if (measuredWidth) setEditingViewWidth(Math.max(40, Math.ceil(measuredWidth + 2)));
  }, [editingViewId, editingViewName, activeViewId]);

  const calendarDays = useMemo(() => {
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const startOffset = (first.getDay() - calendarWeekStart + 7) % 7;
    const endOffset = (calendarWeekStart + 6 - last.getDay() + 7) % 7;
    const start = new Date(year, month, 1 - startOffset);
    return Array.from({ length: startOffset + last.getDate() + endOffset }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return { date, iso: isoDate(date), inMonth: date.getMonth() === month };
    });
  }, [calendarCursor, calendarWeekStart]);

  const noteField = document?.table.fields[0];
  const noteByKey = useMemo(() => new Map(notes.map((note) => [note.relativePath.replace(/\\/g, '/'), note])), [notes]);
  const conditionRecords = useMemo(() => {
    if (!document || !noteField) return [];
    const autoCollect = document.records.auto_collect;
    if (!autoCollect) return [];

    const linkedPaths = new Set(document.records.data.map((record) => record.note_path.replace(/\\/g, '/')).filter(Boolean));
    const excludedPaths = new Set(autoCollect.excluded_note_paths.map((path) => path.replace(/\\/g, '/')));
    return notes.flatMap((note) => {
      const notePath = note.relativePath.replace(/\\/g, '/');
      if (linkedPaths.has(notePath) || excludedPaths.has(notePath)
        || !noteMatchesAutoCollect(note, document.table.fields, noteField.id, autoCollect.condition)) return [];
      let id = conditionRecordIdsRef.current.get(notePath);
      if (!id) {
        id = `rec_${createUuidV7()}`;
        conditionRecordIdsRef.current.set(notePath, id);
      }
      return [{
        id,
        updated_at: new Date(note.updatedAt).toISOString(),
        note_path: notePath,
      }];
    });
  }, [document, noteField, notes]);
  const conditionRecordIds = useMemo(() => new Set(conditionRecords.map((record) => record.id)), [conditionRecords]);
  const visibleRecords = useMemo(() => document ? [...document.records.data, ...conditionRecords] : [], [conditionRecords, document?.records]);
  useEffect(() => {
    if (!document) {
      setContentColumnWidths((current) => Object.keys(current).length ? {} : current);
      return;
    }
    if (typeof window === 'undefined') return;
    const contentFields = document.table.fields.filter((field) => fieldWidthConfig(field.type).fitContent);
    if (!contentFields.length) {
      setContentColumnWidths((current) => Object.keys(current).length ? {} : current);
      return;
    }

    const context = window.document.createElement('canvas').getContext('2d');
    const tableElement = tableElementRef.current;
    if (context) {
      if (tableElement) {
        const style = window.getComputedStyle(tableElement);
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      } else {
        context.font = '400 14px sans-serif';
      }
    }
    const measure = (value: string) => context?.measureText(value).width ?? value.length * 7;
    const nextWidths: Record<string, number> = {};
    for (const field of contentFields) {
      const config = fieldWidthConfig(field.type);
      const maxWidth = config.maxWidth ?? 280;
      const inset = 8;
      let desiredWidth = Math.max(config.minWidth, measure(fieldLabel(field, propertyFields, t)) + inset * 2 + 26);
      // Use the full record set so the column width stays stable across 100-row pages.
      for (const record of visibleRecords) {
        const note = noteByKey.get(noteKeyForRecord(record));
        const value = field.type === 'primary'
          ? note ? displayTitleFromFilename(note.relativePath) : null
          : notePropertyEditorValue(note, field);
        if (value == null || value === '') continue;
        const contentInset = field.type === 'primary' ? 40 : inset * 2;
        desiredWidth = Math.max(desiredWidth, measure(String(value).replace(/\r\n?|\n/g, ' ')) + contentInset);
      }
      nextWidths[field.id] = Math.ceil(Math.min(maxWidth, desiredWidth));
    }

    setContentColumnWidths((current) => {
      const currentIds = Object.keys(current);
      const nextIds = Object.keys(nextWidths);
      if (currentIds.length === nextIds.length && nextIds.every((id) => current[id] === nextWidths[id])) return current;
      return nextWidths;
    });
  }, [activeViewId, document, noteByKey, propertyFields, t, visibleRecords]);
  const linkedNoteKeys = useMemo(() => new Set(visibleRecords
    .map((record) => noteKeyForRecord(record))
    .filter((key): key is string => key !== null)), [visibleRecords]);
  const availableNotes = useMemo(() => notes.filter((note) => !linkedNoteKeys.has(note.relativePath.replace(/\\/g, '/'))), [linkedNoteKeys, notes]);
  const filteredCalendarNotes = useMemo(() => {
    const query = calendarAddSearch.trim().toLocaleLowerCase();
    return availableNotes.filter((note) => !query || `${note.title ?? ''} ${note.relativePath}`.toLocaleLowerCase().includes(query));
  }, [availableNotes, calendarAddSearch]);
  const availableNotesRef = useRef(availableNotes);
  availableNotesRef.current = availableNotes;
  const getAvailableNotes = useCallback(() => availableNotesRef.current, []);
  const availableNotesListenersRef = useRef(new Set<() => void>());
  const subscribeAvailableNotes = useCallback((listener: () => void) => {
    availableNotesListenersRef.current.add(listener);
    return () => availableNotesListenersRef.current.delete(listener);
  }, []);
  useEffect(() => {
    for (const listener of availableNotesListenersRef.current) listener();
  }, [availableNotes]);
  useEffect(() => {
    const input = calendarAddTitleInputRef.current;
    if (!calendarAddOpen || !input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.5)}px`;
  }, [calendarAddOpen, calendarAddTitle]);
  const candidateImageReferences = useMemo(() => {
    if (!document) return [];
    const active = document.table.views.find((view) => view.id === activeViewId) ?? document.table.views[0];
    if (active?.type !== 'table' && active?.type !== 'gallery') return [];
    const visibleFields = active.config.visible_fields as string[];
    const imageFields = document.table.fields.filter((field) => field.type === 'Image'
      && (active.type === 'table' || visibleFields.includes(field.id)));
    const currentPage = Math.min(tablePage, Math.max(0, Math.ceil(visibleRecords.length / TABLE_PAGE_SIZE) - 1));
    const viewRecords = active.type === 'gallery'
      ? visibleRecords
      : visibleRecords.slice(currentPage * TABLE_PAGE_SIZE, (currentPage + 1) * TABLE_PAGE_SIZE);
    return viewRecords.flatMap((record) => {
      const noteKey = noteKeyForRecord(record);
      const note = noteKey ? noteByKey.get(noteKey) : undefined;
      return imageFields.flatMap((field) =>
        imagePaths(notePropertyEditorValue(note, field)).map((path) => ({ key: `${record.id}:${field.id}:${path}`, path })));
    });
  }, [activeViewId, document, noteByKey, tablePage, visibleRecords]);
  const imageReferencesSignature = candidateImageReferences.map(({ key, path }) => `${key}\u0000${path}`).join('\u0001');
  const stableImageReferencesRef = useRef<{ signature: string; references: typeof candidateImageReferences }>({ signature: '', references: [] });
  if (stableImageReferencesRef.current.signature !== imageReferencesSignature) {
    stableImageReferencesRef.current = { signature: imageReferencesSignature, references: candidateImageReferences };
  }
  const imageReferences = stableImageReferencesRef.current.references;

  useEffect(() => {
    let cancelled = false;
    const next: Record<string, string | null> = {};
    const imagesByPath = new Map<string, Promise<string | null>>();
    void asyncMapLimit(imageReferences, 4, async ({ key, path }) => {
      const absolutePath = notebookPath ? joinNotebookMemoPath(notebookPath, path) : path;
      if (!absolutePath) {
        next[key] = null;
        return;
      }
      let image = imagesByPath.get(absolutePath);
      if (!image) {
        image = files.readImage(absolutePath, notebookPath ?? undefined).catch(() => null);
        imagesByPath.set(absolutePath, image);
      }
      next[key] = await image;
    }).then(() => { if (!cancelled) setImageUrls(next); });
    return () => { cancelled = true; };
  }, [imageReferences, notebookPath]);

  const noteForRecord = useCallback((record: TableRecord) => {
    const key = noteKeyForRecord(record);
    return key ? noteByKey.get(key) : undefined;
  }, [noteByKey, noteField]);

  const saveAutoCollectCondition = useCallback(async (field: TableField, condition: TableAutoCollectCondition): Promise<boolean> => {
    if (!document || saving || field.type !== 'primary') return false;
    const previous = document.records.auto_collect;
    const resolveFieldId = (fieldName: string) => {
      const normalizedName = fieldName.trim();
      return document.table.fields.find((item) => item.id === normalizedName
        || item.property_key === normalizedName
        || (item.type === 'primary' && normalizedName === '名称')
        || (item.type !== 'primary' && fieldLabel(item, propertyFields, t) === normalizedName))?.id ?? normalizedName;
    };
    const propertyConditions = (condition.property_conditions ?? []).map((item) => ({
      ...item,
      field_id: resolveFieldId(item.field_id),
      value: item.value.trim(),
    })).filter((item) => item.field_id && item.value);
    const fileCondition = Object.fromEntries(Object.entries({
      file_name_contains: condition.file_condition?.file_name_contains?.trim() ?? '',
      file_type: condition.file_condition?.file_type?.trim().replace(/^\./, '') ?? '',
      path_contains: condition.file_condition?.path_contains?.trim() ?? '',
    }).filter(([, value]) => value)) as TableAutoCollectCondition['file_condition'];
    const hasPropertyCriteria = propertyConditions.length > 0;
    const hasFileCriteria = Object.keys(fileCondition ?? {}).length > 0;
    const nextCondition: TableAutoCollectCondition = {
      ...(hasPropertyCriteria ? {
        property_conditions: propertyConditions,
        property_match: condition.property_match ?? 'union',
      } : {}),
      ...(hasFileCriteria ? { file_condition: fileCondition } : {}),
    };
    const hasActiveCriteria = hasFileCriteria || hasPropertyCriteria;
    if (previous && hasActiveCriteria && JSON.stringify(previous.condition) === JSON.stringify(nextCondition)) return true;
    if (!previous && !hasActiveCriteria) return true;
    const nextAutoCollect: TableAutoCollectConfig | null = hasActiveCriteria
      ? {
        condition: nextCondition,
        excluded_note_paths: previous?.excluded_note_paths ?? [],
      }
      : null;
    const next = {
      ...document,
      collection: reviseCollection(document.collection),
      records: { ...document.records, auto_collect: nextAutoCollect },
    };
    return save(next);
  }, [document, propertyFields, save, saving, t]);

  const retryNoteLookup = useCallback(() => { void load(); }, [load]);
  const displayFieldValue = (record: TableRecord, field: TableField): string => {
    if (field.type === 'primary') {
      const note = noteForRecord(record);
      if (note) return note.title || displayTitleFromFilename(note.relativePath);
      if (!record.note_path) return '笔记不存在';
      return notesLoadError ? `无法确认关联：${record.note_path}` : `关联失效：${record.note_path}`;
    }
    const value = notePropertyEditorValue(noteForRecord(record), field);
    if (field.type === 'Select') return field.options?.find((option) => option.id === value)?.label
      ?? (value == null || value === '' ? '—' : String(value));
    if (field.type === 'MultiSelect') return Array.isArray(value)
      ? value.map((id) => field.options?.find((option) => option.id === id)?.label ?? id).join(', ')
      : '—';
    if (Array.isArray(value)) return value.map(String).join(', ');
    return value == null || value === '' ? '—' : String(value);
  };

  const openNotePicker = useCallback((anchorRect: DOMRect, recordId: string | null, calendarDate: { fieldId: string; date: string } | null = null) => {
    setNotePickerAnchorRect(anchorRect);
    setNotePickerRecordId(recordId);
    setNotePickerCalendarDate(calendarDate);
    setSelectedNoteKey(availableNotesRef.current[0]?.relativePath.replace(/\\/g, '/') ?? '');
    setNewNoteTitle('');
    setNotePickerOpen(true);
  }, []);

  const addDraftRecordAndOpenNoteSelector = useCallback(async () => {
    if (!editable || !document || !noteField || saving) return;
    const sequence = loadSequenceRef.current;
    const record: TableRecord = {
      id: `rec_${createUuidV7()}`,
      updated_at: new Date().toISOString(),
      note_path: '',
    };
    const records = [...document.records.data, record];
    setSaving(true);
    try {
      const saved = await save({
        ...document,
        collection: reviseCollection(document.collection),
        records: { ...document.records, data: records },
      }, true, sequence);
      if (!saved || !isCurrentSession(sequence)) return;
      setTablePage(Math.floor(visibleRecords.length / TABLE_PAGE_SIZE));
      setAutoOpenPrimaryRecordId(record.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '新增空行失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [document, editable, isCurrentSession, loadSequenceRef, noteField, save, saving, setSaving, visibleRecords.length]);

  const applyCalendarDateToNote = useCallback(async (note: NoteEntry, calendarDate: { fieldId: string; date: string } | null): Promise<NoteEntry> => {
    if (!calendarDate) return note;
    if (!editable) throw new Error('当前引用为只读，无法修改笔记属性');
    const field = document?.table.fields.find((item) => item.id === calendarDate.fieldId);
    if (field?.type !== 'Date' || !field.property_key) return note;
    const path = notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
    if (!path) throw new Error('无法确定笔记路径，未能设置日期');
    if (!await setDocumentProperties(path, { [field.property_key]: calendarDate.date })) {
      throw new Error('笔记日期未能保存');
    }
    return { ...note, updatedAt: Date.now(), properties: { ...note.properties, [field.property_key]: calendarDate.date } };
  }, [document, editable, notebookPath]);

  const openCalendarNotePopover = useCallback((date: string, anchorRect: DOMRect, fieldId: string) => {
    setCalendarAddAnchorRect(anchorRect);
    setCalendarAddDate({ fieldId, date });
    setCalendarAddTitle('');
    setCalendarAddSearch('');
    setCalendarAddSearchOpen(true);
    setCalendarAddOpen(true);
  }, []);

  const closeCalendarAddPopover = useCallback(() => {
    setCalendarAddOpen(false);
    setCalendarAddAnchorRect(null);
    setCalendarAddDate(null);
    setCalendarAddTitle('');
    setCalendarAddSearch('');
    setCalendarAddSearchOpen(false);
  }, []);

  const createNoteInNotebook = useCallback((title: string) => {
    if (!editable) throw new Error('当前引用为只读，无法新建笔记');
    if (!resolvedNotebookId) throw new Error('无法确定当前笔记本');
    return notesClient.create(resolvedNotebookId, undefined, undefined, title);
  }, [editable, resolvedNotebookId]);

  const createViewForField = useCallback(async (field: TableField | string) => {
    if (!document || !pendingViewType || saving) return;
    const sequence = loadSequenceRef.current;
    const fieldId = typeof field === 'string' ? field : field.id;
    if ((pendingViewType === 'calendar' && typeof field !== 'string' && field.type !== 'Date')
      || (pendingViewType === 'kanban' && (typeof field === 'string' || field.type !== 'Select'))) return;
    const added = addTableView(document, pendingViewType, fieldId);
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      setActiveViewId(added.view.id);
      onActiveViewChange?.(added.view.id);
      setViewAddOpen(false);
      setViewAddStep('kind');
      setPendingViewType(null);
    }
  }, [document, isCurrentSession, loadSequenceRef, onActiveViewChange, pendingViewType, save, saving]);

  const createGalleryView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'gallery');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      setActiveViewId(added.view.id);
      onActiveViewChange?.(added.view.id);
      setViewAddOpen(false);
      setViewAddStep('kind');
      setPendingViewType(null);
    }
  }, [document, isCurrentSession, loadSequenceRef, onActiveViewChange, save, saving]);

  const createDataTableView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'table');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      setActiveViewId(added.view.id);
      onActiveViewChange?.(added.view.id);
      setViewAddOpen(false);
    }
  }, [document, isCurrentSession, loadSequenceRef, onActiveViewChange, save, saving]);

  const toggleTableFieldVisibility = useCallback(async (fieldId: string) => {
    if (!document || saving || fieldId === document.table.primary_field_id) return;
    const view = document.table.views.find((item) => item.id === activeViewId && item.type === 'table');
    if (!view) return;
    const visible = view.config.visible_fields as string[];
    const nextVisible = visible.includes(fieldId) ? visible.filter((id) => id !== fieldId) : [...visible, fieldId];
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      table: {
        ...document.table,
        views: document.table.views.map((item) => item.id === view.id
          ? { ...item, config: { ...item.config, visible_fields: nextVisible } }
          : item),
      },
    };
    await save(next);
  }, [activeViewId, document, save, saving]);

  const beginRenameView = useCallback((view: TableView) => {
    setEditingViewName(view.name);
    setEditingViewId(view.id);
  }, []);

  const renameView = useCallback(async (view: TableView, rawName: string) => {
    setEditingViewId(null);
    if (!document || saving) return;
    const trimmedName = rawName.trim();
    if (!trimmedName) {
      toast.error(t('multidimensionalTable.view.nameRequired'));
      return;
    }
    if (trimmedName === view.name) return;
    if (document.table.views.some((item) => item.id !== view.id && item.name === trimmedName)) {
      toast.error(t('multidimensionalTable.view.nameExists'));
      return;
    }
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      table: { ...document.table, views: document.table.views.map((item) => item.id === view.id ? { ...item, name: trimmedName } : item) },
    };
    await save(next, false, loadSequenceRef.current);
  }, [document, loadSequenceRef, save, saving, t]);

  const deleteView = useCallback(async (view: TableView) => {
    if (!editable || !canDeleteViews || !document || saving || document.table.views.length <= 1) return;
    if (!window.confirm(t('multidimensionalTable.view.deleteConfirm', { name: view.name }))) return;
    const sequence = loadSequenceRef.current;
    const views = document.table.views.filter((item) => item.id !== view.id);
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      table: { ...document.table, views },
    };
    if (await save(next, false, sequence) && isCurrentSession(sequence) && activeViewId === view.id) {
      const fallbackViewId = views[0]?.id ?? null;
      setActiveViewId(fallbackViewId);
      if (fallbackViewId) onActiveViewChange?.(fallbackViewId);
    }
  }, [activeViewId, canDeleteViews, document, editable, isCurrentSession, loadSequenceRef, onActiveViewChange, save, saving, t]);

  const linkSelectedNote = useCallback(async () => {
    if (!editable || !document || !noteField || !selectedNoteKey || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const selectedNote = availableNotesRef.current.find((note) => note.relativePath.replace(/\\/g, '/') === selectedNoteKey);
      const updatedNote = selectedNote ? await applyCalendarDateToNote(selectedNote, notePickerCalendarDate) : null;
      if (!isCurrentSession(sequence)) return;
      if (updatedNote && notePickerCalendarDate) {
        const field = document.table.fields.find((item) => item.id === notePickerCalendarDate.fieldId);
        if (field?.type === 'Date' && field.property_key) {
          setNotes((current) => current.map((note) => note.relativePath.replace(/\\/g, '/') === selectedNoteKey ? updatedNote : note));
        }
      }
      const now = new Date().toISOString();
      const targetRecord = notePickerRecordId ? visibleRecords.find((record) => record.id === notePickerRecordId) : undefined;
      const linkedRecord = targetRecord
        ? { ...targetRecord, updated_at: now, note_path: selectedNoteKey }
        : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: selectedNoteKey };
      const records = upsertTableRecord(document.records.data, linkedRecord);
      const next: MultidimensionalTableDocument = { ...document, collection: reviseCollection(document.collection), records: { ...document.records, data: records } };
      setNotePickerOpen(false);
      setNotePickerRecordId(null);
      setNotePickerCalendarDate(null);
      const saved = await save(next, true, sequence);
      if (saved && isCurrentSession(sequence) && !notePickerRecordId) setTablePage(Math.floor((next.records.data.length - 1) / TABLE_PAGE_SIZE));
      if (!saved && updatedNote && notePickerCalendarDate) toast.error('笔记日期已修改，但表格关联未保存，请重试关联');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [applyCalendarDateToNote, document, editable, isCurrentSession, loadSequenceRef, noteField, notePickerCalendarDate, notePickerRecordId, save, saving, selectedNoteKey, setNotes, setSaving, visibleRecords]);

  const replaceLinkedNote = useCallback((recordId: string, noteKey: string) => {
    if (!document || !noteField || saving) return;
    const now = new Date().toISOString();
    const targetRecord = visibleRecords.find((record) => record.id === recordId);
    if (!targetRecord) return;
    const records = upsertTableRecord(document.records.data, { ...targetRecord, updated_at: now, note_path: noteKey });
    void save({ ...document, collection: reviseCollection(document.collection), records: { ...document.records, data: records } });
  }, [document, noteField, save, saving, visibleRecords]);

  const createAndLinkRecordNote = useCallback(async (recordId: string, title: string): Promise<boolean> => {
    const noteTitle = title.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !noteTitle || saving) return false;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(noteTitle);
      if (!isCurrentSession(sequence)) return false;
      const note = created.entry;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      const now = new Date().toISOString();
      const targetRecord = visibleRecords.find((record) => record.id === recordId);
      if (!targetRecord) return false;
      const records = upsertTableRecord(document.records.data, { ...targetRecord, updated_at: now, note_path: noteKey });
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      return await save({ ...document, collection: reviseCollection(document.collection), records: { ...document.records, data: records } }, true, sequence)
        && isCurrentSession(sequence);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
      return false;
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, noteField, resolvedNotebookId, save, saving, visibleRecords]);

  const handleAutoOpenHandled = useCallback(() => setAutoOpenPrimaryRecordId(null), []);

  const createAndLinkNote = useCallback(async () => {
    const title = newNoteTitle.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !title || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(title);
      if (!isCurrentSession(sequence)) return;
      const note = await applyCalendarDateToNote(created.entry, notePickerCalendarDate);
      const noteKey = note.relativePath.replace(/\\/g, '/');
      const now = new Date().toISOString();
      const targetRecord = notePickerRecordId ? visibleRecords.find((record) => record.id === notePickerRecordId) : undefined;
      const linkedRecord = targetRecord
        ? { ...targetRecord, updated_at: now, note_path: noteKey }
        : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: noteKey };
      const records = upsertTableRecord(document.records.data, linkedRecord);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      setNotePickerOpen(false);
      setNotePickerRecordId(null);
      setNotePickerCalendarDate(null);
      setNewNoteTitle('');
      const saved = await save({ ...document, collection: reviseCollection(document.collection), records: { ...document.records, data: records } }, false, sequence);
      if (saved && isCurrentSession(sequence) && !notePickerRecordId) {
        setTablePage(Math.floor((records.length - 1) / TABLE_PAGE_SIZE));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [applyCalendarDateToNote, createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, newNoteTitle, noteField, notePickerCalendarDate, notePickerRecordId, resolvedNotebookId, save, saving, visibleRecords]);

  const persistCalendarNote = useCallback(async (note: NoteEntry, calendarDate: { fieldId: string; date: string }, sequence: number) => {
    if (!editable || !document || !noteField || !isCurrentSession(sequence)) return false;
    const datedNote = await applyCalendarDateToNote(note, calendarDate);
    if (!isCurrentSession(sequence)) return false;
    const noteKey = datedNote.relativePath.replace(/\\/g, '/');
    const now = new Date().toISOString();
    const record: TableRecord = { id: `rec_${createUuidV7()}`, updated_at: now, note_path: noteKey };
    const records = upsertTableRecord(document.records.data, record);
    setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), datedNote]);
    const saved = await save({ ...document, collection: reviseCollection(document.collection), records: { ...document.records, data: records } }, true, sequence);
    if (saved && isCurrentSession(sequence)) {
      closeCalendarAddPopover();
    }
    return saved;
  }, [applyCalendarDateToNote, closeCalendarAddPopover, document, editable, isCurrentSession, noteField, save, setNotes]);

  const createCalendarNote = useCallback(async () => {
    const title = calendarAddTitle.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !calendarAddDate || !title || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(title);
      if (!isCurrentSession(sequence)) return;
      await persistCalendarNote(created.entry, calendarAddDate, sequence);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [calendarAddDate, calendarAddTitle, createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, noteField, persistCalendarNote, resolvedNotebookId, saving, setSaving]);

  const linkCalendarNote = useCallback(async (note: NoteEntry) => {
    if (!editable || !document || !noteField || !calendarAddDate || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      await persistCalendarNote(note, calendarAddDate, sequence);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [calendarAddDate, document, editable, isCurrentSession, loadSequenceRef, noteField, persistCalendarNote, saving, setSaving]);

  const addField = useCallback((preset?: PropertyPreset) => {
    if (!document || saving) return;
    const propertyKey = (preset?.key ?? newFieldPropertyKey).trim();
    if (!propertyKey) return;
    const normalizedPropertyKey = canonicalizePropertyKey(propertyKey).toLocaleLowerCase();
    if (normalizedPropertyKey === 'flowix_key' || normalizedPropertyKey === 'key'
      || document.table.fields.some((field) => field.property_key
        && canonicalizePropertyKey(field.property_key).toLocaleLowerCase() === normalizedPropertyKey)) {
      toast.error('属性键已存在或属于保留名称');
      return;
    }
    const id = `fld_${createUuidV7()}`;
    const fieldType = preset?.kind ?? newFieldType;
    const optionLabels = preset ? preset.options ?? [] : newFieldOptions;
    const normalizedOptionLabels = [...new Set(optionLabels.map((label) => label.trim()).filter(Boolean))];
    const options = (fieldType === 'Select' || fieldType === 'MultiSelect') && normalizedOptionLabels.length > 0
      ? normalizedOptionLabels.map((label) => ({ id: `opt_${createUuidV7()}`, label }))
      : undefined;
    const field: TableField = {
      id,
      type: fieldType,
      property_key: propertyKey,
      ...(options ? { options } : {}),
    };
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      table: {
        ...document.table,
        fields: [...document.table.fields, field],
        views: document.table.views.map((view) => view.type === 'table'
          ? { ...view, config: { ...view.config, visible_fields: [...view.config.visible_fields as string[], id] } }
          : view),
      },
    };
    setNewFieldOpen(false);
    setNewFieldPropertyKey('');
    setNewFieldOptions([]);
    void save(next);
  }, [document, newFieldOptions, newFieldPropertyKey, newFieldType, save, saving]);

  const saveHeaderFieldEdits = useCallback(async (field: TableField, nameDraft: string, optionsDraft: TableFieldOption[]): Promise<boolean> => {
    if (!document || saving || field.type === 'primary') return false;
    const name = nameDraft.trim();
    const nextOptions = field.type === 'Select' || field.type === 'MultiSelect'
      ? optionsDraft.reduce<TableFieldOption[]>((result, option) => {
        const label = option.label.trim();
        if (label && !result.some((item) => item.label === label)) result.push({ ...option, label });
        return result;
      }, [])
      : undefined;
    const optionsChanged = nextOptions !== undefined
      && JSON.stringify(field.options ?? []) !== JSON.stringify(nextOptions);
    const nameChanged = Boolean(name) && name !== fieldLabel(field, propertyFields, t);
    if (!optionsChanged && !nameChanged) return true;

    let nextField = nameChanged ? { ...field, name } : field;
    if (nextOptions !== undefined) {
      nextField = { ...nextField, options: nextOptions };
      if (nextOptions.length === 0) delete nextField.options;
    }
    const nextDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      table: { ...document.table, fields: document.table.fields.map((item) => item.id === field.id ? nextField : item) },
    };
    if (!await save(nextDocument)) return false;

    if (nextOptions === undefined || !optionsChanged || !field.property_key) return true;
    const migrated = new Map<string, { value: unknown; remove: boolean }>();
    const oldOptions = field.options ?? [];
    const nextOptionsById = new Map(nextOptions.map((option) => [option.id, option]));
    for (const record of visibleRecords) {
      const note = noteForRecord(record);
      if (!note) continue;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      if (migrated.has(noteKey) || !Object.prototype.hasOwnProperty.call(note.properties, field.property_key)) continue;
      const value = note.properties[field.property_key];
      if (field.type === 'Select' && typeof value === 'string') {
        const oldOption = oldOptions.find((option) => option.label === value || option.id === value);
        if (!oldOption) continue;
        const nextOption = nextOptionsById.get(oldOption.id);
        migrated.set(noteKey, nextOption ? { value: nextOption.label, remove: false } : { value: null, remove: true });
      } else if (field.type === 'MultiSelect' && Array.isArray(value)) {
        const nextValue = value.flatMap((item) => {
          if (typeof item !== 'string') return [];
          const oldOption = oldOptions.find((option) => option.label === item || option.id === item);
          return oldOption ? nextOptionsById.has(oldOption.id) ? [nextOptionsById.get(oldOption.id)!.label] : [] : [];
        });
        if (JSON.stringify(value) !== JSON.stringify(nextValue)) migrated.set(noteKey, { value: nextValue, remove: false });
      }
    }
    if (migrated.size === 0) return true;
    const migrationResults = await Promise.all([...migrated].map(async ([noteKey, update]) => {
      const note = notes.find((item) => item.relativePath.replace(/\\/g, '/') === noteKey);
      const path = note && notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
      if (!path) return { noteKey, update, success: false };
      let success = false;
      try {
        success = update.remove
          ? await removeDocumentProperty(path, field.property_key!)
          : await setDocumentProperties(path, { [field.property_key!]: update.value });
      } catch {
        success = false;
      }
      return { noteKey, update, success };
    }));
    const applied = new Map(migrationResults.filter((result) => result.success).map(({ noteKey, update }) => [noteKey, update]));
    if (applied.size > 0) setNotes((current) => current.map((note) => {
      const update = applied.get(note.relativePath.replace(/\\/g, '/'));
      if (!update) return note;
      const properties = { ...note.properties };
      if (update.remove) delete properties[field.property_key!];
      else properties[field.property_key!] = update.value;
      return { ...note, properties };
    }));
    if (migrationResults.some((result) => !result.success)) toast.error('选项已更新，但部分笔记的选项值未能同步');
    return true;
  }, [document, noteForRecord, notes, notebookPath, propertyFields, save, saving, setNotes, t, visibleRecords]);

  const changeFieldType = useCallback(async (field: TableField, type: TableFieldType, optionsOverride?: TableField['options']): Promise<boolean> => {
    if (!document || saving || field.type === 'primary' || type === 'primary' || field.type === type) return false;
    const dependentViews = viewsIncompatibleWithFieldType(document, field.id, type);
    if (dependentViews.length) {
      toast.error(`请先调整依赖此属性的视图：${dependentViews.map((view) => view.name).join('、')}`);
      return false;
    }
    const options = type === 'Select' || type === 'MultiSelect'
      ? optionsOverride?.length
        ? optionsOverride
        : field.options?.length
          ? field.options
        : ['选项 1', '选项 2', '选项 3'].map((label) => ({ id: `opt_${createUuidV7()}`, label }))
      : undefined;
    const multiple = type === 'Image' ? field.type === 'Image' ? Boolean(field.multiple) : true : undefined;
    const incompatibleRecords = visibleRecords.filter((record) => {
      const note = noteForRecord(record);
      const value = note && field.property_key && Object.prototype.hasOwnProperty.call(note.properties, field.property_key)
        ? note.properties[field.property_key] : null;
      return !valueMatchesFieldType(value, type, options, Boolean(multiple));
    });
    if (incompatibleRecords.length) {
      toast.error(`${incompatibleRecords.length} 条记录的现有值与目标类型不兼容，请先修改值`);
      return false;
    }
    return save(changeFieldTypeInDocument(document, field.id, type, options, multiple));
  }, [document, noteForRecord, save, saving, visibleRecords]);

  const applyFieldPreset = useCallback(async (field: TableField, preset: PropertyPreset): Promise<boolean> => {
    if (!document || saving || field.type === 'primary') return false;
    const dependentViews = viewsIncompatibleWithFieldType(document, field.id, preset.kind);
    if (dependentViews.length) {
      toast.error(`请先调整依赖此属性的视图：${dependentViews.map((view) => view.name).join('、')}`);
      return false;
    }
    const propertyKey = preset.key.trim();
    const normalizedKey = canonicalizePropertyKey(propertyKey).toLocaleLowerCase();
    if (!propertyKey || normalizedKey === 'flowix_key' || normalizedKey === 'key'
      || document.table.fields.some((item) => item.id !== field.id && item.property_key
        && canonicalizePropertyKey(item.property_key).toLocaleLowerCase() === normalizedKey)) {
      toast.error('属性键已存在或属于保留名称');
      return false;
    }
    const optionLabels = [...new Set((preset.options ?? []).map((label) => label.trim()).filter(Boolean))];
    const options = (preset.kind === 'Select' || preset.kind === 'MultiSelect') && optionLabels.length > 0
      ? optionLabels.map((label) => ({ id: `opt_${createUuidV7()}`, label }))
      : undefined;
    const nextField: TableField = { ...field, property_key: propertyKey, type: preset.kind };
    delete nextField.name;
    if (options) nextField.options = options;
    else delete nextField.options;
    delete nextField.multiple;
    const incompatibleRecords = visibleRecords.filter((record) => {
      const note = noteForRecord(record);
      const value = note && Object.prototype.hasOwnProperty.call(note.properties, propertyKey)
        ? notePropertyEditorValue(note, nextField)
        : null;
      return !valueMatchesFieldType(value, preset.kind, options, false);
    });
    if (incompatibleRecords.length) {
      toast.error(`${incompatibleRecords.length} 条记录的现有值与该属性预设不兼容，请先修改值`);
      return false;
    }
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      table: { ...document.table, fields: document.table.fields.map((item) => item.id === field.id ? nextField : item) },
    };
    return save(next);
  }, [document, noteForRecord, save, saving, visibleRecords]);

  const deleteField = useCallback(async (field: TableField): Promise<boolean> => {
    if (!document || saving || field.type === 'primary' || field.id === document.table.primary_field_id) return false;
    const dependentViews = viewsRequiringField(document, field.id);
    if (dependentViews.length) {
      toast.error(`请先调整依赖此属性的视图：${dependentViews.map((view) => view.name).join('、')}`);
      return false;
    }
    const autoCollect = document.records.auto_collect;
    if (autoCollect?.condition.property_conditions?.some((item) => item.field_id === field.id)) {
      toast.error('请先调整引用此属性的笔记数据集');
      return false;
    }
    return save(removeField(document, field.id));
  }, [document, save, saving]);

  const deleteRecord = useCallback((recordId: string) => {
    if (!document || saving) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    if (!record) return;
    const primaryField = document.table.fields[0];
    const autoCollect = document.records.auto_collect;
    let nextDocument = document;
    const note = record ? noteForRecord(record) : undefined;
    if (primaryField && record && note && autoCollect
      && noteMatchesAutoCollect(note, document.table.fields, primaryField.id, autoCollect.condition)) {
      const notePath = note.relativePath.replace(/\\/g, '/');
      nextDocument = {
        ...document,
        records: { ...document.records, auto_collect: { ...autoCollect, excluded_note_paths: [...new Set([...autoCollect.excluded_note_paths, notePath])] } },
        collection: document.collection,
      };
    }
    const next = {
      ...nextDocument,
      collection: reviseCollection(document.collection),
      records: { ...nextDocument.records, data: document.records.data.filter((item) => item.id !== recordId) },
    };
    void save(next);
  }, [document, noteForRecord, save, saving, visibleRecords]);

  const updateRecordField = useCallback((recordId: string, fieldId: string, value: unknown) => {
    if (!document) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    const field = document.table.fields.find((item) => item.id === fieldId);
    if (record && field) updateCell(record, noteForRecord(record), field, value);
  }, [document, noteForRecord, updateCell, visibleRecords]);

  const selectImageForCell = useCallback(async (record: TableRecord, note: NoteEntry, field: TableField) => {
    if (field.type !== 'Image' || !editable || saving) return;
    if (!notebookPath || !notebookId) {
      toast.error(t('document.properties.imageUploadFailed'));
      return;
    }
    try {
      const selectedPaths = await dialogs.selectFiles({ accept: 'image/*', multiple: false });
      const sourcePath = selectedPaths?.[0];
      if (!sourcePath) return;
      if (!/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tif|tiff|heic|heif)$/i.test(sourcePath)) {
        toast.error(t('document.properties.imageOnly'));
        return;
      }

      const savedPath = await attachments.saveFromPath(sourcePath, notebookId);
      if (!savedPath) throw new Error('Attachment save returned no path');
      const root = canonicalDirectoryPath(notebookPath);
      const saved = canonicalPath(savedPath);
      const rootPrefix = `${root}/`;
      if (!saved.startsWith(rootPrefix)) throw new Error('Saved image is outside the notebook');
      const relativePath = saved.slice(rootPrefix.length);
      if (!relativePath.startsWith('attachments/')) throw new Error('Saved image is outside attachments');
      updateCell(record, note, field, relativePath);
    } catch (error) {
      console.error('[MultidimensionalTable] Failed to save image:', error);
      toast.error(t('document.properties.imageUploadFailed'));
    }
  }, [editable, notebookId, notebookPath, saving, t, updateCell]);

  const handleRowActionOpenChange = useCallback((open: boolean, recordId: string) => {
    setRowActionRecordId(open ? recordId : null);
  }, []);
  const handleDeleteRecord = useCallback((recordId: string) => {
    setRowActionRecordId(null);
    deleteRecord(recordId);
  }, [deleteRecord]);

  const renameLinkedNote = useCallback(async (_recordId: string, note: NoteEntry, title: string): Promise<NoteEntry | null> => {
    if (!editable || !notebookPath || saving) return null;
    const sequence = loadSequenceRef.current;
    const oldPath = joinNotebookMemoPath(notebookPath, note.relativePath);
    if (!oldPath) return null;
    const identity = ensureFileDisplayIdentity(oldPath);
    setSaving(true);
    try {
      const renamed = await renameMarkdownTitle({
        path: oldPath,
        title,
        scopePath: notebookPath,
        displayId: identity.displayId,
        onPathChanged: (previousPath, nextPath) => replaceExternalDocumentPath(identity.displayId, previousPath, nextPath),
      });
      if (!renamed) return null;
      if (!renamed.changed) return note;
      const parentPath = note.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const nextRelativePath = `${parentPath ? `${parentPath}/` : ''}${renamed.filename}`;
      const updatedNote = { ...note, relativePath: nextRelativePath, title: displayTitleFromFilename(nextRelativePath) };
      if (isCurrentSession(sequence)) {
        setNotes((current) => current.map((item) => item.relativePath.replace(/\\/g, '/') === note.relativePath.replace(/\\/g, '/') ? updatedNote : item));
      }
      return updatedNote;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重命名笔记失败');
      return null;
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [editable, isCurrentSession, loadSequenceRef, notebookPath, saving, setNotes]);

  const openLinkedNote = useCallback((note: NoteEntry) => {
    if (!notebookPath) return;
    const path = joinNotebookMemoPath(notebookPath, note.relativePath);
    if (path) void openBrowserColumnTarget({
      ...createFileBrowserTarget(path, notebookPath),
      notebookId: resolvedNotebookId,
    }, 'open-in-column');
  }, [notebookPath, notebookId, resolvedNotebookId]);

  const activeView = document?.table.views.find((view) => view.id === activeViewId) ?? document?.table.views[0];
  const groupFieldId = activeView?.type === 'kanban' && typeof activeView.config.group_by === 'string' ? activeView.config.group_by : null;
  const groupField = groupFieldId ? document?.table.fields.find((field) => field.id === groupFieldId) : undefined;
  const calendarDateFieldId = activeView?.type === 'calendar' && typeof activeView.config.date_field === 'string' ? activeView.config.date_field : null;
  const calendarDateMetadata = NOTE_CALENDAR_DATE_FIELDS.find((field) => field.id === calendarDateFieldId);
  const calendarField = calendarDateFieldId && !calendarDateMetadata ? document?.table.fields.find((field) => field.id === calendarDateFieldId) : undefined;
  const kanbanGroups = useMemo(() => document && groupField?.type === 'Select'
    ? groupRecordsByValue(visibleRecords, (record) => notePropertyEditorValue(noteForRecord(record), groupField))
    : new Map<string, TableRecord[]>(), [document, groupField, noteForRecord, visibleRecords]);
  const reorderKanbanLane = useCallback(async (sourceOptionId: string, targetOptionId: string, insertAfter: boolean) => {
    if (!document || groupField?.type !== 'Select' || saving || sourceOptionId === targetOptionId) return;
    const options = [...(groupField.options ?? [])];
    const sourceIndex = options.findIndex((option) => option.id === sourceOptionId);
    if (sourceIndex < 0 || !options.some((option) => option.id === targetOptionId)) return;
    const [source] = options.splice(sourceIndex, 1);
    const targetIndex = options.findIndex((option) => option.id === targetOptionId);
    options.splice(targetIndex + (insertAfter ? 1 : 0), 0, source);
    if (options.every((option, index) => option.id === groupField.options?.[index]?.id)) return;
    const updatedField = { ...groupField, options };
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      table: { ...document.table, fields: document.table.fields.map((field) => field.id === groupField.id ? updatedField : field) },
    };
    await save(next);
  }, [document, groupField, save, saving]);
  const dropKanbanRecord = useCallback(async (recordId: string, targetGroupId: string, beforeRecordId: string | null) => {
    if (!editable || !document || groupField?.type !== 'Select' || saving) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    const targetOption = groupField.options?.find((option) => option.id === targetGroupId);
    if (!record || !targetOption) return;
    const isPersistedRecord = document.records.data.some((item) => item.id === recordId);
    const note = noteForRecord(record);
    const sourceGroupId = notePropertyEditorValue(note, groupField);
    if (!isPersistedRecord) {
      if (sourceGroupId === targetGroupId) return;
      const propertyKey = groupField.property_key;
      const path = note && notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
      if (!note || !propertyKey || !path) return;
      const sequence = loadSequenceRef.current;
      setSaving(true);
      try {
        if (!await setDocumentProperties(path, { [propertyKey]: targetOption.label })) throw new Error('笔记的单选属性未能保存');
        if (!isCurrentSession(sequence)) return;
        const noteKey = note.relativePath.replace(/\\/g, '/');
        setNotes((current) => current.map((item) => item.relativePath.replace(/\\/g, '/') === noteKey
          ? { ...item, properties: { ...item.properties, [propertyKey]: targetOption.label } }
          : item));
        toast.success('保存完成');
      } catch (error) {
        if (isCurrentSession(sequence)) toast.error(error instanceof Error ? error.message : '移动笔记失败');
      } finally {
        if (isCurrentSession(sequence)) setSaving(false);
      }
      return;
    }

    const targetGroup = (kanbanGroups.get(targetGroupId) ?? []).filter((item) => item.id !== recordId);
    const recordsWithoutDragged = document.records.data.filter((item) => item.id !== recordId);
    let insertAt = beforeRecordId
      ? recordsWithoutDragged.findIndex((item) => item.id === beforeRecordId)
      : -1;
    if (insertAt < 0) {
      const lastTargetRecord = targetGroup[targetGroup.length - 1];
      const lastTargetIndex = lastTargetRecord
        ? recordsWithoutDragged.findIndex((item) => item.id === lastTargetRecord.id)
        : -1;
      insertAt = lastTargetIndex >= 0 ? lastTargetIndex + 1 : recordsWithoutDragged.length;
    }
    const records = [...recordsWithoutDragged.slice(0, insertAt), record, ...recordsWithoutDragged.slice(insertAt)];
    const orderChanged = records.some((item, index) => item.id !== document.records.data[index]?.id);
    if (!orderChanged && sourceGroupId === targetGroupId) return;

    if (sourceGroupId === targetGroupId) {
      await save({ ...document, collection: reviseCollection(document.collection), records: { ...document.records, data: records } });
      return;
    }

    const propertyKey = groupField.property_key;
    const path = note && notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
    if (!note || !propertyKey || !path) {
      toast.error('找不到关联笔记，无法更新分组属性');
      return;
    }
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      if (!await setDocumentProperties(path, { [propertyKey]: targetOption.label })) {
        throw new Error('笔记的单选属性未能保存');
      }
      if (!isCurrentSession(sequence)) return;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      setNotes((current) => current.map((item) => item.relativePath.replace(/\\/g, '/') === noteKey
        ? { ...item, properties: { ...item.properties, [propertyKey]: targetOption.label } }
        : item));
      if (orderChanged) await save({ ...document, collection: reviseCollection(document.collection), records: { ...document.records, data: records } }, true, sequence);
      else toast.success('保存完成');
    } catch (error) {
      if (isCurrentSession(sequence)) toast.error(error instanceof Error ? error.message : '移动笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [document, editable, groupField, isCurrentSession, kanbanGroups, loadSequenceRef, noteForRecord, notebookPath, save, saving, setNotes, setSaving, visibleRecords]);
  const calendarGroups = useMemo(() => document && calendarDateFieldId
    ? groupRecordsByValue(visibleRecords, (record) => {
      if (calendarDateMetadata) {
        const note = noteForRecord(record);
        return calendarDateKey(calendarDateTimeForTimestamp(note?.[calendarDateMetadata.timestamp]));
      }
      return calendarField ? calendarDateKey(notePropertyEditorValue(noteForRecord(record), calendarField)) : null;
    })
    : new Map<string, TableRecord[]>(), [calendarDateFieldId, calendarDateMetadata, calendarField, document, noteForRecord, visibleRecords]);
  const updateCalendarWeekStart = useCallback(async (weekStart: 0 | 1) => {
    if (!document || activeView?.type !== 'calendar' || saving
      || (activeView.config.week_start === 1 ? 1 : 0) === weekStart) return;
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      table: {
        ...document.table,
        views: document.table.views.map((view) => {
          if (view.id !== activeView.id) return view;
          const config = { ...view.config };
          if (weekStart === 0) delete config.week_start;
          else config.week_start = 1;
          return { ...view, config };
        }),
      },
    };
    await save(next);
  }, [activeView, document, save, saving]);

  if (loadError) {
    return <div className={`flex h-full min-h-0 flex-col items-center justify-center gap-3 p-8 text-center ${embeddedInEditor ? 'rounded-lg border border-[var(--border)] bg-[var(--editor-block-bg)]' : ''}`}>
      <Table2 className="h-8 w-8 text-[var(--muted-foreground)] opacity-70" aria-hidden="true" />
      <div className="text-sm">无法显示多维表格</div>
      {loadError !== '不支持的多维表格文件格式' && <div className="max-w-lg text-xs text-[var(--muted-foreground)]">{loadError}</div>}
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => void load()}>重新加载</Button>
        {embeddedInEditor
          ? onRemoveReference && <Button type="button" variant="outline" size="sm" className="rounded-lg" disabled={!editable} onClick={onRemoveReference}>移除</Button>
          : <Button type="button" variant="outline" size="sm" className="rounded-lg text-[var(--destructive)]" disabled={!editable} onClick={() => window.dispatchEvent(new CustomEvent('flowix:request-delete-external-file', { detail: { filePath, notebookPath } }))}>删除多维表格</Button>}
      </div>
    </div>;
  }
  if (!document) return <TableLoadingSkeleton />;
  if (expectedCollectionId && document.collection.id !== expectedCollectionId) {
    return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
      <Table2 className="h-7 w-7 text-[var(--muted-foreground)]" aria-hidden="true" />
      <div className="text-sm font-medium">引用的表格身份已变化</div>
      <div className="max-w-lg text-xs text-[var(--muted-foreground)]">当前路径对应的多维表格与引用节点保存的 table.id 不一致，请重新选择表格。</div>
    </div>;
  }
  if (initialViewId && !document.table.views.some((view) => view.id === initialViewId)) {
    const replacement = document.table.views[0];
    return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
      <Table2 className="h-7 w-7 text-[var(--muted-foreground)]" aria-hidden="true" />
      <div className="text-sm font-medium">引用的视图已不存在</div>
      <div className="text-xs text-[var(--muted-foreground)]">请选择一个现有视图继续显示。</div>
      {replacement && editable && <Button type="button" variant="outline" size="sm" onClick={() => { setActiveViewId(replacement.id); onActiveViewChange?.(replacement.id); }}>改用“{replacement.name}”</Button>}
    </div>;
  }

  const titleField = document.table.fields.find((field) => field.id === document.table.primary_field_id);
  const tableViewFields = activeView?.type === 'table'
    ? document.table.fields.filter((field) => field.id === document.table.primary_field_id
      || (activeView.config.visible_fields as string[]).includes(field.id))
    : document.table.fields;
  const calendarTitleFieldId = activeView?.type === 'calendar' ? activeView.config.title_field as string : document.table.primary_field_id;
  const galleryFields = activeView?.type === 'gallery'
    ? document.table.fields.filter((field) => field.type !== 'primary'
      && (activeView.config.visible_fields as string[]).includes(field.id))
    : [];
  const viewFieldChoices = pendingViewType
    ? document.table.fields.filter((field) => field.type === (pendingViewType === 'calendar' ? 'Date' : 'Select'))
    : [];
  const pageCount = Math.max(1, Math.ceil(visibleRecords.length / TABLE_PAGE_SIZE));
  const currentPage = Math.min(tablePage, pageCount - 1);
  const visibleTableRecords = visibleRecords.slice(currentPage * TABLE_PAGE_SIZE, (currentPage + 1) * TABLE_PAGE_SIZE);
  const tableDisplayName = document.collection.name;
  const datasetAction = <div className="shrink-0">
    <TableFieldHeader
      field={document.table.fields[0]}
      label="数据集"
      conditionOnly
      showAutoCollect
      notebookPath={notebookPath}
      saving={saving || !editable}
      open={matchingOpen}
      typeChoices={FIELD_TYPE_CHOICES}
      customPresets={tablePresets.custom}
      systemPresets={tablePresets.system}
      t={t}
      typeLabel={(type) => fieldTypeLabel(type, t)}
      typeIconKind={fieldTypeIconKind}
      onOpenChange={setMatchingOpen}
      onSaveEdits={saveHeaderFieldEdits}
      onChangeType={changeFieldType}
      onApplyPreset={applyFieldPreset}
      onDelete={deleteField}
      onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
      autoCollectFields={document.table.fields.map((item) => ({ id: item.id, label: item.type === 'primary' ? '名称' : fieldLabel(item, propertyFields, t) }))}
      autoCollectConfig={document.records.auto_collect}
      onSaveAutoCollect={saveAutoCollectCondition}
      ignoreConditionPanelOutside={fieldPanelHeaderId !== null || newFieldOpen}
      conditionPanelContent={<div className="w-full min-w-0 max-w-full overflow-x-hidden">
        <p className="agent-thread-card__codex-settings-title truncate whitespace-nowrap px-2 py-1.5">字段</p>
        <div className="min-w-0 space-y-0.5">
          {document.table.fields.map((field) => <div key={field.id} className="flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg pl-0 pr-2 hover:bg-[var(--hover-bg)]">
            <div className="min-w-0 flex-1 overflow-hidden">
              <TableFieldHeader
                field={field}
                label={fieldLabel(field, propertyFields, t)}
                compact
                notebookPath={notebookPath}
                saving={saving || !editable}
                open={fieldPanelHeaderId === field.id}
                typeChoices={FIELD_TYPE_CHOICES}
                customPresets={tablePresets.custom}
                systemPresets={tablePresets.system}
                t={t}
                typeLabel={(type) => fieldTypeLabel(type, t)}
                typeIconKind={fieldTypeIconKind}
                onOpenChange={(open) => setFieldPanelHeaderId(open ? field.id : null)}
                onSaveEdits={saveHeaderFieldEdits}
                onChangeType={changeFieldType}
                onApplyPreset={applyFieldPreset}
                onDelete={deleteField}
                onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
                autoCollectFields={document.table.fields.map((item) => ({ id: item.id, label: item.type === 'primary' ? '名称' : fieldLabel(item, propertyFields, t) }))}
                autoCollectConfig={document.records.auto_collect}
                onSaveAutoCollect={saveAutoCollectCondition}
              />
            </div>
                {activeView?.type === 'table' && field.type !== 'primary' && <input type="checkbox" className="ml-auto h-4 w-4 shrink-0 accent-[var(--brand)]" aria-label={`在当前数据表显示${fieldLabel(field, propertyFields, t)}`} checked={(activeView.config.visible_fields as string[]).includes(field.id)} disabled={!editable || saving} onChange={() => void toggleTableFieldVisibility(field.id)} />}
          </div>)}
        </div>
        {canCreateFields && <>
          <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
          <button type="button" disabled={!editable || saving} className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50" onClick={(event) => {
            setNewFieldType('Text');
            setNewFieldTypeMenuOpen(false);
            setNewFieldPresetMenuOpen(false);
            setNewFieldPropertyKey('');
            setNewFieldOptions([]);
            setNewFieldAnchorRect(event.currentTarget.getBoundingClientRect());
            setNewFieldOpen(true);
          }}><Plus className="h-4 w-4" />新建属性</button>
        </>}
      </div>}
    />
  </div>;
  const beginRenameTableFile = () => {
    if (!editable || saving || renamingTableFile || !notebookPath) return;
    setTableNameDraft(tableDisplayName);
    setEditingTableName(true);
  };
  const tableColumnCount = tableViewFields.length + 1;
  const tableFieldWidths = tableViewFields.map((field) => {
    const config = fieldWidthConfig(field.type);
    return { fieldId: field.id, width: config.fitContent ? contentColumnWidths[field.id] ?? config.minWidth : config.columnWidth };
  });
  const tableWidth = `calc(${[...tableFieldWidths.map(({ width }) => typeof width === 'number' ? `${width}px` : width), `${TABLE_ACTION_COLUMN_MIN_WIDTH}px`].join(' + ')})`;
  return <div className="flex h-full min-h-0 flex-col bg-transparent" aria-readonly={!editable}>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <nav className="multidimensional-table__view-nav sticky top-0 z-10 flex min-w-0 shrink-0 items-center gap-1 px-5 py-1" aria-label="表格视图">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <div
            className="flex max-w-[200px] min-w-0 shrink-0 -translate-x-[2px] items-center gap-1.5 pr-2"
            title={tableDisplayName}
            onDoubleClick={editingTableName ? undefined : beginRenameTableFile}
          >
            <NotebookTreeResourceIcon path={filePath} className="h-5 w-5 shrink-0" />
            {editingTableName ? <input
              ref={tableNameInputRef}
              aria-label="多维表格文件名"
              value={tableNameDraft}
              size={Math.max(1, tableNameDraft.length)}
              disabled={renamingTableFile || saving}
              onChange={(event) => setTableNameDraft(event.currentTarget.value)}
              onBlur={(event) => void renameTableFile(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditingTableName(false);
                  setTableNameDraft(tableDisplayName);
                }
              }}
              className="h-7 w-auto min-w-[4ch] max-w-[170px] flex-none [field-sizing:content] border-0 bg-transparent px-0 text-sm font-medium text-[var(--foreground)] outline-none"
            /> : <button
              type="button"
              aria-label={`重命名多维表格：${tableDisplayName}`}
              title={`双击重命名：${tableDisplayName}`}
              disabled={!editable || saving || renamingTableFile || !notebookPath}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'F2') {
                  event.preventDefault();
                  beginRenameTableFile();
                }
              }}
              className="min-w-0 truncate p-0 text-left text-sm font-medium text-[var(--foreground)] disabled:opacity-100"
            >
              {tableDisplayName}
            </button>}
          </div>
          {document.table.views.map((view) => (
            <ContextMenu key={view.id}>
              {editingViewId === view.id ? (
                <div className="relative inline-flex">
                  <input
                    ref={editingViewInputRef}
                    aria-label={t('multidimensionalTable.view.name')}
                    value={editingViewName}
                    disabled={!editable || saving}
                    onChange={(event) => setEditingViewName(event.currentTarget.value)}
                    onBlur={(event) => void renameView(view, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    style={{ width: `${editingViewWidth}px` }}
                    className={`h-7 rounded-md border border-[var(--primary)] bg-[var(--background)] px-2.5 text-sm text-[var(--foreground)] outline-none ${view.id === activeView?.id ? 'font-medium' : ''}`}
                  />
                  <span ref={editingViewMeasureRef} aria-hidden="true" className={`pointer-events-none invisible absolute left-0 top-0 -z-10 whitespace-pre px-2.5 text-sm ${view.id === activeView?.id ? 'font-medium' : ''}`}>
                    {editingViewName || ' '}
                  </span>
                </div>
              ) : (
                <ContextMenuTrigger asChild>
                  <button type="button" disabled={saving} onClick={() => { setActiveViewId(view.id); onActiveViewChange?.(view.id); }} onDoubleClick={() => beginRenameView(view)} className={`rounded-md px-2.5 py-1 text-sm disabled:opacity-50 ${view.id === activeView?.id ? 'bg-[var(--muted)] font-medium text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60'}`}>
                    {view.name}
                  </button>
                </ContextMenuTrigger>
              )}
              <ContextMenuContent className="w-[160px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <ContextMenuItem disabled={!editable || saving} onSelect={() => beginRenameView(view)}>{t('multidimensionalTable.view.rename')}</ContextMenuItem>
                <ContextMenuItem disabled={!editable || !canDeleteViews || saving || document.table.views.length <= 1} className="text-[var(--destructive)]" onSelect={() => void deleteView(view)}>{t('multidimensionalTable.view.delete')}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
          <div className="shrink-0">
            <Popover open={viewAddOpen} onOpenChange={(open) => {
              setViewAddOpen(open);
              if (!open) {
                setViewAddStep('kind');
                setPendingViewType(null);
              }
            }}>
              <PopoverTrigger asChild>
                <button type="button" disabled={!editable || saving} aria-label="添加视图" title="添加视图" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent key={viewAddStep} align="start" side="bottom" sideOffset={5} fitViewport className="w-[160px] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                {viewAddStep === 'kind' ? <div className="space-y-0.5">
                  <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">添加视图</div>
                  <button type="button" disabled={saving} onClick={() => void createDataTableView()} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">数据表</button>
                  <button type="button" disabled={saving} onClick={() => { setPendingViewType('calendar'); setViewAddStep('field'); }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    日历<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                  </button>
                  <button type="button" disabled={saving} onClick={() => { setPendingViewType('kanban'); setViewAddStep('field'); }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    看板<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                  </button>
                  <button type="button" disabled={saving} onClick={() => void createGalleryView()} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    画廊
                  </button>
                </div> : <div className="space-y-0.5">
                  <div className="flex min-w-0 items-center gap-0.5 px-1.5 py-[0.35rem]">
                    <button type="button" aria-label="返回视图类型" className="inline-flex min-h-4 shrink-0 items-center gap-0.5 rounded px-0 text-xs leading-[1.2] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none" onClick={() => { setViewAddStep('kind'); setPendingViewType(null); }}>
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="min-w-0 truncate text-xs leading-[1.2] text-[var(--muted-foreground)]">{pendingViewType === 'calendar' ? '选择日期字段' : '选择单选字段'}</span>
                    </button>
                  </div>
                  {viewFieldChoices.length > 0
                    ? viewFieldChoices.map((field) => <button type="button" key={field.id} disabled={saving} onClick={() => void createViewForField(field)} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                        {fieldLabel(field, propertyFields, t)}
                      </button>)
                    : pendingViewType === 'kanban' && <p className="px-2 py-2 text-xs leading-5 text-[var(--muted-foreground)]">添加单选字段后即可创建看板视图</p>}
                  {pendingViewType === 'calendar' && NOTE_CALENDAR_DATE_FIELDS.map((field) => <button type="button" key={field.id} disabled={saving} onClick={() => void createViewForField(field.id)} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    {field.label}
                  </button>)}
                </div>}
              </PopoverContent>
            </Popover>
          </div>
        </div>
        {!embeddedInEditor && datasetAction}
        {trailingActions ? trailingActions(datasetAction) : embeddedInEditor ? datasetAction : null}
      </nav>
      <OverlayScrollbar horizontalScrollbar={activeView?.type === 'table' || activeView?.type === 'kanban'} className="multidimensional-table__scrollbar--bottom-clearance min-h-0 flex-1" scrollerClassName={`h-full min-h-0 flex flex-col ${activeView?.type === 'kanban' ? 'pr-4' : ''}`} onScroll={() => {
        window.dispatchEvent(new Event('flowix:multidimensional-table-scroll'));
        setHeaderMenuFieldId(null);
        setNewFieldOpen(false);
        setNewFieldAnchorRect(null);
        setNewFieldTypeMenuOpen(false);
        setNewFieldPresetMenuOpen(false);
        setNotePickerOpen(false);
        setNotePickerAnchorRect(null);
        setNotePickerRecordId(null);
        setNotePickerCalendarDate(null);
        closeCalendarAddPopover();
      }}>
      {activeView?.type === 'table' && <div className={`min-w-0 w-full flex-1 pr-4 ${embeddedInEditor ? '' : 'pl-4'}`}>
        {pageCount > 1 && <div className="flex items-center justify-end gap-2 py-2 text-xs text-[var(--muted-foreground)]">
          <span>第 {currentPage + 1} / {pageCount} 页 · 每页 {TABLE_PAGE_SIZE} 条</span>
          <Button type="button" variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setTablePage(currentPage - 1)}>上一页</Button>
          <Button type="button" variant="outline" size="sm" disabled={currentPage >= pageCount - 1} onClick={() => setTablePage(currentPage + 1)}>下一页</Button>
        </div>}
        <table ref={tableElementRef} className="multidimensional-table table-fixed border-collapse text-sm" style={{ width: tableWidth, minWidth: tableWidth, maxWidth: tableWidth }}>
          <colgroup>
            {tableFieldWidths.map(({ fieldId, width }) => <col key={fieldId} style={{ width }} />)}
            <col style={{ width: TABLE_ACTION_COLUMN_MIN_WIDTH }} />
          </colgroup>
          <thead className="sticky top-0 z-[1] bg-[var(--document-bg)] text-left text-sm text-[var(--muted-foreground)]">
            <tr>{tableViewFields.map((field) => <th key={field.id} className={`${fieldColumnWidth(field.type)} border-r border-[var(--border)] bg-[var(--document-bg)] p-0 text-left font-normal`}>
              <TableFieldHeader
                field={field}
                label={fieldLabel(field, propertyFields, t)}
                notebookPath={notebookPath}
                saving={saving || !editable}
                open={headerMenuFieldId === field.id}
                showAutoCollect={field.id === document.table.primary_field_id}
                typeChoices={FIELD_TYPE_CHOICES}
                customPresets={tablePresets.custom}
                systemPresets={tablePresets.system}
                t={t}
                typeLabel={(type) => fieldTypeLabel(type, t)}
                typeIconKind={fieldTypeIconKind}
                onOpenChange={(open) => setHeaderMenuFieldId(open ? field.id : null)}
                onSaveEdits={saveHeaderFieldEdits}
                onChangeType={changeFieldType}
                onApplyPreset={applyFieldPreset}
                onDelete={deleteField}
                onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
                autoCollectFields={document.table.fields.map((item) => ({
                  id: item.id,
                  label: item.type === 'primary' ? '名称' : fieldLabel(item, propertyFields, t),
                }))}
                autoCollectConfig={document.records.auto_collect}
                onSaveAutoCollect={saveAutoCollectCondition}
              />
            </th>)}<th className="multidimensional-table__column-action-header bg-[var(--document-bg)] px-2 text-left" aria-label="表格操作">
              {canCreateFields && <button
                type="button"
                disabled={saving}
                aria-label="添加属性"
                title="添加属性"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
                onClick={(event) => {
                  setNewFieldType('Text');
                  setNewFieldTypeMenuOpen(false);
                  setNewFieldPresetMenuOpen(false);
                  setNewFieldPropertyKey('');
                  setNewFieldOptions([]);
                  setNewFieldAnchorRect(event.currentTarget.getBoundingClientRect());
                  setNewFieldOpen(true);
                }}
              ><Plus className="h-4 w-4" aria-hidden="true" /></button>}
            </th></tr>
          </thead>
          <tbody>{visibleTableRecords.map((record) => {
            const noteKey = noteKeyForRecord(record);
            const note = noteKey ? noteByKey.get(noteKey) : undefined;
            const noteStatus = !noteKey ? 'draft' : note ? 'linked' : notesLoadError ? 'unknown' : 'missing';
            return <TableRecordRow
              key={record.id}
              record={record}
              showBottomBorder
              imagePaths={imagePaths}
              fieldColumnWidth={fieldColumnWidth}
              notePropertyEditorValue={notePropertyEditorValue}
              fields={tableViewFields}
              titleField={titleField}
              note={note}
              isRuleLinked={conditionRecordIds.has(record.id)}
              notebookPath={notebookPath}
              getAvailableNotes={getAvailableNotes}
              subscribeAvailableNotes={subscribeAvailableNotes}
              noteStatus={noteStatus}
              autoOpenPrimaryEditor={autoOpenPrimaryRecordId === record.id}
              imageUrls={imageUrls}
              saving={saving}
              cellStatuses={cellStatusesByRecord.get(record.id) ?? EMPTY_CELL_STATUSES}
              rowActionOpen={rowActionRecordId === record.id}
              onOpenNotePicker={openNotePicker}
              onRetryNoteLookup={retryNoteLookup}
              onReplaceNote={replaceLinkedNote}
              onCreateAndLinkRecordNote={createAndLinkRecordNote}
              onAutoOpenHandled={handleAutoOpenHandled}
              onRenameNote={renameLinkedNote}
              onOpenNote={openLinkedNote}
              onSelectImage={selectImageForCell}
              onUpdateCell={updateCell}
              onDeleteRecord={handleDeleteRecord}
              onRowActionOpenChange={handleRowActionOpenChange}
            />;
          })}
          {visibleRecords.length === 0 && <tr><td colSpan={tableColumnCount} className="border-b border-[var(--border)] px-4 py-3 text-center text-sm text-[var(--muted-foreground)]">未添加内容</td></tr>}
          {(canCreateRecords || showAssociateNoteAction) && <tr>
            <td colSpan={tableColumnCount} className="px-0 py-1.5">
              <button type="button" disabled={!editable || saving || !noteField} onClick={() => void addDraftRecordAndOpenNoteSelector()} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />关联笔记
              </button>
            </td>
          </tr>}
          </tbody>
        </table>
      </div>}
      {activeView?.type === 'kanban' && groupField?.type === 'Select' && <TableKanbanView
        groupField={groupField}
        titleField={titleField ?? document.table.fields[0]}
        records={visibleRecords}
        groups={kanbanGroups}
        renderValue={displayFieldValue}
        onDropRecord={dropKanbanRecord}
        onReorderLane={reorderKanbanLane}
      />}
      {activeView?.type === 'calendar' && calendarDateFieldId && <TableCalendarView
        cursor={calendarCursor}
        onCursorChange={setCalendarCursor}
        days={calendarDays}
        groups={calendarGroups}
        dateFieldId={calendarDateFieldId}
        dateFieldLabel={calendarDateMetadata?.label ?? (calendarField ? fieldLabel(calendarField, propertyFields, t) : '')}
        titleField={document.table.fields.find((field) => field.id === calendarTitleFieldId) ?? noteField ?? document.table.fields[0]}
        renderValue={displayFieldValue}
        dateValueForRecord={(record) => calendarDateMetadata
          ? calendarDateTimeForTimestamp(noteForRecord(record)?.[calendarDateMetadata.timestamp])
          : calendarField ? notePropertyEditorValue(noteForRecord(record), calendarField) : null}
        canMoveRecords={calendarField?.type === 'Date'}
        weekStart={calendarWeekStart}
        onWeekStartChange={updateCalendarWeekStart}
        onMoveRecord={updateRecordField}
        addingNoteDate={calendarAddOpen ? calendarAddDate?.date : null}
        onClickDate={(date, anchorRect) => {
          if (calendarDateMetadata) {
            toast.warning('当前日历按创建/更新日期展示，不可修改');
            return;
          }
          openCalendarNotePopover(date, anchorRect, calendarDateFieldId);
        }}
      />}
      {activeView?.type === 'gallery' && <TableGalleryView
        records={visibleRecords}
        titleField={titleField ?? document.table.fields[0]}
        fields={galleryFields}
        renderValue={displayFieldValue}
        imageUrl={(record, field) => {
          const path = imagePaths(notePropertyEditorValue(noteForRecord(record), field))[0];
          return path ? imageUrls[`${record.id}:${field.id}:${path}`] ?? null : null;
        }}
        onOpenRecord={(record, anchorRect) => {
          const note = noteForRecord(record);
          if (note) openLinkedNote(note);
          else if (notesLoadError) retryNoteLookup();
          else openNotePicker(anchorRect, record.id);
        }}
      />}
      </OverlayScrollbar>
    </div>
    <Popover open={newFieldOpen} onOpenChange={(open) => {
      setNewFieldOpen(open);
      if (!open) {
        setNewFieldAnchorRect(null);
        setNewFieldTypeMenuOpen(false);
        setNewFieldPresetMenuOpen(false);
        addField();
      }
      }} anchorRect={newFieldAnchorRect}>
      <PopoverContent side="left" align="start" sideOffset={6} ignorePopoverOutside={newFieldTypeMenuOpen || newFieldPresetMenuOpen} style={{ zIndex: 160 }} className="max-h-[min(70vh,420px)] w-[213px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl px-0.5 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <div className="mx-1 space-y-1">
          <input autoFocus value={newFieldPropertyKey} onChange={(event) => setNewFieldPropertyKey(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addField(); } }} aria-label="名称" placeholder="名称" className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none" />
          <div className="space-y-1">
            <Popover open={newFieldTypeMenuOpen} onOpenChange={(open) => {
              setNewFieldTypeMenuOpen(open);
              if (open) setNewFieldPresetMenuOpen(false);
            }}>
              <PopoverTrigger asChild>
                <button type="button" disabled={saving} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--hover-bg)] data-[state=open]:text-[var(--foreground)] disabled:opacity-50">
                  <span>类型</span>
                  <span className="flex min-w-0 items-center gap-0 text-[var(--muted-foreground)]">
                    <span className="truncate">{fieldTypeLabel(newFieldType, t)}</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent side="left" align="start" sideOffset={0} ignoreSelectOutside={false} fitViewport style={{ zIndex: 170 }} className="max-h-[min(70vh,420px)] w-[180px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <div className="space-y-1">
                  {FIELD_TYPE_CHOICES.map((type) => <button
                    key={type}
                    type="button"
                    disabled={saving}
                    aria-pressed={newFieldType === type}
                    onClick={() => {
                      setNewFieldType(type);
                      setNewFieldOptions((current) => type === 'Select' || type === 'MultiSelect'
                        ? current.length > 0 ? current : ['']
                        : []);
                      setNewFieldTypeMenuOpen(false);
                    }}
                    className={`flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50 ${newFieldType === type ? 'bg-[var(--muted)] text-[var(--foreground)]' : ''}`}
                  >
                    <FieldTypeIcon kind={fieldTypeIconKind(type)} title={fieldTypeLabel(type, t)} />
                    <span className="truncate">{fieldTypeLabel(type, t)}</span>
                  </button>)}
                </div>
              </PopoverContent>
            </Popover>
            {(newFieldType === 'Select' || newFieldType === 'MultiSelect') && <div>
              <p className="agent-thread-card__codex-settings-title px-0.5">选项</p>
              <div className="space-y-1.5">
                {newFieldOptions.map((option, index) => <div key={index} className="flex min-w-0 items-center gap-1">
                  <input
                    value={option}
                    onChange={(event) => setNewFieldOptions((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      setNewFieldOptions((current) => [...current, '']);
                    }}
                    placeholder={`选项 ${index + 1}`}
                    aria-label={`选项 ${index + 1}`}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none"
                  />
                  <button
                    type="button"
                    aria-label={`删除选项 ${index + 1}`}
                    title="删除选项"
                    onClick={() => setNewFieldOptions((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>)}
              </div>
              <button
                type="button"
                onClick={() => setNewFieldOptions((current) => [...current, ''])}
                className="mt-1.5 flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />添加选项
              </button>
            </div>}
          </div>
          <TablePresetMenu
            customPresets={tablePresets.custom}
            systemPresets={tablePresets.system}
            disabled={saving}
            open={newFieldPresetMenuOpen}
            onOpenChange={(open) => {
              setNewFieldPresetMenuOpen(open);
              if (open) setNewFieldTypeMenuOpen(false);
            }}
            t={t}
            onSelect={(preset) => { setNewFieldPresetMenuOpen(false); addField(preset); }}
            onManage={() => { setNewFieldPresetMenuOpen(false); addField(); setNewFieldOpen(false); void windows.openPreferences('noteSettings'); }}
          />
        </div>
      </PopoverContent>
    </Popover>
    <Popover open={calendarAddOpen} onOpenChange={(open) => {
      if (open) setCalendarAddOpen(true);
      else closeCalendarAddPopover();
    }} anchorRect={calendarAddAnchorRect}>
      <PopoverContent side="bottom" align="start" sideOffset={6} fitViewport className="w-[240px] max-w-[calc(100vw-16px)] rounded-xl px-2 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <div className="multidimensional-table__primary-editor">
          <textarea
            ref={calendarAddTitleInputRef}
            autoFocus
            aria-label="新笔记标题"
            placeholder="输入笔记标题"
            rows={1}
            value={calendarAddTitleInput.value}
            disabled={saving || !resolvedNotebookId}
            className="multidimensional-table__primary-title-input"
            onChange={calendarAddTitleInput.onChange}
            onCompositionStart={calendarAddTitleInput.onCompositionStart}
            onCompositionEnd={calendarAddTitleInput.onCompositionEnd}
            onKeyDown={(event) => {
              if (calendarAddTitleInput.isComposingKeyboardEvent(event.nativeEvent)) {
                if (event.key === 'Escape' || event.key === 'Enter') event.stopPropagation();
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeCalendarAddPopover();
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                void createCalendarNote();
              }
            }}
          />
          <div className="multidimensional-table__primary-editor-actions">
            <button type="button" aria-label="创建并关联笔记" title="创建并关联笔记" disabled={!calendarAddTitle.trim() || saving || !resolvedNotebookId} onMouseDown={(event) => event.preventDefault()} onClick={() => void createCalendarNote()}>
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" aria-label="搜索并添加笔记" aria-expanded={calendarAddSearchOpen} title="搜索并添加笔记" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={() => {
              setCalendarAddSearchOpen((open) => {
                const next = !open;
                if (next) setCalendarAddSearch('');
                return next;
              });
            }}>
              <ArrowsLeftRightIcon size={16} weight="bold" aria-hidden="true" />
            </button>
            <button type="button" aria-label="关闭新增笔记" title="关闭" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={closeCalendarAddPopover}>
              <MinusCircleIcon size={16} weight="bold" aria-hidden="true" />
            </button>
          </div>
          {calendarAddSearchOpen && <div className="min-w-0">
            <input
              autoFocus
              type="search"
              aria-label="搜索并添加笔记"
              placeholder={availableNotes.length ? '搜索并添加笔记' : '没有可添加的笔记'}
              value={calendarAddSearch}
              disabled={saving || availableNotes.length === 0}
              onChange={(event) => setCalendarAddSearch(event.target.value)}
              className="h-8 w-full border-0 bg-transparent px-0 text-sm outline-none placeholder:text-[var(--muted-foreground)]"
            />
            <div role="listbox" aria-label="可添加笔记" className="-mx-1 max-h-48 overflow-y-auto">
              {filteredCalendarNotes.map((note) => <button
                key={note.relativePath}
                type="button"
                role="option"
                aria-selected={false}
                disabled={saving}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void linkCalendarNote(note)}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--hover-bg)] disabled:opacity-50"
                title={note.relativePath}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
                <span className="truncate">{note.title || note.relativePath}</span>
              </button>)}
              {availableNotes.length > 0 && filteredCalendarNotes.length === 0 && <p className="px-1 py-2 text-sm text-[var(--muted-foreground)]">没有匹配的笔记</p>}
              {availableNotes.length === 0 && <p className="px-1 py-2 text-sm text-[var(--muted-foreground)]">所有笔记都已关联</p>}
            </div>
          </div>}
        </div>
      </PopoverContent>
    </Popover>
    <Popover open={notePickerOpen} onOpenChange={(open) => {
      setNotePickerOpen(open);
      if (!open) {
        setNotePickerRecordId(null);
        setNotePickerCalendarDate(null);
      }
    }} anchorRect={notePickerAnchorRect}>
      <PopoverContent side="bottom" align="start" sideOffset={6} fitViewport className="w-[280px] max-w-[calc(100vw-16px)] rounded-xl px-0.5 py-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <div className="mx-1 space-y-3">
          <Select disabled={availableNotes.length === 0 || saving} value={selectedNoteKey} onValueChange={setSelectedNoteKey}>
            <SelectTrigger className="h-8 w-full rounded-lg bg-[var(--background)] focus:border-[var(--border)]">
              <SelectValue placeholder="选择笔记" />
            </SelectTrigger>
            <SelectContent align="start" fitViewport maxHeight={240} className="flowix-preferences-select-content max-w-[calc(100vw-1rem)]">
              {availableNotes.map((note) => <SelectItem key={note.relativePath} value={note.relativePath.replace(/\\/g, '/')}>{note.title || note.relativePath}</SelectItem>)}
            </SelectContent>
          </Select>
          {notesLoadError
            ? <p className="text-sm text-[var(--muted-foreground)]">{notesLoadError}</p>
            : availableNotes.length === 0
              ? <p className="text-sm text-[var(--muted-foreground)]">{notes.length === 0 ? '此笔记本中没有笔记。' : '所有笔记都已关联。'}</p>
              : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setNotePickerOpen(false)}>取消</Button>
            <Button type="button" disabled={!selectedNoteKey || saving || availableNotes.length === 0} onClick={linkSelectedNote}>{notePickerRecordId ? '更换笔记' : '关联笔记'}</Button>
          </div>
          <div className="border-t border-[var(--border)] pt-2">
            <label className="mb-1 block text-sm text-[var(--muted-foreground)]" htmlFor="new-linked-note-title">新建笔记</label>
            <div className="flex gap-2">
              <input id="new-linked-note-title" value={newNoteTitle} onChange={(event) => setNewNoteTitle(event.target.value)} placeholder="输入笔记标题" disabled={saving || !resolvedNotebookId} className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none disabled:opacity-50" />
              <Button type="button" disabled={!newNoteTitle.trim() || saving || !resolvedNotebookId} onClick={() => void createAndLinkNote()}>新建并关联</Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  </div>;
}
