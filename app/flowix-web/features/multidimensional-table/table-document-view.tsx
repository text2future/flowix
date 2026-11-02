'use client';

import { createPortal } from 'react-dom';
import { CollectionNoteFilterSlot } from '@shared/ui/collection-note-filter-slot';

import type { CollectionPanelControls } from '@features/collection/public/panel-api';
import { noteViewOptions, calendarDateChoices } from './note-view-options';
import { CollectionActionsPortal, type CollectionActionsHost } from '@shared/ui/collection-actions';
import { resolveTableView } from './view-selection';
import { useTableViewManagement } from './use-table-view-management';
import { useTableTitle } from './use-table-title';
import { notePropertyEditorValue, isCalendarCreateWritableField } from './table-note-properties';
import { normalizeNoteFilterCondition } from '@features/collection/public/note-filter-api';
import { subscribeCollectionDatasetFilter } from '@features/collection/public/dataset-filter-api';
import { resolveDatasetFilterForLocation } from '@features/collection/dataset-filter-location';
import { NotePropertyImageValue, propertyImagePaths as imagePaths } from '@features/document/properties/image-value-input';
import { DateValueInput } from '@features/document/components/note-properties/date-value-input';
import { ColorValueInput } from '@features/document/properties/color-value-input';
import { IconValueInput } from '@features/document/properties/icon-value-input';
import { MultiSelectValueInput } from '@features/document/properties/multi-select-value-input';
import { SelectValueInput } from '@features/document/properties/select-value-input';
import { PropertyValueTypographyContext, propertyValueTypography } from '@features/document/properties/value-typography';
import { DeletePresetDialog } from '@features/properties/delete-preset-dialog';
import { NoteCreatePicker } from './note-create-picker';
import { collectionSessionKey } from '@/lib/collection-session-key';
import { MultidimensionalTableLoadingSkeleton } from '@shared/ui/multidimensional-table-loading-skeleton';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';

import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';

import { reviseCollection } from '@features/collection/model';
import { useContext, useCallback, useEffect, useImperativeHandle, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { ChevronRight, LoaderCircle, Plus, MousePointerClick, Table2 } from 'lucide-react';
import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import { collections, windows, type NoteEntry } from '@platform/tauri/client';
import { NOTE_COLOR_HEX } from '@features/memo/store';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { canonicalizePropertyKey } from '@features/properties/property-key';
import { getAllPresets, type PropertyPreset } from '@features/document/properties/presets';
import { usePropertyPresets } from '@features/properties/public-api';
import { createFileBrowserTarget } from '@features/workspace/public/browser-column-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { CollectionTitle } from '@features/collection/public/title-api';
import type { FileDisplayIdentity } from '@/lib/file-display-registry';
import { displayTitleFromFilename } from '@/lib/utils';
import { collectionDisplayName } from '@features/collection/model';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { Popover, PopoverContent } from '@shared/ui/popover';
import { useI18n } from '@/lib/i18n';
import { getPropertyTypeDefinition } from '@/lib/property-types';
import {
  createUuidV7,
  addKanbanView,
  addCalendarDateView,
  addTableView,
  type MultidimensionalTableDocument,
  type TableField,
  type TableRecord,
  type TableFieldOption,
  type TableAutoCollectCondition,
  type TableAutoCollectConfig,
  tableAutoCollectConfig,
  withTableAutoCollect,
  canEditTableAutoCollectFilter,
} from './model';
import {
  BUILTIN_TABLE_FIELDS,
  NOTE_CALENDAR_DATE_FIELD_ID,
  builtinPresetValue,
  builtinPresetTableField,
  isBuiltinTableFieldId,
  builtinTableFieldValue,
  builtinTableFieldLabel,
} from './builtin-fields';
import { groupRecordsByValue } from './view-index';
import { noteMatchesCollectionFilter } from './record-filter';
import { applyTableView } from './view-records';
import { useTableImages } from './use-table-images';
import { useTableScrollLoading } from './use-table-scroll-loading';
import { TableCalendarView, TableGalleryView, TableKanbanView } from './table-secondary-views';
import { TableNoteDropOverlay } from './table-note-drop-overlay';
import { TableSortButton, cycleTableSort, tableSortDirection } from './table-sort-button';
import { TableDatasetMenu } from './table-dataset-menu';
import { sortFields } from './field-order';
import { useTableColumnDrag } from './use-table-column-drag';
import { useAutoContentColumnWidths, type AutoColumnContent } from './use-auto-content-column-widths';
import { TableFieldList } from './table-field-list';
import { TableBooleanInput, TableNumberInput, TableRecordRow } from './table-record-row';
import { TableTagValueInput } from './table-tag-value-input';
import { TableTextValueInput } from './table-text-value-input';
import { NOTE_CALENDAR_DATE_FIELDS, useCalendarController } from './use-calendar-controller';
import { TableFieldEditorForm, TableFieldHeader, TablePresetMenu } from './table-field-header';
import { CollectionViewMenu as TableViewMenu, useViewAddWizard } from '@features/collection/public/view-menu-api';
import { TabStripItem } from '@features/collection/public/tab-api';
import { CollectionTabBar, CollectionTabStrip } from '@shared/ui/collection-tab-bar';
import { useTableSession } from './use-table-session';
import { useTableCellWriter, type TableCellSaveStatus } from './use-table-cell-writer';
import { useTableViewSelection } from './use-table-view-selection';
import { toggleDatasetTableFieldVisibility } from './table-commands';
import { IncompatibleViewEmptyState } from './incompatible-view-empty-state';
import { useTableNoteLinking } from './use-table-note-linking';
import { useTableNoteDrop } from './use-table-note-drop';
import { useTableFieldEdits } from './use-table-field-edits';
import { useTableCalendarNotes } from './use-table-calendar-notes';
import { useTableKanban } from './use-table-kanban';
import { CollectionTrackReporter } from './collection-track-reporter';
import {
  calendarDateKey,
  calendarDateTimeForTimestamp,
  EMBEDDED_GALLERY_PAGE_SIZE,
  EMBEDDED_TABLE_PAGE_SIZE,
  FIELD_TYPE_CHOICES,
  fieldLabel,
  fieldTypeIconKind,
  fieldTypeLabel,
  isoDate,
  noteInCollectionSource,
  noteKeyForRecord,
  noteThumbnailUrl,
  resolveTableNoteParentRelativePath,
  SCROLL_PAGE_SIZE,
  TABLE_ACTION_COLUMN_MIN_WIDTH,
  TABLE_FIELD_WIDTHS,
} from './table-view-helpers';


export interface TableDocumentViewProps {
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  filePath: string;
  /** Stable runtime identity for the table file; survives a rename. */
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId: string | null;
  expectedCollectionId?: string | null;
  initialViewId?: string | null;
  onActiveViewChange?: (viewId: string) => void;
  /** Collection shells own the only tab bar and receive note dataset actions here. */
  showNavigation?: boolean;
  collectionActionsHost?: CollectionActionsHost;
  /** Open the collection's asset filter from the shared dataset menu. */
  onOpenAssetFilter?: () => void;
  assetFilterMenu?: ReactNode;
  /** Collection shell routing hook for keeping the note filter action visible while it is open. */
  onDatasetFilterOpenChange?: (open: boolean) => void;
  panelControlsRef?: Ref<CollectionPanelControls>;
  /** 是否渲染 nav 里的集合名称；外壳自带标题头时置 false，避免一个集合出现两个名字。 */
  showNavTitle?: boolean;
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
  /** 集合头图是否展示（无图时是占位）；null = 该入口不提供头图开关。 */
  bannerVisible?: boolean | null;
  /** 切换头图显示 / 隐藏（写入集合属性 banner_hidden）。 */
  onToggleBannerVisibility?: () => void;
  /**
   * 整页滚动模式：集合外壳把「头图 → 标题 → tab 条 → 列表」放进同一个滚动容器，
   * 此时 nav 吸顶（钉在头部）、各层容器不再裁切，表头 thead 吸在 nav 下沿，
   * 宽表的横向滚动交给外层滚动容器承担。
   */
  pageScroll?: boolean;
  /**
   * 当前激活视图的版式（table / gallery / calendar / kanban）与它需要的横向宽度。
   * 外壳用它决定整页滚动轨道要多宽：只有表格需要横向余量（宽表整页横滚），
   * 画廊/日历是流式内容，撑宽了会凭空多出一条横向滚动条。
   */
  onActiveLayoutChange?: (layout: string | null, contentWidth: number | null) => void;
}

const EMPTY_CELL_STATUSES: ReadonlyMap<string, TableCellSaveStatus> = new Map();

export function TableDocumentView(props: TableDocumentViewProps) {
  const sessionKey = collectionSessionKey(props);
  return <TableDocumentViewSession key={sessionKey} {...props} />;
}

function TableDocumentViewSession({ onSurfaceLifecycleReady, reportPresentation, filePath, fileIdentity, notebookPath, notebookId, expectedCollectionId, initialViewId, onActiveViewChange, showNavigation = true, collectionActionsHost, assetFilterMenu, onOpenAssetFilter, onDatasetFilterOpenChange, panelControlsRef, showNavTitle = true, editable = true, canCreateFields = true, canCreateRecords = true, showAssociateNoteAction = canCreateRecords, canDeleteViews = true, embeddedInEditor = false, onRemoveReference, trailingActions, onFilePathChange, bannerVisible = null, onToggleBannerVisibility, pageScroll = false, onActiveLayoutChange }: TableDocumentViewProps) {
  const noteFilterSlot = useContext(CollectionNoteFilterSlot);
  const tablePageSize = embeddedInEditor ? EMBEDDED_TABLE_PAGE_SIZE : SCROLL_PAGE_SIZE;
  const valueTypography = useMemo(() => propertyValueTypography(
    embeddedInEditor ? 'var(--editor-font-size, 16px)' : 'var(--font-size, 16px)',
  ), [embeddedInEditor]);
  const galleryPageSize = embeddedInEditor ? EMBEDDED_GALLERY_PAGE_SIZE : SCROLL_PAGE_SIZE;
  const [currentFilePath, setCurrentFilePath] = useState(filePath);
  useEffect(() => setCurrentFilePath(filePath), [filePath]);
  const { t } = useI18n();
  const { fields: propertyFields } = usePropertyPresets();
  const tablePresets = useMemo(() => {
    const presets = getAllPresets(propertyFields, (key) => t(key));
    return {
      custom: presets.filter((preset) => preset.source === 'custom'),
      system: presets.filter((preset) => preset.source === 'builtin'),
    };
  }, [propertyFields, t]);
  const tableSession = useTableSession({ filePath: currentFilePath, fileIdentity, notebookPath, notebookId, expectedCollectionId, editable });
  const {
    document, loadError, saving, saveFailed, setSaving, reportSaveFailure, notes, setNotes, resolvedNotebookId,
    notesLoadError, load, save: saveSession, flush: flushSession, loadSequenceRef, loadGeneration, isCurrentSession, pendingNotePropertiesRef,
  } = tableSession;
  const collectionFilterFields = useMemo(() => [
    ...(document?.dataset.schema.fields ?? []),
    ...[...tablePresets.system, ...tablePresets.custom].map((preset) => ({
      id: preset.key,
      property_key: preset.key,
      type: preset.kind,
    })),
  ], [document, tablePresets]);
  const latestDocumentRef = useRef(document);
  latestDocumentRef.current = document;
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
      if (!indexedPath || canonicalPath(indexedPath) === canonicalPath(currentFilePath)) return;
      onFilePathChange(indexedPath);
    }).catch(() => undefined);

    return () => { active = false; };
  }, [document, embeddedInEditor, expectedCollectionId, currentFilePath, loadError, notebookId, notebookPath, onFilePathChange]);
  const save = useCallback(async (...args: Parameters<typeof saveSession>) => {
    if (!editable) return false;
    return saveSession(...args);
  }, [editable, saveSession]);
  const { activeViewId, activeView, activateView, selectView } = useTableViewSelection({
    document, initialViewId, editable, saving, save, onActiveViewChange,
  });
  const {
    tabEdit,
    managingViewId, cancelManageViewRename,
    managingViewName, setManagingViewName, manageViewRenameInputRef, closeViewManagement,
    viewPendingDelete, cancelDeleteView, beginRenameView, renameView,
    reorderViews,
    beginManageViewRename, finishManageViewRename, requestDeleteView, confirmDeleteView,
  } = useTableViewManagement({ session: tableSession,
    save, editable, canDeleteViews, activeViewId, activateView });
  /** 右键菜单打开中的 tab（笔记视图 id 或宿主 tab key）：菜单存续期间给 tab 上背景提示。 */
  const [tabMenuKey, setTabMenuKey] = useState<string | null>(null);
  /** 最近一次右键的 tab 宽度：右键 → 重命名时输入框与原 tab 同宽（双击路径直接现场量）。 */
  const tabEditWidthRef = useRef(48);
  const { showTableTitle, toggleTableTitleVisibility, editingTableName, setEditingTableName,
    tableNameDraft, setTableNameDraft, renamingTable, tableNameInputRef, captureTableTitleCaret,
    commitTableTitle, beginEditTableTitle } = useTableTitle({ session: tableSession, filePath: currentFilePath,
      setFilePath: setCurrentFilePath, notebookPath, editable, onFilePathChange });
  /** 「添加视图」的向导状态机（类型 → 选字段 → 保存），收敛成一个对象。 */
  const viewWizard = useViewAddWizard({ onClose: closeViewManagement });
  /** 建视图流程只读这三项；改名/打开等动作都走 `viewWizard`。 */
  const { pendingType: pendingViewType, configuringViewId } = viewWizard;
  const [headerMenuFieldId, setHeaderMenuFieldId] = useState<string | null>(null);
  const [fieldPanelHeaderId, setFieldPanelHeaderId] = useState<string | null>(null);
  const [pendingKanbanOption, setPendingKanbanOption] = useState<TableFieldOption | null>(null);
  const [matchingOpen, setMatchingOpen] = useState(false);
  const [datasetFilterOpen, setDatasetFilterOpen] = useState(false);
  const previousDatasetMenuOpenRef = useRef(matchingOpen);
  useEffect(() => {
    if (previousDatasetMenuOpenRef.current === matchingOpen) return;
    previousDatasetMenuOpenRef.current = matchingOpen;
    onDatasetFilterOpenChange?.(matchingOpen);
  }, [matchingOpen, onDatasetFilterOpenChange]);
  useEffect(() => subscribeCollectionDatasetFilter(currentFilePath, 'notes', () => {
    setMatchingOpen(true);
    setDatasetFilterOpen(true);
  }), [currentFilePath]);
  useImperativeHandle(panelControlsRef, () => ({ openFieldManager() {
    setHeaderMenuFieldId(null); setFieldPanelHeaderId(null); setDatasetFilterOpen(false); setMatchingOpen(true);
  } }), []);
  const [tablePage, setTablePage] = useState(0);
  const [galleryPage, setGalleryPage] = useState(0);
  const recordsScrollerRef = useRef<HTMLDivElement | null>(null);
  const tableDropAreaRef = useRef<HTMLDivElement | null>(null);
  const tableDropTargetId = useId();
  const loadMoreRecordsRef = useRef<HTMLDivElement | null>(null);
  const [pendingTablePageRecordId, setPendingTablePageRecordId] = useState<string | null>(null);
  const { cellStatusesByRecord, updateCell, flush: flushCells } = useTableCellWriter({
    enabled: Boolean(document) && !saving && editable,
    loadGeneration,
    notebookPath,
    loadSequenceRef,
    setNotes,
    pendingNotePropertiesRef,
  });
  const cellSaveStatuses = [...cellStatusesByRecord.values()].flatMap((statuses) => [...statuses.values()]);
  const hasSaveError = saveFailed || cellSaveStatuses.some((status) => status.error);
  const isSaving = saving || renamingTable || cellSaveStatuses.some((status) => status.saving);
  const [showSavedStatus, setShowSavedStatus] = useState(false);
  const wasSavingRef = useRef(isSaving);
  useEffect(() => {
    if (isSaving) {
      wasSavingRef.current = true;
      setShowSavedStatus(false);
      return;
    }
    const wasSaving = wasSavingRef.current;
    wasSavingRef.current = false;
    if (!wasSaving || hasSaveError) {
      if (hasSaveError) setShowSavedStatus(false);
      return;
    }
    setShowSavedStatus(true);
    const timer = window.setTimeout(() => setShowSavedStatus(false), 1000);
    return () => window.clearTimeout(timer);
  }, [hasSaveError, isSaving]);
  useEffect(() => {
    onSurfaceLifecycleReady?.({ status: 'ready', flush: async () => {
      const [sessionSaved, cellsSaved] = await Promise.all([flushSession(), flushCells()]);
      return sessionSaved && cellsSaved;
    } });
    return () => onSurfaceLifecycleReady?.(null);
  }, [flushCells, flushSession, onSurfaceLifecycleReady]);
  const onRemoveReferenceRef = useRef(onRemoveReference);
  onRemoveReferenceRef.current = onRemoveReference;
  const removeReferenceForPresentation = useCallback(() => { onRemoveReferenceRef.current?.(); }, []);
  const hasRemoveReference = Boolean(onRemoveReference);
  useEffect(() => {
    if (!reportPresentation) return;
    const title = document ? collectionDisplayName(currentFilePath, document.collection.placement) : displayTitleFromFilename(currentFilePath);
    if (loadError) {
      const actions = [
        { id: 'retry', label: { key: 'error.retry' }, enabled: true, run: () => load() },
        ...(embeddedInEditor && hasRemoveReference ? [{
          id: 'remove-reference', label: { key: 'multidimensionalTable.removeReference' }, enabled: editable,
          run: removeReferenceForPresentation,
        }] : !embeddedInEditor && document?.collection.placement !== 'folder' ? [{
          id: 'delete-table', label: { key: 'multidimensionalTable.deleteTableFile' }, enabled: editable,
          run: () => { window.dispatchEvent(new CustomEvent('flowix:request-delete-external-file', { detail: { filePath: currentFilePath, notebookPath } })); },
        }] : []),
      ];
      reportPresentation({ title, state: {
        status: 'error',
        message: { key: 'errors.friendly.tableLoad' },
        actions,
      } });
    } else if (!document) {
      reportPresentation({ title, state: {
        status: 'loading', loadingMode: 'blocking', retainContent: true,
      } });
    } else if (expectedCollectionId && document.collection.id !== expectedCollectionId) {
      reportPresentation({ title, state: {
        status: 'unavailable', reason: 'stale-context',
        message: { key: 'multidimensionalTable.referenceIdentityChanged' },
        actions: embeddedInEditor && hasRemoveReference ? [{
          id: 'remove-reference', label: { key: 'multidimensionalTable.removeReference' }, enabled: editable,
          run: removeReferenceForPresentation,
        }] : [],
      } });
    } else {
      reportPresentation({ title, state: { status: 'ready' } });
    }
  }, [currentFilePath, document, editable, embeddedInEditor, expectedCollectionId, hasRemoveReference, load, loadError, notebookPath, removeReferenceForPresentation, reportPresentation]);

  const [autoOpenPrimaryRecordId, setAutoOpenPrimaryRecordId] = useState<string | null>(null);
  const conditionRecordIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    setTablePage(0);
    setGalleryPage(0);
  }, [loadGeneration]);

  const noteField = document?.dataset.schema.fields[0];
  const noteByKey = useMemo(() => new Map(notes.map((note) => [note.relativePath.replace(/\\/g, '/'), note])), [notes]);
  const calendarController = useCalendarController({ document, activeView, editable, saving, save });
  const {
    dateFieldId: calendarDateFieldId,
    dateMetadata: calendarDateMetadata,
    weekStart: calendarWeekStart,
    isReadOnly: calendarReadOnly,
    updateWeekStart: updateCalendarWeekStart,
    updateDateField: updateCalendarDateField,
    addDialog: calendarAddDialog,
    openAddDialog: openCalendarAddDialog,
    closeAddDialog: closeCalendarAddPopover,
    setAddDialogOpen: setCalendarAddOpen,
    setTitle: setCalendarAddTitle,
  } = calendarController;
  const calendarField = calendarDateFieldId && !calendarDateMetadata
    ? document?.dataset.schema.fields.find((field) => field.id === calendarDateFieldId) ?? builtinPresetTableField(calendarDateFieldId) ?? undefined
    : undefined;
  const { open: calendarAddOpen, anchorRect: calendarAddAnchorRect, date: calendarAddDate, title: calendarAddTitle } = calendarAddDialog;
  const calendarCreateFields = useMemo(() => {
    if (!document) return [];
    const schemaFields = [...document.dataset.schema.fields];
    for (const fieldId of document.dataset.schema.preset_fields) {
      const presetField = builtinPresetTableField(fieldId);
      if (presetField && !schemaFields.some((field) => field.id === presetField.id)) schemaFields.push(presetField);
    }
    return sortFields(schemaFields.filter(isCalendarCreateWritableField), (field) => field.id, document.dataset.schema.field_order);
  }, [document]);


  const noteForRecord = useCallback((record: TableRecord) => {
    const key = noteKeyForRecord(record);
    return key ? noteByKey.get(key.replace(/\\/g, '/')) : undefined;
  }, [noteByKey]);
  const calendarNoteColorForRecord = useCallback((record: TableRecord) => {
    const color = noteForRecord(record)?.colors[0];
    return color ? NOTE_COLOR_HEX[color] : undefined;
  }, [noteForRecord]);
  const noteIconForRecord = useCallback((record: TableRecord) => noteForRecord(record)?.icon ?? null, [noteForRecord]);
  const noteStatusForRecord = useCallback((record: TableRecord) => {
    const noteKey = noteKeyForRecord(record);
    const note = noteKey ? noteByKey.get(noteKey.replace(/\\/g, '/')) : undefined;
    return !noteKey ? 'draft' as const : note ? 'linked' as const : notesLoadError ? 'unknown' as const : 'missing' as const;
  }, [noteByKey, notesLoadError]);
  const conditionRecords = useMemo(() => {
    if (!document || !noteField) return [];
    const datasetFilter = resolveDatasetFilterForLocation(document.dataset.filter, document.collection.placement, currentFilePath, notebookPath);
    if (datasetFilter == null) return [];

    const linkedPaths = new Set(document.dataset.records.include.map((record) => record.note_path.replace(/\\/g, '/')).filter(Boolean));
    const excludedPaths = new Set([
      ...document.dataset.records.exclude.map((record) => record.note_path),
    ].map((path) => path.replace(/\\/g, '/')));
    return notes.flatMap((note) => {
      const notePath = note.relativePath.replace(/\\/g, '/');
      if (linkedPaths.has(notePath) || excludedPaths.has(notePath)
        || !noteInCollectionSource(notePath, document.dataset.source, currentFilePath, notebookPath)
        || !noteMatchesCollectionFilter(note, collectionFilterFields, noteField.id, datasetFilter)) return [];
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
  }, [collectionFilterFields, currentFilePath, document, noteField, notebookPath, notes]);
  const conditionRecordIds = useMemo(() => new Set(conditionRecords.map((record) => record.id)), [conditionRecords]);
  const scopedExplicitRecords = useMemo(() => document
    ? document.dataset.records.include.filter((record) => noteInCollectionSource(record.note_path, document.dataset.source, currentFilePath, notebookPath))
    : [], [currentFilePath, document, notebookPath]);
  const datasetRecords = useMemo(() => [...scopedExplicitRecords, ...conditionRecords], [conditionRecords, scopedExplicitRecords]);
  const visibleRecords = useMemo(() => document
    ? applyTableView(datasetRecords, activeView, collectionFilterFields, document.dataset.schema.primary_field_id, noteForRecord)
    : datasetRecords, [activeView, collectionFilterFields, datasetRecords, document, noteForRecord]);
  useEffect(() => {
    if (activeView?.layout !== 'table') return;
    if (!pendingTablePageRecordId) return;
    const recordIndex = visibleRecords.findIndex((record) => record.id === pendingTablePageRecordId);
    if (recordIndex < 0) return;
    setTablePage((page) => embeddedInEditor
      ? Math.floor(recordIndex / tablePageSize)
      : Math.max(page, Math.floor(recordIndex / tablePageSize)));
    setPendingTablePageRecordId(null);
  }, [activeView?.layout, embeddedInEditor, pendingTablePageRecordId, tablePageSize, visibleRecords]);
  const tableElementRef = useRef<HTMLTableElement | null>(null);
  const columnDrag = useTableColumnDrag({
    tableRef: tableElementRef,
    scrollerRef: recordsScrollerRef,
    ids: document?.dataset.schema.field_order ?? [],
    primaryId: document?.dataset.schema.primary_field_id,
    disabled: !editable || saving || activeView?.layout !== 'table',
    onStart: () => setHeaderMenuFieldId(null),
    onReorder: async (ids) => {
      const current = latestDocumentRef.current;
      if (!current || !editable || saving) return;
      await save({ ...current, collection: reviseCollection(current.collection),
        dataset: { ...current.dataset, schema: { ...current.dataset.schema, field_order: ids } } });
    },
  });
  const columnSizingRecords = useMemo(() => {
    const pageCount = Math.max(1, Math.ceil(visibleRecords.length / tablePageSize));
  
    const page = Math.min(tablePage, pageCount - 1);
    return visibleRecords.slice(embeddedInEditor ? page * tablePageSize : 0, (page + 1) * tablePageSize);
  }, [embeddedInEditor, tablePage, tablePageSize, visibleRecords]);
  const autoSizedColumns = useMemo<AutoColumnContent[]>(() => {
    if (!document || activeView?.layout !== 'table') return [];
    const visibleIds = activeView.config.visible_fields as string[];
    const fields = [
      ...document.dataset.schema.fields.filter((field) => visibleIds.includes(field.id)),
      ...BUILTIN_TABLE_FIELDS.filter((field) => visibleIds.includes(field.id)).flatMap((field) => {
        const preset = builtinPresetTableField(field.id);
        return [preset ?? { id: field.id, name: field.label, type: field.type, property_key: field.propertyKey ?? field.id }];
      }),
    ];
    return fields.flatMap<AutoColumnContent>((field) => {
      const label = fieldLabel(field, propertyFields, t);
      if (field.type === 'Tag') return [{
        id: field.id,
        label,
        type: 'tags' as const,
        isNoteTags: canonicalizePropertyKey(field.property_key ?? '') === 'tags',
        itemGapWidth: 4.8,
        values: columnSizingRecords.map((record) => {
          const note = noteForRecord(record);
          const value = builtinPresetTableField(field.id) ? builtinPresetValue(field.id, note) : notePropertyEditorValue(note, field);
          return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
        }),
      }];
      if (field.type === 'primary') return [{
        id: field.id,
        label,
        type: 'primary' as const,
        textValues: columnSizingRecords.map((record) => {
          const note = noteForRecord(record);
          const text = note
            ? displayTitleFromFilename(note.relativePath)
            : !record.note_path ? '笔记不存在' : `未找到笔记 ${displayTitleFromFilename(record.note_path)}`;
          return { text, extraWidth: note ? 24 + (conditionRecordIds.has(record.id) ? 15 : 0) : 0 };
        }),
      }];
      if (field.type === 'Select' || field.type === 'MultiSelect') return [{
        id: field.id,
        label,
        type: 'chips' as const,
        extraWidth: 22,
        itemGapWidth: 4,
        values: columnSizingRecords.map((record) => {
          const note = noteForRecord(record);
          const value = builtinPresetTableField(field.id)
            ? builtinPresetValue(field.id, note)
            : notePropertyEditorValue(note, field);
          const optionLabel = (item: unknown) => field.options?.find((option) => option.id === item || option.label === item)?.label ?? String(item);
          if (field.type === 'Select') return value == null || value === '' ? [] : [optionLabel(value)];
          const selected = Array.isArray(value)
            ? value
            : typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
          return selected.map(optionLabel);
        }),
      }];
      return [{
        id: field.id,
        label,
        type: 'text' as const,
        textValues: columnSizingRecords.map((record) => {
          const note = noteForRecord(record);
          const builtinPreset = builtinPresetTableField(field.id);
          const value = builtinPreset
            ? builtinPresetValue(field.id, note)
            : isBuiltinTableFieldId(field.id)
              ? builtinTableFieldValue(field.id, note, notebookPath)
              : notePropertyEditorValue(note, field);
          if (field.type === 'Boolean') return { text: '', extraWidth: 16 };
          if (field.type === 'Icon') return { text: '', extraWidth: value ? 48 : 20 };
          if (field.type === 'Color') {
            const colors = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
            const count = colors.map(String).filter(Boolean).length;
            return { text: '', extraWidth: count ? count * 15 - 6 : 0 };
          }
          if (field.type === 'Image') {
            const hasImage = imagePaths(value).length > 0;
            return { text: hasImage ? '' : t('document.properties.selectImage'), extraWidth: hasImage ? 36 : 0 };
          }
          return {
            text: value == null ? '' : String(value),
            extraWidth: field.type === 'Number'
              ? isBuiltinTableFieldId(field.id) ? 0 : 24
              : field.type === 'Date' && value && !isBuiltinTableFieldId(field.id) ? 20 : 0,
          };
        }),
      }];
    });
  }, [conditionRecordIds, document, activeView, columnSizingRecords, noteForRecord, notebookPath, propertyFields, t]);
  const autoColumnWidths = useAutoContentColumnWidths(tableElementRef, autoSizedColumns);
  const secondaryViewRecords = useMemo(() => activeView?.layout === 'table'
    ? visibleRecords
    : visibleRecords.filter((record) => record.note_path.trim().length > 0), [activeView?.layout, visibleRecords]);
  const linkedNoteKeys = useMemo(() => new Set(visibleRecords
    .map((record) => noteKeyForRecord(record))
    .filter((key): key is string => key !== null)), [visibleRecords]);
  const availableNotes = useMemo(() => notes.filter((note) => !linkedNoteKeys.has(note.relativePath.replace(/\\/g, '/'))), [linkedNoteKeys, notes]);
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
    setTablePage(0);
    setGalleryPage(0);
  }, [activeViewId, embeddedInEditor]);

  const {
    notePickerOpen, setNotePickerOpen,
    notePickerAnchorRect, setNotePickerAnchorRect,
    setNotePickerRecordId,
    setNotePickerCalendarDate,
    newNoteTitle, setNewNoteTitle,
    rowActionRecordId, setRowActionRecordId,
    openNotePicker,
    addDraftRecordAndOpenNoteSelector,
    applyCalendarDateToNote,
    createNoteInNotebook,
    linkSelectedNote,
    replaceLinkedNote,
    createAndLinkRecordNote,
    createAndLinkNote,
    renameLinkedNote,
    deleteRecord,
    updateRecordField,
    selectImageForCell,
    createBlankGalleryNote: createBlankGalleryNoteBase,
    requestDeleteLinkedNote,
  } = useTableNoteLinking({
    session: { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, resolvedNotebookId, setNotes, reportSaveFailure },
    noteField,
    editable, notebookPath, notebookId, currentFilePath, availableNotes,
    visibleRecords, collectionFilterFields, activeViewLayout: activeView?.layout,
    noteForRecord, setPendingTablePageRecordId, setAutoOpenPrimaryRecordId, setTablePage, updateCell,
  });
  const pageCount = Math.max(1, Math.ceil(visibleRecords.length / tablePageSize));
  const currentPage = Math.min(tablePage, pageCount - 1);
  const galleryPageCount = Math.max(1, Math.ceil(secondaryViewRecords.length / galleryPageSize));
  const galleryCurrentPage = Math.min(galleryPage, galleryPageCount - 1);
  const visibleTableRecords = useMemo(() => visibleRecords.slice(
    embeddedInEditor ? currentPage * tablePageSize : 0, (currentPage + 1) * tablePageSize,
  ), [visibleRecords, embeddedInEditor, currentPage, tablePageSize]);
  const nextTableRecordId = visibleRecords[(embeddedInEditor ? currentPage * tablePageSize : 0) + visibleTableRecords.length]?.id ?? null;
  const {
    tableDropPreview,
    previewExternalGalleryDrop,
    addExternalNotesToGallery,
    addExternalNotesToCalendar,
  } = useTableNoteDrop({
    session: { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, resolvedNotebookId, notes, setNotes },
    noteField, editable, notebookPath, currentFilePath, activeView: activeView ?? null, conditionRecords, collectionFilterFields,
    noteForRecord, applyCalendarDateToNote, calendarDateFieldId, calendarField, datasetRecords,
    embeddedInEditor, tablePageSize, galleryPageSize, galleryCurrentPage, currentPage,
    nextTableRecordId, recordsScrollerRef, tableDropAreaRef, tableDropTargetId,
    setTablePage, setGalleryPage,
  });
  const renderedTableRecords = tableDropPreview?.records ?? visibleTableRecords;
  const visibleGalleryRecords = useMemo(() => secondaryViewRecords.slice(
    embeddedInEditor ? galleryCurrentPage * galleryPageSize : 0, (galleryCurrentPage + 1) * galleryPageSize,
  ), [secondaryViewRecords, embeddedInEditor, galleryCurrentPage, galleryPageSize]);
  const scrollPageCount = activeView?.layout === 'gallery' ? galleryPageCount : pageCount;
  const scrollPage = activeView?.layout === 'gallery' ? galleryCurrentPage : currentPage;
  const loadMoreRecords = useCallback(() => {
    const setPage = activeView?.layout === 'gallery' ? setGalleryPage : setTablePage;
    setPage((page) => Math.min(page + 1, scrollPageCount - 1));
  }, [activeView?.layout, scrollPageCount]);
  useTableScrollLoading({
    enabled: !embeddedInEditor && (activeView?.layout === 'table' || activeView?.layout === 'gallery'),
    viewportRoot: pageScroll,
    scrollerRef: recordsScrollerRef, sentinelRef: loadMoreRecordsRef,
    page: scrollPage, pageCount: scrollPageCount, onLoadMore: loadMoreRecords,
  });

  const {
    newFieldOpen, setNewFieldOpen,
    newFieldAnchor, setNewFieldAnchor,
    newFieldPropertyKey, setNewFieldPropertyKey,
    newFieldType, setNewFieldType,
    newFieldTypeMenuOpen, setNewFieldTypeMenuOpen,
    newFieldPresetMenuOpen, setNewFieldPresetMenuOpen,
    datasetPresetMenuOpen, setDatasetPresetMenuOpen,
    newFieldOptions, setNewFieldOptions,
    skipNewFieldSaveOnCloseRef,
    pendingDeleteTarget, setPendingDeleteTarget,
    pendingDeleteTableCount,
    deletingFieldBusy,
    addField,
    removePreset,
    deleteBuiltinField,
    queueHeaderFieldEdits,
    changeFieldType,
    applyFieldPreset,
    deleteField,
    confirmDeleteField,
    openNewFieldEditor,
  } = useTableFieldEdits({
    session: { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, resolvedNotebookId, setNotes, reportSaveFailure, pendingNotePropertiesRef },
    notebookPath, propertyFields, datasetRecords, notesLoadError, noteForRecord,
  });
  const {
    calendarPendingCreatedNoteRef,
    calendarCursor, setCalendarCursor,
    calendarCreatePropertyValues, setCalendarCreatePropertyValues,
    calendarEditingRecord, setCalendarEditingRecord,
    calendarDays,
    openCalendarNotePopover,
    closeCalendarNoteDialog,
    createCalendarNote,
    openCalendarEditPopover,
    saveCalendarNoteEdit,
  } = useTableCalendarNotes({
    session: { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, resolvedNotebookId, setNotes, reportSaveFailure },
    editable, notebookPath,
    calendar: { dateFieldId: calendarDateFieldId, dateMetadata: calendarDateMetadata, openAddDialog: openCalendarAddDialog, closeAddDialog: closeCalendarAddPopover, setTitle: setCalendarAddTitle, addDialog: calendarAddDialog },
    noteField, calendarWeekStart, calendarField, calendarCreateFields, visibleRecords, noteForRecord,
    applyCalendarDateToNote, createNoteInNotebook, renameLinkedNote,
  });
  const imageReferences = useMemo(() => {
    if (!document) return [];
    const active = resolveTableView(document, activeViewId ?? initialViewId);
    if (active?.layout !== 'table' && active?.layout !== 'gallery') return [];
    const visibleFields = active.config.visible_fields as string[];
    const imageFields = document.dataset.schema.fields.filter((field) => field.type === 'Image'
      && (active.layout === 'table' || visibleFields.includes(field.id)));
    const viewRecords = active.layout === 'gallery' ? visibleGalleryRecords : visibleTableRecords;
    return viewRecords.flatMap((record) => {
      const noteKey = noteKeyForRecord(record);
      const note = noteKey ? noteByKey.get(noteKey) : undefined;
      return imageFields.flatMap((field) =>
        imagePaths(notePropertyEditorValue(note, field)).map((path) => ({ key: `${record.id}:${field.id}:${path}`, path })));
    });
  }, [activeViewId, initialViewId, document, noteByKey, visibleGalleryRecords, visibleTableRecords]);

  const imageUrls = useTableImages(imageReferences, notebookPath, loadGeneration);

  const saveAutoCollectCondition = useCallback(async (field: TableField, condition: TableAutoCollectCondition): Promise<boolean> => {
    if (!document || saving || field.type !== 'primary') return false;
    if (!canEditTableAutoCollectFilter(document)) {
      toast.error('当前数据集包含编辑器不支持的规则，未保存以保留原筛选');
      return false;
    }
    const previous = tableAutoCollectConfig(document);
    const nextCondition = normalizeNoteFilterCondition({
      ...condition,
      path: condition.path === undefined ? previous?.condition.path ?? null : condition.path,
    });
    const hasPropertyCriteria = Boolean(nextCondition.property_conditions?.length);
    const hasFileCriteria = Boolean(nextCondition.file_condition?.file_name_contains || nextCondition.file_condition?.file_type);
    const path = nextCondition.path;
    const hasActiveCriteria = hasFileCriteria || hasPropertyCriteria || path !== null;
    if (previous && hasActiveCriteria && JSON.stringify(previous.condition) === JSON.stringify(nextCondition)) return true;
    if (!previous && !hasActiveCriteria && document.dataset.filter == null) return true;
    const nextAutoCollect: TableAutoCollectConfig | null = hasActiveCriteria
      ? {
        condition: nextCondition,
      }
      : null;
    const next = { ...withTableAutoCollect(document, nextAutoCollect), collection: reviseCollection(document.collection) };
    return save(next);
  }, [document, propertyFields, save, saving, t]);

  const saveAutoCollectPath = useCallback(async (path: string | null): Promise<boolean> => {
    if (!document || saving) return false;
    if (document.collection.placement === 'folder') return false;
    if (!canEditTableAutoCollectFilter(document)) {
      toast.error('当前数据集包含编辑器不支持的规则，未保存以保留原筛选');
      return false;
    }
    const previous = tableAutoCollectConfig(document);
    const nextPath = path === null ? '' : path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || null;
    if ((previous?.condition.path ?? null) === nextPath) return true;
    const condition = normalizeNoteFilterCondition({
      ...(previous?.condition ?? {}),
      path: nextPath,
    });
    const hasConditions = Boolean(condition.property_conditions?.length
      || condition.file_condition?.file_name_contains?.trim()
      || condition.file_condition?.file_type);
    const next = withTableAutoCollect(document, nextPath !== null || hasConditions ? { condition } : null);
    return save({ ...next, collection: reviseCollection(document.collection) });
  }, [document, save, saving]);

  const retryNoteLookup = useCallback(() => { void load(); }, [load]);
  const displayFieldValue = (record: TableRecord, field: TableField): string => {
    if (field.type === 'primary') {
      const note = noteForRecord(record);
      if (note) return note.title || displayTitleFromFilename(note.relativePath);
      if (!record.note_path) return '笔记不存在';
      return notesLoadError ? `无法确认关联：${record.note_path}` : `未找到笔记 ${displayTitleFromFilename(record.note_path)}`;
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



  const createViewForField = useCallback(async (field: TableField | string) => {
    if (!document || !pendingViewType || saving) return;
    const sequence = loadSequenceRef.current;
    const fieldId = typeof field === 'string' ? field : field.id;
    if ((pendingViewType === 'calendar' && typeof field !== 'string' && field.type !== 'Date')
      || (pendingViewType === 'kanban' && (typeof field === 'string' || field.type !== 'Select'))) return;
    try {
      const added = pendingViewType === 'calendar' && fieldId === NOTE_CALENDAR_DATE_FIELD_ID
        ? addCalendarDateView(document)
        : addTableView(document, pendingViewType, fieldId);
      if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
        activateView(added.view.id);
        viewWizard.close();
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableView'));
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, pendingViewType, save, saving, viewWizard]);

  const saveConfiguredViewField = useCallback(async (
    viewId: string,
    viewType: 'calendar' | 'kanban',
    fieldId: string,
    dataset = document?.dataset,
  ) => {
    if (!document || !dataset || saving) return false;
    const sequence = loadSequenceRef.current;
    const configKey = viewType === 'calendar' ? 'date_field' : 'group_by';
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      dataset,
      views: { ...document.views, items: document.views.items.map((view) => view.id === viewId
        ? { ...view, config: { ...view.config, [configKey]: fieldId } }
        : view) },
    };
    return await save(next, false, sequence) && isCurrentSession(sequence);
  }, [document, isCurrentSession, loadSequenceRef, save, saving]);

  const selectViewField = useCallback(async (field: TableField | string) => {
    if (!configuringViewId) return createViewForField(field);
    if (!document || !pendingViewType || saving) return;
    let fieldId = typeof field === 'string' ? field : field.id;
    let dataset = document.dataset;
    try {
      if (pendingViewType === 'calendar' && fieldId === NOTE_CALENDAR_DATE_FIELD_ID) {
        const added = addCalendarDateView(document);
        fieldId = added.view.config.date_field as string;
        dataset = added.document.dataset;
      }
      if (await saveConfiguredViewField(configuringViewId, pendingViewType, fieldId, dataset)) {
        viewWizard.close();
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableViewSave'));
    }
  }, [configuringViewId, createViewForField, document, pendingViewType, saveConfiguredViewField, saving, viewWizard]);

  const createKanbanViewForStatus = useCallback(async () => {
    if (!document || pendingViewType !== 'kanban' || saving) return;
    const sequence = loadSequenceRef.current;
    try {
      const added = addKanbanView(document);
      if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
        activateView(added.view.id);
        viewWizard.close();
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableView'));
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, pendingViewType, save, saving, viewWizard]);

  const chooseKanbanStatusField = useCallback(async () => {
    if (!configuringViewId) return createKanbanViewForStatus();
    if (!document || saving) return;
    try {
      const added = addKanbanView(document);
      if (await saveConfiguredViewField(configuringViewId, 'kanban', added.field.id, added.document.dataset)) {
        viewWizard.close();
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableViewSave'));
    }
  }, [configuringViewId, createKanbanViewForStatus, document, saveConfiguredViewField, saving, viewWizard]);

  const createGalleryView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'gallery');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      activateView(added.view.id);
      viewWizard.close();
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, save, saving, viewWizard]);

  const createDataTableView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'table');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      activateView(added.view.id);
      viewWizard.close();
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, save, saving, viewWizard]);

  const toggleTableFieldVisibility = useCallback(async (fieldId: string) => {
    if (!editable || !document || saving) return;
    const next = toggleDatasetTableFieldVisibility(document, fieldId);
    if (next !== document) await save(next);
  }, [document, editable, save, saving]);
  const hideTableField = useCallback(async (fieldId: string) => {
    const currentDocument = latestDocumentRef.current;
    if (!editable || !currentDocument || saving) return;
    const next = toggleDatasetTableFieldVisibility(currentDocument, fieldId);
    if (next !== currentDocument) await save(next);
  }, [editable, save, saving]);

  const toggleColumnSort = useCallback(async (fieldId: string) => {
    if (!editable || !document || saving) return;
    const view = document.views.items.find((item) => item.id === activeViewId && item.layout === 'table');
    if (!view) return;
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => item.id === view.id
        ? { ...item, sort: cycleTableSort(item.sort, fieldId) } : item) },
    };
    if (await save(next)) setTablePage(0);
  }, [activeViewId, document, editable, save, saving]);



  const handleAutoOpenHandled = useCallback(() => setAutoOpenPrimaryRecordId(null), []);















  const handleRowActionOpenChange = useCallback((open: boolean, recordId: string) => {
    setRowActionRecordId(open ? recordId : null);
  }, []);
  const handleDeleteRecord = useCallback((recordId: string) => {
    setRowActionRecordId(null);
    deleteRecord(recordId);
  }, [deleteRecord]);











  const openLinkedNote = useCallback((note: NoteEntry) => {
    if (!notebookPath) return;
    const path = joinNotebookMemoPath(notebookPath, note.relativePath);
    if (path) void openWorkspaceSurface({
      host: 'browser-column',
      target: { ...createFileBrowserTarget(path, notebookPath), notebookId: resolvedNotebookId },
    });
  }, [notebookPath, notebookId, resolvedNotebookId]);
  const openLinkedRecord = useCallback((recordId: string) => {
    const record = visibleRecords.find((item) => item.id === recordId);
    const note = record ? noteForRecord(record) : undefined;
    if (note) openLinkedNote(note);
  }, [noteForRecord, openLinkedNote, visibleRecords]);



  const createBlankGalleryNote = useCallback(async () => {
    const nextNoteNumber = datasetRecords.reduce((max, record) => {
      const title = noteForRecord(record)?.title ?? '';
      const match = /^未命名笔记\s+(\d+)$/.exec(title.trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    await createBlankGalleryNoteBase(nextNoteNumber);
  }, [createBlankGalleryNoteBase, datasetRecords, noteForRecord]);

  const chooseGalleryData = useCallback(() => {
    setDatasetFilterOpen(false);
    setMatchingOpen(true);
  }, []);



  const groupFieldId = activeView?.layout === 'kanban' && typeof activeView.config.group_by === 'string' ? activeView.config.group_by : null;
  const groupField = groupFieldId ? document?.dataset.schema.fields.find((field) => field.id === groupFieldId) : undefined;
  const calendarDateFieldOptions = [
    ...NOTE_CALENDAR_DATE_FIELDS.map(({ id, label }) => ({ id, label, readOnly: true })),
    ...(document?.dataset.schema.preset_fields.includes(NOTE_CALENDAR_DATE_FIELD_ID) ? [{ id: NOTE_CALENDAR_DATE_FIELD_ID, label: '日期' }] : []),
    ...(document?.dataset.schema.fields.filter((field) => field.type === 'Date').map((field) => ({ id: field.id, label: fieldLabel(field, propertyFields, t) })) ?? []),
  ];






  const calendarGroups = useMemo(() => document && calendarDateFieldId
    ? groupRecordsByValue(secondaryViewRecords, (record) => {
      if (calendarDateMetadata) {
        const note = noteForRecord(record);
        return calendarDateKey(calendarDateTimeForTimestamp(note?.[calendarDateMetadata.timestamp]));
      }
      return calendarField ? calendarDateKey(notePropertyEditorValue(noteForRecord(record), calendarField)) : null;
    })
    : new Map<string, TableRecord[]>(), [calendarDateFieldId, calendarDateMetadata, calendarField, document, noteForRecord, secondaryViewRecords]);
  const {
    kanbanGroups,
    addKanbanLane,
    reorderKanbanLane,
    addKanbanTask,
    addExternalNotesToKanban,
    dropKanbanRecord,
    renameKanbanRecord,
  } = useTableKanban({
    session: { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, resolvedNotebookId, notes, setNotes, reportSaveFailure },
    noteField, editable, notebookPath, currentFilePath, groupField, datasetRecords, visibleRecords, secondaryViewRecords,
    noteForRecord, createNoteInNotebook, renameLinkedNote,
    setPendingKanbanOption, setMatchingOpen, setFieldPanelHeaderId,
  });
  // Keep row props stable when loading another batch or updating unrelated UI state.
  const tableViewFields = useMemo(() => {
    const fields = document?.dataset.schema.fields ?? [];
    return activeView?.layout === 'table'
      ? fields.filter((field) => field.id === document?.dataset.schema.primary_field_id
        || (activeView.config.visible_fields as string[]).includes(field.id))
      : fields;
  }, [document?.dataset.schema, activeView]);
  const visibleBuiltinFields = useMemo(() => activeView?.layout === 'table'
    ? BUILTIN_TABLE_FIELDS.filter((field) => (activeView.config.visible_fields as string[]).includes(field.id))
    : [], [activeView]);
  if (loadError) {
    if (reportPresentation) return null;
    return <div className={`flex h-full min-h-0 flex-col items-center justify-center gap-3 p-8 text-center ${embeddedInEditor ? 'rounded-lg border border-[var(--border)] bg-[var(--editor-block-bg)]' : ''}`}>
      <Table2 className="h-8 w-8 text-[var(--muted-foreground)] opacity-70" aria-hidden="true" />
      <div className="text-sm">无法显示多维表格</div>
      {loadError !== '不支持的多维表格文件格式' && <div className="max-w-lg text-xs text-[var(--muted-foreground)]">{t('errors.friendly.tableLoad')}</div>}
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => void load()}>重新加载</Button>
        {embeddedInEditor
          ? onRemoveReference && <Button type="button" variant="outline" size="sm" className="rounded-lg" disabled={!editable} onClick={onRemoveReference}>移除</Button>
          : document?.collection.placement !== 'folder' && <Button type="button" variant="outline" size="sm" className="rounded-lg text-[var(--destructive)]" disabled={!editable} onClick={() => window.dispatchEvent(new CustomEvent('flowix:request-delete-external-file', { detail: { filePath: currentFilePath, notebookPath } }))}>删除多维表格</Button>}
      </div>
    </div>;
  }
  if (!document) return <MultidimensionalTableLoadingSkeleton showSpinner={!reportPresentation} />;
  if (expectedCollectionId && document.collection.id !== expectedCollectionId) {
    if (reportPresentation) return null;
    return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
      <Table2 className="h-7 w-7 text-[var(--muted-foreground)]" aria-hidden="true" />
      <div className="text-sm font-medium">引用的表格身份已变化</div>
      <div className="max-w-lg text-xs text-[var(--muted-foreground)]">当前路径对应的多维表格与引用节点保存的 table.id 不一致，请重新选择表格。</div>
    </div>;
  }

  const titleField = document.dataset.schema.fields.find((field) => field.id === document.dataset.schema.primary_field_id);
  const calendarTitleFieldId = activeView?.layout === 'calendar' ? activeView.config.title_field as string : document.dataset.schema.primary_field_id;
  const galleryFields = activeView?.layout === 'gallery'
    ? document.dataset.schema.fields.filter((field) => field.type !== 'primary'
      && (activeView.config.visible_fields as string[]).includes(field.id))
    : [];
  const { statusField, viewFieldChoices } = noteViewOptions(document, pendingViewType);
  const showAssociateNoteButton = canCreateRecords || showAssociateNoteAction;
  const tableDisplayName = collectionDisplayName(currentFilePath, document.collection.placement);
  const datasetTableViews = document.views.items.filter((view) => view.layout === 'table');
  const datasetFieldChecked = (fieldId: string) => datasetTableViews.length > 0
    && datasetTableViews.every((view) => (view.config.visible_fields as string[]).includes(fieldId));
  const datasetFieldMixed = (fieldId: string) => !datasetFieldChecked(fieldId)
    && datasetTableViews.some((view) => (view.config.visible_fields as string[]).includes(fieldId));
  const datasetFieldVisibilityButton = (fieldId: string, label: string, className = '') => {
    const checked = datasetFieldChecked(fieldId);
    const mixed = datasetFieldMixed(fieldId);
    const action = checked ? '隐藏' : '展示';
    const ariaLabel = mixed ? `部分表格视图中展示，点击后全部展示${label}` : `${action}${label}`;
    return <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      aria-pressed={checked ? true : mixed ? 'mixed' : false}
      disabled={!editable || saving || datasetTableViews.length === 0}
      onClick={() => void toggleTableFieldVisibility(fieldId)}
      className={`${className} inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40`}
    >{checked || mixed
      ? <EyeIcon size={16} weight="bold" className="text-[var(--brand)]" aria-hidden="true" />
      : <EyeSlashIcon size={16} weight="bold" className="text-[var(--muted-foreground)]" aria-hidden="true" />}</button>;
  };
  const presetAlreadyAdded = (preset: PropertyPreset) => {
    const propertyKey = canonicalizePropertyKey(preset.key).toLocaleLowerCase();
    if (document.dataset.schema.fields.some((field) => field.property_key
      && canonicalizePropertyKey(field.property_key).toLocaleLowerCase() === propertyKey)) return true;
    const builtin = BUILTIN_TABLE_FIELDS.find((field) => builtinPresetTableField(field.id)?.property_key === propertyKey);
    return Boolean(builtin && document.dataset.schema.preset_fields.includes(builtin.id));
  };
  const isSystemPresetField = (field: TableField) => tablePresets.system.some((preset) => preset.id === field.id);
  const fixedFolderPath = document.collection.placement === 'folder'
    ? resolveTableNoteParentRelativePath(currentFilePath, notebookPath) ?? ''
    : undefined;
  const storedAutoCollectConfig = tableAutoCollectConfig(document);
  const datasetMenuProps = {
    defaultFieldId: document.dataset.schema.primary_field_id,
    fields: document.dataset.schema.fields.map((item) => ({ id: item.id, label: fieldLabel(item, propertyFields, t), propertyKey: item.property_key, type: item.type, options: item.options })),
    config: fixedFolderPath !== undefined
      ? { condition: { ...(storedAutoCollectConfig?.condition ?? {}), match: storedAutoCollectConfig?.condition.match ?? 'all', path: fixedFolderPath } }
      : storedAutoCollectConfig,
    notebookPath,
    notebookId: resolvedNotebookId,
    fixedFolderPath,
    saving: saving || !editable,
    t,
    onSave: (condition: TableAutoCollectCondition) => saveAutoCollectCondition(document.dataset.schema.fields[0], condition),
    onSavePath: saveAutoCollectPath,
  };

  const closeDatasetSubmenus = () => {
    setDatasetFilterOpen(false);
    setFieldPanelHeaderId(null);
    setDatasetPresetMenuOpen(false);
    setNewFieldTypeMenuOpen(false);
    setNewFieldPresetMenuOpen(false);
    if (newFieldOpen) {
      // Closing the parent menu should discard an unfinished new-field draft.
      skipNewFieldSaveOnCloseRef.current = true;
      setNewFieldOpen(false);
      setNewFieldAnchor(null);
    }
  };
  const openDatasetFieldManager = () => {
    setHeaderMenuFieldId(null);
    setFieldPanelHeaderId(null);
    setDatasetFilterOpen(false);
    setMatchingOpen(true);
  };
  const datasetFieldManagerMenu = () => <button
    type="button"
    onClick={openDatasetFieldManager}
    className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
  >
    <span>字段管理</span>
    <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
  </button>;
  const fieldOrder = document.dataset.schema.field_order;
  const saveFieldOrder = async (ids: string[]) => {
    if (!editable || saving) return;
    await save({ ...document, collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, field_order: ids } } });
  };
  const datasetAction = <div className="flex shrink-0 items-center gap-2">
    {(isSaving || hasSaveError || showSavedStatus) && <span role="status" aria-label={isSaving ? '保存中' : hasSaveError ? '未保存' : '已保存'} className="inline-flex items-center whitespace-nowrap text-xs text-[var(--muted-foreground)]">
      {isSaving ? <LoaderCircle className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" /> : hasSaveError ? '未保存' : '已保存'}
    </span>}
    <TableDatasetMenu
      {...datasetMenuProps}
      filterLabel={collectionActionsHost ? t('collection.filter.notes') : undefined}
      open={matchingOpen}
      onOpenChange={(open) => {
        setMatchingOpen(open);
        if (!open) closeDatasetSubmenus();
      }}
      filterOpen={datasetFilterOpen}
      onFilterOpenChange={setDatasetFilterOpen}
      ignoreOutside={fieldPanelHeaderId !== null || newFieldOpen || datasetPresetMenuOpen}
      assetFilter={assetFilterMenu ?? (onOpenAssetFilter && <button type="button" onClick={() => {
          setDatasetFilterOpen(false);
          setMatchingOpen(false);
          onOpenAssetFilter();
        }} className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)]">
          <span>{t('collection.filter.assets')}</span>
          <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
        </button>)}
      children={<div className="w-full min-w-0 max-w-full space-y-0.5 overflow-x-hidden">
        <p className="agent-thread-card__codex-settings-title truncate whitespace-nowrap px-2 py-1.5">展示字段</p>
        <TableFieldList ids={fieldOrder} primaryId={document.dataset.schema.primary_field_id} activeId={fieldPanelHeaderId} disabled={!editable || saving}
          label={(id) => {
            const field = document.dataset.schema.fields.find((item) => item.id === id);
            return field ? fieldLabel(field, propertyFields, t) : BUILTIN_TABLE_FIELDS.find((item) => item.id === id)?.label ?? id;
          }} onReorder={saveFieldOrder} renderField={(id) => {
            const field = document.dataset.schema.fields.find((item) => item.id === id);
            if (field) return <div key={field.id} className="flex h-full w-full min-w-0 items-center gap-2 overflow-hidden pl-[3px] pr-1.5">
            <div className="min-w-0 flex-1 overflow-hidden">
              <TableFieldHeader
                field={field}
                label={fieldLabel(field, propertyFields, t)}
                systemPreset={isSystemPresetField(field)}
                compact
                hideTypeIcon
                saving={saving || !editable}
                open={fieldPanelHeaderId === field.id}
                pendingOption={field.id === groupField?.id ? pendingKanbanOption : null}
                focusOptionId={field.id === groupField?.id ? pendingKanbanOption?.id : null}
                onOptionFocusHandled={(optionId) => setPendingKanbanOption((current) => current?.id === optionId ? null : current)}
                typeChoices={FIELD_TYPE_CHOICES}
                customPresets={tablePresets.custom}
                systemPresets={tablePresets.system}
                isPresetAdded={presetAlreadyAdded}
                onRemovePreset={removePreset}
                t={t}
                typeLabel={(type) => fieldTypeLabel(type, t)}
                typeIconKind={fieldTypeIconKind}
                onOpenChange={(open) => setFieldPanelHeaderId(open ? field.id : null)}
                onSaveEdits={queueHeaderFieldEdits}
                onChangeType={changeFieldType}
                onApplyPreset={applyFieldPreset}
                onHide={isSystemPresetField(field) ? () => hideTableField(field.id) : undefined}
                onDelete={isSystemPresetField(field) ? undefined : deleteField}
                onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
              />
            </div>
                {field.type !== 'primary' && datasetFieldVisibilityButton(field.id, fieldLabel(field, propertyFields, t), 'ml-auto')}
          </div>;
            const builtin = BUILTIN_TABLE_FIELDS.find((item) => item.id === id);
            if (!builtin) return null;
            const builtinField: TableField = builtinPresetTableField(builtin.id) ?? {
              id: builtin.id,
              type: builtin.iconKind === 'date' ? 'Date' : builtin.iconKind === 'number' ? 'Number' : 'Text',
              property_key: builtin.propertyKey ?? builtin.id,
            };
            return <div key={builtin.id} className="flex h-full w-full min-w-0 items-center gap-2 pl-[3px] pr-1.5 text-sm">
            <div className="min-w-0 flex-1 overflow-hidden">
              <TableFieldHeader
                field={builtinField}
                label={builtinTableFieldLabel(builtin, t)}
                trailingLabel={builtinPresetTableField(builtin.id) ? '预设' : '只读'}
                compact
                hideTypeIcon
                readOnly
                saving={saving || !editable}
                open={fieldPanelHeaderId === builtin.id}
                typeChoices={FIELD_TYPE_CHOICES}
                customPresets={tablePresets.custom}
                systemPresets={tablePresets.system}
                t={t}
                typeLabel={(type) => fieldTypeLabel(type, t)}
                typeIconKind={fieldTypeIconKind}
                onOpenChange={(open) => setFieldPanelHeaderId(open ? builtin.id : null)}
                onSaveEdits={queueHeaderFieldEdits}
                onChangeType={changeFieldType}
                onApplyPreset={applyFieldPreset}
                onDelete={deleteBuiltinField}
                onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
              />
            </div>
            {datasetFieldVisibilityButton(builtin.id, builtinTableFieldLabel(builtin, t))}
          </div>;
          }} />
        {canCreateFields && <>
          <div role="separator" aria-hidden="true" className="mx-2 h-px bg-[var(--border)]" />
          <TablePresetMenu
            triggerLabel="从预设选择"
            triggerIcon={<MousePointerClick className="h-4 w-4" aria-hidden="true" />}
            triggerPadding="px-1.5"
            customGroupLabel={t('preferences.documentProperties.group.mine')}
            customPresets={tablePresets.custom}
            systemPresets={tablePresets.system}
            disabled={!editable || saving}
            open={datasetPresetMenuOpen}
            onOpenChange={setDatasetPresetMenuOpen}
            t={t}
            onSelect={(preset) => { setDatasetPresetMenuOpen(false); addField(preset); }}
            onRemove={removePreset}
            isAdded={presetAlreadyAdded}
            onManage={() => {
              setDatasetPresetMenuOpen(false);
              setMatchingOpen(false);
              void windows.openPreferences('noteSettings');
            }}
          />
          <button type="button" data-state={newFieldOpen ? 'open' : 'closed'} disabled={!editable || saving} className="flex h-8 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] data-[state=open]:bg-[var(--hover-bg)] disabled:opacity-50" onClick={(event) => {
            openNewFieldEditor(event.currentTarget, 'dataset');
          }}><Plus className="h-4 w-4" />新增属性</button>
        </>}
      </div>}
    />
  </div>;
  const tableColumnCount = tableViewFields.length + visibleBuiltinFields.length + 1;
  const tableFieldWidths = tableViewFields.map((field) => ({
    fieldId: field.id,
    width: TABLE_FIELD_WIDTHS[field.type],
  }));
  tableFieldWidths.push(...visibleBuiltinFields.map((field) => ({
    fieldId: field.id,
    width: TABLE_FIELD_WIDTHS[field.type],
  })));
  for (const column of tableFieldWidths) {
    if (autoColumnWidths[column.fieldId] !== undefined) column.width = autoColumnWidths[column.fieldId];
  }
  const orderedTableWidths = sortFields(tableFieldWidths, (field) => field.fieldId, columnDrag.order);
  const tableMinWidth = tableFieldWidths.reduce((total, { width }) => total + width, TABLE_ACTION_COLUMN_MIN_WIDTH);
  /** 表格两侧的留白（外层 `pl-4 pr-4`），算进给外壳的轨道宽度。 */
  const TABLE_SIDE_INSET = 32;
  /**
   * 版式与「表格实际需要的横向宽度」上抛给外壳（整页滚动用）：
   * 表格区带 `container-type: inline-size`，不再向父级贡献 max-content 宽度，
   * 外壳自己量不出来，只能由这里算好传上去。
   */
  const activeLayout = activeView?.layout ?? null;
  const trackContentWidth = activeLayout === 'table' ? tableMinWidth + TABLE_SIDE_INSET : null;
  const viewMenu = <TableViewMenu
          hideTrigger={!showNavigation}
          editable={editable}
          saving={saving}
          canDeleteViews={canDeleteViews}
          wizard={viewWizard}
          display={{
            titleVisible: showTableTitle,
            onToggleTitleVisibility: toggleTableTitleVisibility,
            bannerVisible,
            onToggleBannerVisibility,
          }}
          hostTabs={[]}
          canAddDomainTab={false}
          domainAdditionsDisabled={saving || !notebookPath || !notebookId}
          viewFieldChoices={viewFieldChoices}
          calendarDateChoices={calendarDateChoices}
          onSelectCalendarDateField={(fieldId) => void selectViewField(fieldId)}
          statusField={statusField}
          fieldLabelOf={(field) => fieldLabel(field, propertyFields, t)}
          onCreateTableView={() => void createDataTableView()}
          onCreateGalleryView={() => void createGalleryView()}
          onChooseKanbanStatusField={() => void chooseKanbanStatusField()}
          onCreateKanbanViewForStatus={() => void createKanbanViewForStatus()}
          onSelectViewField={(field) => void selectViewField(field)}
          onOpenDatasetFieldManager={openDatasetFieldManager}
          views={document.views.items}
          onReorderViews={reorderViews}
          managingViewId={managingViewId}
          managingViewName={managingViewName}
          onManagingViewNameChange={setManagingViewName}
          manageViewRenameInputRef={manageViewRenameInputRef}
          onFinishManageViewRename={(view, name) => void finishManageViewRename(view, name)}
          onCancelManageViewRename={cancelManageViewRename}
          onBeginManageViewRename={beginManageViewRename}
          onRequestDeleteView={requestDeleteView}
        />;
  const navigation = <CollectionTabBar
        pinned={pageScroll}
        label={t('collection.tabsLabel')}
        dataTitleVisible={showNavTitle && showTableTitle}
        className={`multidimensional-table__view-nav${embeddedInEditor ? ' px-0' : ''}`}
      >
        {showNavTitle ? <><CollectionTitle kind="table"
          title={tableDisplayName}
          inputLabel="多维表格名称"
          renameLabel="重命名多维表格"
          renameHint="双击重命名"
          edit={{ editing: editingTableName, draft: tableNameDraft, setDraft: setTableNameDraft,
            inputRef: tableNameInputRef, captureCaret: captureTableTitleCaret,
            beginEdit: beginEditTableTitle, commit: commitTableTitle,
            cancel: () => { setEditingTableName(false); setTableNameDraft(tableDisplayName); },
            disabled: !editable || saving || !notebookPath, busy: renamingTable }} />
        <span role="separator" aria-orientation="vertical" className="multidimensional-table__view-nav-separator" /></> : null}
        {/* 宿主 tab 与表格视图 tab 同处一条组：文件树在前，图墙/列表在后。 */}
        <CollectionTabStrip>
          {document.views.items.map((view) => (
            <TabStripItem
              key={view.id}
              label={view.name}
              editId={view.id}
              active={view.id === activeView?.id}
              menuActive={tabMenuKey === view.id}
              editable={editable}
              saving={saving}
              disabled={saving}
              edit={tabEdit}
              onMenuOpenChange={(open) => setTabMenuKey(open ? view.id : null)}
              widthRef={tabEditWidthRef}
              onSelect={() => { void selectView(view.id); }}
              onBeginRename={(width) => beginRenameView(view, width)}
              onCommitRename={(name) => void renameView(view, name)}
              onRequestDelete={() => requestDeleteView(view)}
              deleteDisabled={!editable || !canDeleteViews || saving || document.views.items.length <= 1}
            />
          ))}
        </CollectionTabStrip>
        {/* 「···」更多菜单紧跟在 tab 组之后、滚动区之外：tab 再多也固定可见，
            菜单项仍是添加视图 / 管理全部 tab / 显示标题 / 显示头图。 */}
        {viewMenu}
        {/* 剩余空间由这个空块吸收：tab 少时按钮贴着 tab，右端操作区仍靠窗口右侧。 */}
        <div aria-hidden="true" className="min-w-0 flex-1" />
        {/* 内嵌表格的操作区；工作区集合通过 collectionActionsHost 接收操作。 */}
        {!embeddedInEditor && datasetAction}{trailingActions ? trailingActions(datasetAction) : embeddedInEditor ? datasetAction : null}
      </CollectionTabBar>;
  return <PropertyValueTypographyContext.Provider value={valueTypography}>
    {noteFilterSlot?.target && createPortal(<TableDatasetMenu {...datasetMenuProps}
      filterOnly embedded filterLabel={t('collection.filter.notes')} />, noteFilterSlot.target)}
    {onActiveLayoutChange ? <CollectionTrackReporter layout={activeLayout} contentWidth={trackContentWidth} onChange={onActiveLayoutChange} /> : null}
    <div className={`multidimensional-table__surface ${pageScroll ? 'flex flex-col' : 'flex h-full min-h-0 flex-col'} bg-transparent`} data-page-scroll={pageScroll ? 'true' : undefined} style={valueTypography} aria-readonly={!editable}>
    <DeletePresetDialog
      preset={pendingDeleteTarget?.preset ?? null}
      tableCount={pendingDeleteTableCount}
      busy={deletingFieldBusy}
      onCancel={() => { if (!deletingFieldBusy) setPendingDeleteTarget(null); }}
      onConfirm={() => { void confirmDeleteField(); }}
    />
    <div className={pageScroll ? 'flex flex-col' : 'flex min-h-0 flex-1 flex-col overflow-hidden'}>
      {showNavigation ? navigation : <>
        {viewWizard.open ? viewMenu : null}
        {collectionActionsHost ? <CollectionActionsPortal host={collectionActionsHost}>{datasetAction}</CollectionActionsPortal> : null}
      </>}
      {/* 整页滚动下**按版式**决定这块的滚动角色（见 multidimensional-table.css）：
          表格 / 画廊是流式内容，交给整页滚动（thead 才能吸在 tab 条下沿）；
          日历 / 看板锁在可见区域里自己滚 —— 看板的横向滚动必须留在内部，
          否则整页（连头图、tab 条）会跟着一起横滚。 */}
      <OverlayScrollbar scrollerRef={recordsScrollerRef} horizontalScrollbar={activeView?.layout === 'kanban' || (!pageScroll && activeView?.layout === 'table')} className={`multidimensional-table__scrollbar--bottom-clearance min-h-0 flex-1 ${pageScroll ? `multidimensional-table__records--page-scroll multidimensional-table__records--layout-${activeLayout ?? 'none'}` : ''}`} scrollerClassName="min-h-0 flex h-full flex-col" onScroll={() => {
        window.dispatchEvent(new Event('flowix:multidimensional-table-scroll'));
        setHeaderMenuFieldId(null);
        setNewFieldOpen(false);
        setNewFieldAnchor(null);
        setNewFieldTypeMenuOpen(false);
        setNewFieldPresetMenuOpen(false);
        setDatasetPresetMenuOpen(false);
        setNotePickerOpen(false);
        setNotePickerAnchorRect(null);
        setNotePickerRecordId(null);
        setNotePickerCalendarDate(null);
        closeCalendarAddPopover();
      }}>
      {activeView?.layout === 'table' && <div ref={tableDropAreaRef} className={`relative min-w-0 w-full ${embeddedInEditor ? 'flex-1' : 'shrink-0'} pr-4 ${embeddedInEditor ? '' : 'pl-4'}`}>
        <table ref={tableElementRef} onPointerDown={columnDrag.onPointerDown} onClickCapture={columnDrag.onClickCapture} className="multidimensional-table table-fixed border-collapse text-sm" style={{ width: '100%', minWidth: tableMinWidth }}>
          <colgroup>
            {orderedTableWidths.map(({ fieldId, width }) => <col key={fieldId} style={{ width }} />)}
            {/* The unsized action column absorbs remaining space; tableMinWidth reserves the action column’s minimum width. */}
            <col />
          </colgroup>
          <thead className="sticky top-0 z-[1] bg-[var(--document-bg)] text-left text-sm text-[var(--muted-foreground)]">
            <tr>{sortFields([...tableViewFields.map((field) => <th key={field.id} data-column-field-id={field.id} data-column-drag-preview={columnDrag.draggedId === field.id || undefined} aria-sort={tableSortDirection(activeView.sort, field.id) === 'asc' ? 'ascending' : tableSortDirection(activeView.sort, field.id) === 'desc' ? 'descending' : 'none'} className="group/table-column border-r border-[var(--border)] bg-[var(--document-bg)] p-0 text-left font-normal">
              <div data-state={headerMenuFieldId === field.id ? 'open' : 'closed'} className="multidimensional-table__column-header flex min-w-0 items-center transition-colors hover:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)]">
                <div className="min-w-0 flex-1">
                  <TableFieldHeader
                    field={field}
                    label={fieldLabel(field, propertyFields, t)}
                    systemPreset={isSystemPresetField(field)}
                    saving={saving || !editable}
                    open={headerMenuFieldId === field.id}
                    typeChoices={FIELD_TYPE_CHOICES}
                    customPresets={tablePresets.custom}
                    systemPresets={tablePresets.system}
                    isPresetAdded={presetAlreadyAdded}
                    onRemovePreset={removePreset}
                    t={t}
                    typeLabel={(type) => fieldTypeLabel(type, t)}
                    typeIconKind={fieldTypeIconKind}
                    onOpenChange={(open) => setHeaderMenuFieldId(open ? field.id : null)}
                    onSaveEdits={queueHeaderFieldEdits}
                    onChangeType={changeFieldType}
                    onApplyPreset={applyFieldPreset}
                    onHide={field.type === 'primary' ? undefined : () => hideTableField(field.id)}
                    onDelete={isSystemPresetField(field) ? undefined : deleteField}
                    onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
                    datasetMenu={datasetFieldManagerMenu}
                  />
                </div>
                <TableSortButton label={fieldLabel(field, propertyFields, t)} direction={tableSortDirection(activeView.sort, field.id)} disabled={!editable || saving} onClick={() => void toggleColumnSort(field.id)} />
              </div>
            </th>),
            ...visibleBuiltinFields.map((field) => {
              const builtinSchemaField: TableField = builtinPresetTableField(field.id) ?? {
                id: field.id,
                type: field.type,
                property_key: field.propertyKey ?? field.id,
              };
              return <th key={field.id} data-column-field-id={field.id} data-column-drag-preview={columnDrag.draggedId === field.id || undefined} aria-sort={tableSortDirection(activeView.sort, field.id) === 'asc' ? 'ascending' : tableSortDirection(activeView.sort, field.id) === 'desc' ? 'descending' : 'none'} className="group/table-column border-r border-[var(--border)] bg-[var(--document-bg)] p-0 text-left font-normal">
              <div data-state={headerMenuFieldId === field.id ? 'open' : 'closed'} className="multidimensional-table__column-header flex min-w-0 items-center transition-colors hover:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)]">
                <div className="min-w-0 flex-1">
                  <TableFieldHeader
                    field={builtinSchemaField}
                    label={builtinTableFieldLabel(field, t)}
                    trailingLabel={builtinPresetTableField(field.id) ? '预设' : '只读'}
                    readOnly
                    saving={saving || !editable}
                    open={headerMenuFieldId === field.id}
                    typeChoices={FIELD_TYPE_CHOICES}
                    customPresets={tablePresets.custom}
                    systemPresets={tablePresets.system}
                    t={t}
                    typeLabel={(type) => fieldTypeLabel(type, t)}
                    typeIconKind={fieldTypeIconKind}
                    onOpenChange={(open) => setHeaderMenuFieldId(open ? field.id : null)}
                    onSaveEdits={queueHeaderFieldEdits}
                    onChangeType={changeFieldType}
                    onApplyPreset={applyFieldPreset}
                    onHide={() => hideTableField(field.id)}
                    onDelete={deleteBuiltinField}
                    onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
                    datasetMenu={datasetFieldManagerMenu}
                  />
                </div>
                <TableSortButton label={builtinTableFieldLabel(field, t)} direction={tableSortDirection(activeView.sort, field.id)} disabled={!editable || saving} onClick={() => void toggleColumnSort(field.id)} />
              </div>
            </th>;
            })], (cell) => String(cell.key), columnDrag.order)}
            <th className="multidimensional-table__column-action-header border-r border-[var(--border)] bg-[var(--document-bg)] px-2 text-left" aria-label="表格操作">
              {canCreateFields && <button
                type="button"
                disabled={saving}
                aria-label="添加属性"
                title="添加属性"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
                onClick={(event) => {
                  openNewFieldEditor(event.currentTarget, 'table');
                }}
              ><Plus className="h-4 w-4" aria-hidden="true" /></button>}
            </th></tr>
          </thead>
          <tbody>{renderedTableRecords.map((record) => {
            const noteKey = noteKeyForRecord(record);
            const note = noteKey ? noteByKey.get(noteKey) : undefined;
            const noteStatus = !noteKey ? 'draft' : note ? 'linked' : notesLoadError ? 'unknown' : 'missing';
            const isDropPreview = tableDropPreview?.draggedPaths.includes(record.note_path.replace(/\\/g, '/')) ?? false;
            return <TableRecordRow
              key={record.id}
              record={record}
              isDropPreview={isDropPreview}
              showBottomBorder
              imagePaths={imagePaths}
              notePropertyEditorValue={notePropertyEditorValue}
              fields={tableViewFields}
              builtinFields={visibleBuiltinFields}
              fieldOrder={columnDrag.order}
              allowSwitchNote={document.collection.placement !== 'folder'}
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
              onRetryNoteLookup={retryNoteLookup}
              onReplaceNote={replaceLinkedNote}
              onCreateAndLinkRecordNote={createAndLinkRecordNote}
              onAutoOpenHandled={handleAutoOpenHandled}
              onRenameNote={renameLinkedNote}
              onOpenNote={openLinkedNote}
              onDeleteNote={requestDeleteLinkedNote}
              onSelectImage={selectImageForCell}
              onUpdateCell={updateCell}
              onDeleteRecord={handleDeleteRecord}
              onRowActionOpenChange={handleRowActionOpenChange}
            />;
          })}
          {renderedTableRecords.length === 0 && (
            <tr>
              <td colSpan={tableColumnCount} className="border-b border-[var(--border)] px-4 py-3 text-center text-sm text-[var(--muted-foreground)]">
                添加数据后查看
              </td>
            </tr>
          )}
          </tbody>
        </table>
      </div>}
      {activeView?.layout === 'table' && <TableNoteDropOverlay active={Boolean(tableDropPreview)} dropAreaRef={recordsScrollerRef} />}
      {activeView?.layout === 'kanban' && groupField?.type === 'Select' && <TableKanbanView
        embeddedInEditor={embeddedInEditor}
        groupField={groupField}
        titleField={titleField ?? document.dataset.schema.fields[0]}
        records={secondaryViewRecords}
        groups={kanbanGroups}
        renderValue={displayFieldValue}
        recordStatus={noteStatusForRecord}
        noteIconForRecord={noteIconForRecord}
        onDropRecord={dropKanbanRecord}
        dropNotebookId={resolvedNotebookId}
        canDropExternal={editable && !saving && Boolean(document && noteField && notebookPath && resolvedNotebookId)}
        onExternalNoteDrop={addExternalNotesToKanban}
        onReorderLane={reorderKanbanLane}
        onAddLane={editable ? addKanbanLane : undefined}
        onAddTask={addKanbanTask}
        onOpenRecord={openLinkedRecord}
        onRenameRecord={editable && !saving ? renameKanbanRecord : undefined}
        onDeleteRecord={editable && !saving ? handleDeleteRecord : undefined}
        canAddTask={editable && Boolean(noteField && resolvedNotebookId && notebookPath) && !saving}
        canAddLane={editable && !saving}
      />}
      {activeView?.layout === 'kanban' && groupField?.type !== 'Select' && <IncompatibleViewEmptyState
        title={t('multidimensionalTable.view.incompatibleTitle')}
        titleAction={editable && <button type="button" disabled={saving} onClick={(event) => {
          viewWizard.configureView(activeView.id, 'kanban', event.currentTarget.getBoundingClientRect());
        }} className="inline-flex items-center gap-1 text-sm text-[var(--primary)] hover:underline disabled:opacity-50">
          选择分组<ChevronRight className="size-4" aria-hidden="true" />
        </button>}
        description={groupField
          ? t('multidimensionalTable.view.kanbanFieldTypeMismatch', {
            field: fieldLabel(groupField, propertyFields, t),
            type: groupField.type !== 'primary' ? t(getPropertyTypeDefinition(groupField.type).labelKey) : t('multidimensionalTable.view.missingField'),
          })
          : t('multidimensionalTable.view.kanbanMissingField')}
      />}
      {activeView?.layout === 'calendar' && calendarDateFieldId && (calendarDateMetadata || calendarField?.type === 'Date') && <TableCalendarView
        embeddedInEditor={embeddedInEditor}
        cursor={calendarCursor}
        onCursorChange={setCalendarCursor}
        days={calendarDays}
        groups={calendarGroups}
        dateFieldId={calendarDateFieldId}
        dateFieldLabel={calendarDateMetadata?.label ?? (calendarField ? fieldLabel(calendarField, propertyFields, t) : '')}
        dateFieldOptions={calendarDateFieldOptions}
        onDateFieldChange={calendarController.canChangeDateField ? updateCalendarDateField : undefined}
        onCustomDateField={calendarController.canChangeDateField ? () => setMatchingOpen(true) : undefined}
        titleField={document.dataset.schema.fields.find((field) => field.id === calendarTitleFieldId) ?? noteField ?? document.dataset.schema.fields[0]}
        renderValue={displayFieldValue}
        noteColorForRecord={calendarNoteColorForRecord}
        noteIconForRecord={noteIconForRecord}
        dateValueForRecord={(record) => calendarDateMetadata
          ? calendarDateTimeForTimestamp(noteForRecord(record)?.[calendarDateMetadata.timestamp])
          : calendarField ? notePropertyEditorValue(noteForRecord(record), calendarField) : null}
        canMoveRecords={calendarController.canEditDateValues && calendarField?.type === 'Date'}
        dateFieldReadOnly={calendarReadOnly}
        dateFieldReadOnlyReason={calendarDateMetadata ? `日历按${calendarDateMetadata.label}展示，为只读状态` : '当前多维表格为只读状态'}
        weekStart={calendarWeekStart}
        onWeekStartChange={calendarController.canChangeDateField ? updateCalendarWeekStart : undefined}
        onMoveRecord={updateRecordField}
        dropNotebookId={resolvedNotebookId}
        onExternalNoteDrop={addExternalNotesToCalendar}
        onOpenRecord={openLinkedRecord}
        onEditRecord={openCalendarEditPopover}
        addingNoteDate={calendarAddOpen ? calendarAddDate?.date : null}
        onDoubleClickDate={(date, anchorRect) => {
          if (!editable) {
            toast.warning('当前多维表格为只读状态');
            return;
          }
          if (calendarDateMetadata && date !== isoDate(new Date())) {
            toast.warning(`日历按${calendarDateMetadata.label}展示，仅支持在今天新建笔记`);
            return;
          }
          openCalendarNotePopover(date, anchorRect, calendarDateFieldId);
        }}
      />}
      {activeView?.layout === 'calendar' && (!calendarDateFieldId || (!calendarDateMetadata && calendarField?.type !== 'Date')) && <IncompatibleViewEmptyState
        title={t('multidimensionalTable.view.incompatibleTitle')}
        titleAction={editable && <button type="button" disabled={saving} onClick={(event) => {
          viewWizard.configureView(activeView.id, 'calendar', event.currentTarget.getBoundingClientRect());
        }} className="inline-flex items-center gap-1 text-sm text-[var(--primary)] hover:underline disabled:opacity-50">
          选择日期<ChevronRight className="size-4" aria-hidden="true" />
        </button>}
        description={calendarField
          ? t('multidimensionalTable.view.calendarFieldTypeMismatch', {
            field: fieldLabel(calendarField, propertyFields, t),
            type: calendarField.type !== 'primary' ? t(getPropertyTypeDefinition(calendarField.type).labelKey) : t('multidimensionalTable.view.missingField'),
          })
          : t('multidimensionalTable.view.calendarMissingField')}
      />}
      {activeView?.layout === 'gallery' && <TableGalleryView
        dropAreaRef={recordsScrollerRef}
        records={visibleGalleryRecords}
        nextRecordId={secondaryViewRecords[(embeddedInEditor ? galleryCurrentPage * galleryPageSize : 0) + visibleGalleryRecords.length]?.id ?? null}
        titleField={titleField ?? document.dataset.schema.fields[0]}
        fields={galleryFields}
        renderValue={displayFieldValue}
        imageUrl={(record, field) => {
          const path = imagePaths(notePropertyEditorValue(noteForRecord(record), field))[0];
          return path ? imageUrls[`${record.id}:${field.id}:${path}`] ?? null : null;
        }}
        noteThumbnail={(record) => noteThumbnailUrl(noteForRecord(record)?.thumbnail)}
        onOpenRecord={(record, anchorRect) => {
          const note = noteForRecord(record);
          if (note) openLinkedNote(note);
          else if (notesLoadError) retryNoteLookup();
          else openNotePicker(anchorRect, record.id);
        }}
        onCreateBlankNote={createBlankGalleryNote}
        onChooseData={chooseGalleryData}
        recordStatus={noteStatusForRecord}
        noteIcon={(record) => noteForRecord(record)?.icon ?? null}
        canAddData={editable && Boolean(noteField && resolvedNotebookId) && !saving}
        dropNotebookId={resolvedNotebookId}
        canDropExternal={editable && Boolean(noteField && notebookPath && resolvedNotebookId) && !saving}
        previewExternalNoteDrop={previewExternalGalleryDrop}
        onExternalNoteDrop={addExternalNotesToGallery}
      />}
      {embeddedInEditor && activeView?.layout === 'gallery' && galleryPageCount > 1 && <footer className="flex flex-wrap items-center justify-end gap-3 px-0 py-1.5 text-sm text-[var(--muted-foreground)]" aria-label="画廊分页">
        <span>{secondaryViewRecords.length} 条</span>
        <button
          type="button"
          disabled={galleryCurrentPage === 0}
          onClick={() => setGalleryPage(galleryCurrentPage - 1)}
          className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
        >
          上一页
        </button>
        <span>{galleryCurrentPage + 1} / {galleryPageCount}</span>
        <button
          type="button"
          disabled={galleryCurrentPage >= galleryPageCount - 1}
          onClick={() => setGalleryPage(galleryCurrentPage + 1)}
          className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
        >
          下一页
        </button>
      </footer>}
      {!embeddedInEditor && ((activeView?.layout === 'table' && currentPage < pageCount - 1)
        || (activeView?.layout === 'gallery' && galleryCurrentPage < galleryPageCount - 1)) && (
        <div ref={loadMoreRecordsRef} className="h-8 shrink-0" aria-hidden="true" />
      )}
      </OverlayScrollbar>
      {activeView?.layout === 'table' && <div className={`flex w-full min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 py-1.5 ${embeddedInEditor ? '' : 'px-4'}`}>
        {showAssociateNoteButton && (
          <button
            type="button"
            disabled={!editable || saving || !noteField}
            onClick={() => void addDraftRecordAndOpenNoteSelector()}
            className="flex items-center gap-0.5 rounded py-1 text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            添加笔记
          </button>
        )}
        <footer className="flex flex-wrap items-center gap-3 text-sm text-[var(--muted-foreground)]" aria-label={embeddedInEditor && pageCount > 1 ? '表格分页' : '记录统计'}>
          <span>{visibleRecords.length} 条</span>
          {embeddedInEditor && pageCount > 1 && <>
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setTablePage(currentPage - 1)}
              className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
            >
              上一页
            </button>
            <span>{currentPage + 1} / {pageCount}</span>
            <button
              type="button"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setTablePage(currentPage + 1)}
              className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
            >
              下一页
            </button>
          </>}
        </footer>
      </div>}
    </div>
    <Popover open={newFieldOpen} onOpenChange={(open) => {
      setNewFieldOpen(open);
      if (!open) {
        setNewFieldAnchor(null);
        setNewFieldTypeMenuOpen(false);
        setNewFieldPresetMenuOpen(false);
        if (skipNewFieldSaveOnCloseRef.current) skipNewFieldSaveOnCloseRef.current = false;
        else addField();
      }
      }} anchorRect={newFieldAnchor?.rect ?? null}>
      <PopoverContent side="left" align={newFieldAnchor?.align ?? 'start'} sideOffset={0} ignorePopoverOutside={newFieldTypeMenuOpen || newFieldPresetMenuOpen} style={{ zIndex: 160 }} className="max-h-[min(70vh,420px)] w-[213px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <TableFieldEditorForm
          name={newFieldPropertyKey}
          onNameChange={setNewFieldPropertyKey}
          onNameSubmit={() => addField()}
          type={newFieldType}
          typeChoices={FIELD_TYPE_CHOICES}
          onTypeChange={(type) => {
            setNewFieldType(type);
            setNewFieldOptions((current) => type === 'Select' || type === 'MultiSelect'
              ? current.length > 0 ? current : [{ id: `opt_${createUuidV7()}`, label: '' }]
              : []);
          }}
          typeMenuOpen={newFieldTypeMenuOpen}
          onTypeMenuOpenChange={(open) => {
            setNewFieldTypeMenuOpen(open);
            if (open) setNewFieldPresetMenuOpen(false);
          }}
          options={newFieldOptions}
          onOptionsChange={setNewFieldOptions}
          customPresets={tablePresets.custom}
          systemPresets={tablePresets.system}
          showPresetMenu={false}
          presetMenuOpen={newFieldPresetMenuOpen}
          onPresetMenuOpenChange={(open) => {
            setNewFieldPresetMenuOpen(open);
            if (open) setNewFieldTypeMenuOpen(false);
          }}
          isPresetAdded={presetAlreadyAdded}
          onSelectPreset={(preset) => {
            setNewFieldPresetMenuOpen(false);
            skipNewFieldSaveOnCloseRef.current = true;
            setNewFieldPropertyKey('');
            setNewFieldOptions([]);
            setNewFieldOpen(false);
            void addField(preset);
          }}
          onRemovePreset={removePreset}
          onManagePresets={() => {
            setNewFieldPresetMenuOpen(false);
            skipNewFieldSaveOnCloseRef.current = true;
            setNewFieldOpen(false);
            void windows.openPreferences('noteSettings');
          }}
          afterFooter={<div className="mt-1 flex flex-col gap-1">
            <button
              type="button"
              disabled={!editable || saving || !newFieldPropertyKey.trim()}
              onClick={() => { void addField(); }}
              className="flex h-8 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--muted)] px-2 text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
            >保存</button>
            {newFieldAnchor?.source === 'table' && <>
              <div role="separator" aria-hidden="true" className="mx-2 h-px bg-[var(--border)]" />
              <TablePresetMenu
                triggerLabel="从预设选择"
                customGroupLabel={t('preferences.documentProperties.group.mine')}
                customPresets={tablePresets.custom}
                systemPresets={tablePresets.system}
                disabled={!editable || saving}
                open={newFieldPresetMenuOpen}
                onOpenChange={setNewFieldPresetMenuOpen}
                t={t}
                onSelect={(preset) => {
                  setNewFieldPresetMenuOpen(false);
                  skipNewFieldSaveOnCloseRef.current = true;
                  setNewFieldPropertyKey('');
                  setNewFieldOptions([]);
                  setNewFieldOpen(false);
                  void addField(preset);
                }}
                onRemove={removePreset}
                isAdded={presetAlreadyAdded}
                onManage={() => {
                  setNewFieldPresetMenuOpen(false);
                  skipNewFieldSaveOnCloseRef.current = true;
                  setNewFieldOpen(false);
                  void windows.openPreferences('noteSettings');
                }}
              />
            </>}
          </div>}
          disabled={!editable || saving}
          t={t}
          typeLabel={(type) => fieldTypeLabel(type, t)}
          typeIconKind={fieldTypeIconKind}
        />
      </PopoverContent>
    </Popover>
    <Popover open={calendarAddOpen} onOpenChange={(open) => {
      setCalendarAddOpen(open);
      if (!open) {
        calendarPendingCreatedNoteRef.current = null;
        setCalendarEditingRecord(null);
      }
    }} anchorRect={calendarAddAnchorRect}>
      <PopoverContent side="right" align="start" sideOffset={8} fitViewport ignorePopoverOutside style={{ zIndex: 160 }} className="calendar-note-create-popover flex max-h-[min(424px,100vh)] w-[320px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl px-2 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <NoteCreatePicker
          value={calendarAddTitle} onChange={setCalendarAddTitle}
          mode={calendarEditingRecord ? 'edit' : 'create'} allowSelect={false}
          disabled={saving || !editable || (!calendarEditingRecord && !resolvedNotebookId)}
          onCreate={calendarEditingRecord ? saveCalendarNoteEdit : createCalendarNote} onCancel={closeCalendarNoteDialog}
          showCreateButton={false}
          actionsLayout="column"
          scrollTitleWithActions
          actions={calendarCreateFields.length > 0 ? <div className="calendar-note-create-fields border-t border-[var(--border)]">
            {calendarCreateFields.map((field) => {
              const value = calendarCreatePropertyValues[field.id];
              const inputClass = 'h-8 w-full rounded-md border-0 bg-transparent px-0 text-sm outline-none placeholder:text-[var(--muted-foreground)] placeholder:opacity-80 focus:border-0 focus:bg-transparent focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50';
              const setValue = (nextValue: unknown) => setCalendarCreatePropertyValues((current) => ({ ...current, [field.id]: nextValue }));
              const options = field.options?.map((option) => ({ value: option.id, label: option.label })) ?? [];
              const control = field.type === 'Boolean'
                ? <TableBooleanInput value={value} disabled={saving} ariaLabel={fieldLabel(field, propertyFields, t)} onChange={setValue} />
                : field.type === 'Select'
                  ? <SelectValueInput value={String(value ?? '')} options={options} disabled={saving} variant="table" onChange={setValue} />
                  : field.type === 'MultiSelect'
                    ? <MultiSelectValueInput value={Array.isArray(value) ? value.map(String).join(', ') : ''} options={options} disabled={saving} variant="table" onChange={(next) => setValue(next.split(',').map((item) => item.trim()).filter(Boolean))} />
                    : field.type === 'Date'
                      ? <DateValueInput value={String(value ?? '')} disabled={saving} variant="table" onChange={setValue} />
                      : field.type === 'Color'
                        ? <ColorValueInput value={Array.isArray(value) ? value.map(String).join(', ') : ''} disabled={saving} variant="table" onChange={(next) => setValue(next ? next.split(',').map((item) => item.trim()).filter(Boolean) : [])} />
                        : field.type === 'Icon'
                          ? <IconValueInput value={String(value ?? '')} disabled={saving} variant="table" onChange={setValue} />
                          : field.type === 'Tag'
                            ? <TableTagValueInput value={Array.isArray(value) ? value.map(String) : []} disabled={saving} isNoteTags={canonicalizePropertyKey(field.property_key ?? '') === 'tags'} onChange={setValue} />
                            : field.type === 'Text'
                              ? <TableTextValueInput value={String(value ?? '')} disabled={saving} onChange={(next) => setValue(next ?? '')} />
                              : field.type === 'Number'
                                ? <TableNumberInput value={value} disabled={saving} placeholder="" className={inputClass} onChange={setValue} />
                                : field.type === 'Image'
                                  ? <NotePropertyImageValue
                                    value={value}
                                    notebook={resolvedNotebookId && notebookPath ? { id: resolvedNotebookId, path: notebookPath } : undefined}
                                    disabled={saving}
                                    onChange={(path) => setValue(field.multiple ? [...(Array.isArray(value) ? value.map(String) : []), path] : path)}
                                  />
                                  : <input type="url" value={String(value ?? '')} disabled={saving} onChange={(event) => setValue(event.currentTarget.value)} className={inputClass} />;
              return <div key={field.id} className="flex min-w-0 items-center gap-2 border-b border-[var(--border)] last:border-b-0">
                <div className="w-fit min-w-[24%] max-w-[36%] shrink-0 truncate text-sm" title={fieldLabel(field, propertyFields, t)}>{fieldLabel(field, propertyFields, t)}</div>
                <div className="multidimensional-table__cell-content calendar-note-create-field-input min-w-0 flex-1 px-1.5">{control}</div>
              </div>;
            })}
          </div> : undefined}
          footer={<div className="flex w-full shrink-0 gap-2 pt-2">
            {!calendarEditingRecord && <Button type="button" variant="outline" size="lg" className="!h-8 flex-1 rounded-lg text-sm" disabled={saving} onClick={closeCalendarNoteDialog}>取消</Button>}
            <Button type="button" size="lg" className="!h-8 flex-1 rounded-lg text-sm" disabled={saving || !editable || (!calendarEditingRecord && !resolvedNotebookId) || !calendarAddTitle.trim()} onClick={() => void (calendarEditingRecord ? saveCalendarNoteEdit() : createCalendarNote())}>
              {saving && <LoaderCircle className="mr-1 h-3.5 w-3.5 flowix-spin" aria-hidden="true" />}
              保存
            </Button>
            {calendarEditingRecord && <Button type="button" variant="outline" size="lg" className="!h-8 flex-1 rounded-lg text-sm" disabled={!noteForRecord(calendarEditingRecord)} onClick={() => openLinkedRecord(calendarEditingRecord.id)}>打开</Button>}
          </div>}
        />
      </PopoverContent>
    </Popover>
    <Popover open={notePickerOpen} onOpenChange={(open) => {
      setNotePickerOpen(open);
      if (!open) {
        setNotePickerRecordId(null);
        setNotePickerCalendarDate(null);
      }
    }} anchorRect={notePickerAnchorRect}>
      <PopoverContent side="bottom" align="start" sideOffset={6} fitViewport className="w-[280px] max-w-[calc(100vw-16px)] rounded-xl px-2 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <NoteCreatePicker
          value={newNoteTitle} onChange={setNewNoteTitle}
          notes={availableNotes} allowSelect={document.collection.placement !== 'folder'}
          disabled={saving || !editable || !resolvedNotebookId} error={notesLoadError}
          onCreate={createAndLinkNote}
          onSelect={(selectedNote) => linkSelectedNote(selectedNote.relativePath.replace(/\\/g, '/'))}
          onCancel={() => setNotePickerOpen(false)}
        />
      </PopoverContent>
    </Popover>
    {/* 内嵌表格的视图删除；工作区集合统一由外壳管理。 */}
    <Dialog open={viewPendingDelete !== null} onOpenChange={(open) => { if (!open) { cancelDeleteView(); } }}>
      <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DialogHeader>
          <DialogTitle>{t('multidimensionalTable.view.delete')}</DialogTitle>
          <DialogDescription>
            {t('multidimensionalTable.view.deleteConfirm', { name: viewPendingDelete?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => { cancelDeleteView(); }}>{t('dialog.cancel')}</Button>
          <Button type="button" variant="destructive" onClick={() => { confirmDeleteView(); }}>{t('dialog.delete')}</Button>
        </div>
      </DialogContent>
    </Dialog>
    </div>
  </PropertyValueTypographyContext.Provider>;
}
