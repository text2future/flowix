import { useCallback, useState, type RefObject } from 'react';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { canonicalPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { reviseCollection } from '@features/collection/model';
import type { NoteEntry } from '@platform/tauri/client';
import { isMarkdownNoteDragResource, type NotebookNoteDragResource } from '@features/memo/public/drag-resource-api';
import { createUuidV7, type MultidimensionalTableDocument, type TableField, type TableRecord, type TableView } from './model';
import { planTableNoteDrop, type TableNoteDropPreview, type TableNoteDropRejection } from './table-note-drop';
import { useTableNoteDropTarget, type TableNoteDropTargetRejection } from './use-table-note-drop-target';
import { upsertTableRecord } from './table-view-helpers';
import type { useTableSession } from './use-table-session';

type TableSession = ReturnType<typeof useTableSession>;

export interface UseTableNoteDropInput {
  session: Pick<TableSession,
    | 'document' | 'saving' | 'setSaving' | 'save' | 'loadSequenceRef' | 'isCurrentSession'
    | 'resolvedNotebookId' | 'notes' | 'setNotes'>;
  noteField: TableField | undefined;
  editable: boolean;
  notebookPath: string | null;
  currentFilePath: string;
  activeView: TableView | null;
  conditionRecords: TableRecord[];
  collectionFilterFields: Parameters<typeof planTableNoteDrop>[0]['fields'];
  noteForRecord: (record: TableRecord) => NoteEntry | undefined;
  applyCalendarDateToNote: (note: NoteEntry, calendarDate: { fieldId: string; date: string } | null) => Promise<NoteEntry>;
  calendarDateFieldId: string | null;
  calendarField: TableField | undefined;
  datasetRecords: TableRecord[];
  embeddedInEditor: boolean;
  tablePageSize: number;
  galleryPageSize: number;
  galleryCurrentPage: number;
  currentPage: number;
  nextTableRecordId: string | null;
  recordsScrollerRef: RefObject<HTMLDivElement | null>;
  tableDropAreaRef: RefObject<HTMLDivElement | null>;
  tableDropTargetId: string;
  setTablePage: (update: number | ((page: number) => number)) => void;
  setGalleryPage: (update: number | ((page: number) => number)) => void;
}

/**
 * External note drag & drop for the table / gallery / calendar layouts: drop
 * planning, preview records, persistence and the table drop target wiring.
 * Callback bodies are moved verbatim from `table-document-view.tsx`.
 */
export function useTableNoteDrop(input: UseTableNoteDropInput) {
  const {
    session, editable, notebookPath, currentFilePath, activeView, conditionRecords,
    collectionFilterFields, noteForRecord, applyCalendarDateToNote, calendarDateFieldId, calendarField,
    datasetRecords, embeddedInEditor, tablePageSize, galleryPageSize, galleryCurrentPage, currentPage,
    nextTableRecordId, recordsScrollerRef, tableDropAreaRef, tableDropTargetId, setTablePage, setGalleryPage,
  } = input;
  const { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, resolvedNotebookId,
    notes, setNotes } = session;
  const { noteField } = input;
  const { t } = useI18n();

  const [tableDropPreview, setTableDropPreview] = useState<TableNoteDropPreview | null>(null);

  const planExternalNoteDrop = useCallback((
    draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null,
  ) => {
    if (!document || (activeView?.layout !== 'gallery' && activeView?.layout !== 'table') || !notebookPath || !resolvedNotebookId) {
      return { reason: 'unavailable' as const };
    }
    const uniqueNotes = [...new Map(draggedNotes.map((note) => [canonicalPath(note.relativePath), note])).values()];
    const resolved: NoteEntry[] = [];
    for (const draggedNote of uniqueNotes) {
      if (!isMarkdownNoteDragResource(draggedNote) || draggedNote.notebookId !== resolvedNotebookId) {
        return { reason: 'unavailable' as const };
      }
      const relativePath = canonicalPath(draggedNote.relativePath).replace(/^\/+/, '');
      const note = notes.find((item) => item.relativePath.replace(/\\/g, '/') === relativePath);
      if (!note) {
        return { reason: 'unavailable' as const };
      }
      resolved.push(note);
    }
    return planTableNoteDrop({
      explicitRecords: document.dataset.records.include,
      automaticRecords: conditionRecords,
      draggedNotes: resolved,
      beforeRecordId,
      view: activeView,
      fields: collectionFilterFields,
      primaryFieldId: document.dataset.schema.primary_field_id,
      noteForRecord,
      isInSource: () => true,
    });
  }, [activeView, collectionFilterFields, conditionRecords, currentFilePath, document, noteForRecord, notes, notebookPath, resolvedNotebookId]);

  const previewExternalGalleryDrop = useCallback((
    draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null,
  ): TableNoteDropPreview | TableNoteDropRejection => {
    const plan = planExternalNoteDrop(draggedNotes, beforeRecordId);
    if ('reason' in plan) return plan;
    const index = plan.records.findIndex((record) => plan.draggedPaths.includes(record.note_path.replace(/\\/g, '/')));
    const page = embeddedInEditor
      ? Math.floor(index / galleryPageSize)
      : Math.max(galleryCurrentPage, Math.floor(index / galleryPageSize));
    return {
      records: plan.records.slice(embeddedInEditor ? page * galleryPageSize : 0, (page + 1) * galleryPageSize),
      draggedPaths: plan.draggedPaths,
    };
  }, [embeddedInEditor, galleryCurrentPage, galleryPageSize, planExternalNoteDrop]);

  const persistExternalNotesToTableView = useCallback(async (
    draggedNotes: NotebookNoteDragResource[],
    beforeRecordId: string | null,
    layout: 'table' | 'gallery',
  ) => {
    if (!editable || !document || !noteField || saving || activeView?.layout !== layout) return;
    const plan = planExternalNoteDrop(draggedNotes, beforeRecordId);
    const filteredMessage = layout === 'gallery'
      ? 'multidimensionalTable.galleryDropFiltered' : 'multidimensionalTable.tableDropFiltered';
    const unsupportedMessage = layout === 'gallery'
      ? 'memo.fileTree.galleryDropUnsupported' : 'memo.fileTree.tableDropUnsupported';
    const failedMessage = layout === 'gallery'
      ? 'multidimensionalTable.galleryDropFailed' : 'multidimensionalTable.tableDropFailed';
    if ('reason' in plan) {
      toast.warning(t(plan.reason === 'filtered' ? filteredMessage : unsupportedMessage));
      return;
    }
    const sequence = loadSequenceRef.current;
    if (!isCurrentSession(sequence)) return;
    setSaving(true);
    try {
      const records = plan.includedRecords.map((record) => record.id.startsWith('drop-note:')
        ? { ...record, id: `rec_${createUuidV7()}` } : record);
      const next: MultidimensionalTableDocument = {
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: {
          ...document.dataset.records,
          include: records,
          exclude: document.dataset.records.exclude.filter((record) => !plan.draggedPaths.includes(record.note_path.replace(/\\/g, '/'))),
        } },
      };
      if (!await save(next, true, sequence)) {
        if (isCurrentSession(sequence)) toast.error(t(failedMessage));
        return;
      }
      if (!isCurrentSession(sequence)) return;
      const index = plan.records.findIndex((record) => plan.draggedPaths.includes(record.note_path.replace(/\\/g, '/')));
      const pageSize = layout === 'gallery' ? galleryPageSize : tablePageSize;
      const setPage = layout === 'gallery' ? setGalleryPage : setTablePage;
      setPage((page) => embeddedInEditor
        ? Math.floor(index / pageSize)
        : Math.max(page, Math.floor(index / pageSize)));
    } catch (error) {
      if (isCurrentSession(sequence)) toast.error(friendlyErrorMessage(error, t, 'errors.friendly.noteMove'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [activeView?.layout, document, editable, embeddedInEditor, galleryPageSize, isCurrentSession, loadSequenceRef, noteField, planExternalNoteDrop, save, saving, setSaving, t, tablePageSize, setGalleryPage, setTablePage]);

  const addExternalNotesToGallery = useCallback((draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null) => (
    persistExternalNotesToTableView(draggedNotes, beforeRecordId, 'gallery')
  ), [persistExternalNotesToTableView]);

  const previewExternalTableDrop = useCallback((
    draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null,
  ): TableNoteDropPreview | TableNoteDropRejection => {
    const plan = planExternalNoteDrop(draggedNotes, beforeRecordId);
    if ('reason' in plan) return plan;
    const index = plan.records.findIndex((record) => plan.draggedPaths.includes(record.note_path.replace(/\\/g, '/')));
    const page = embeddedInEditor
      ? Math.floor(index / tablePageSize)
      : Math.max(currentPage, Math.floor(index / tablePageSize));
    return {
      records: plan.records.slice(embeddedInEditor ? page * tablePageSize : 0, (page + 1) * tablePageSize),
      draggedPaths: plan.draggedPaths,
    };
  }, [currentPage, embeddedInEditor, planExternalNoteDrop, tablePageSize]);

  const addExternalNotesToTable = useCallback((draggedNotes: NotebookNoteDragResource[], beforeRecordId: string | null) => (
    persistExternalNotesToTableView(draggedNotes, beforeRecordId, 'table')
  ), [persistExternalNotesToTableView]);

  const previewTableDrop = useCallback((draggedNotes: NotebookNoteDragResource[], location: { beforeRecordId: string | null }) => (
    previewExternalTableDrop(draggedNotes, location.beforeRecordId)
  ), [previewExternalTableDrop]);
  const onTableDropPreview = useCallback((preview: TableNoteDropPreview | null) => {
    setTableDropPreview((current) => current && preview
      && current.records.length === preview.records.length
      && current.records.every((record, index) => record.id === preview.records[index].id)
      && current.draggedPaths.join('\0') === preview.draggedPaths.join('\0') ? current : preview);
  }, []);
  const onTableDropReject = useCallback((reason: TableNoteDropTargetRejection) => {
    if (reason === 'unsupported-resource' || reason === 'wrong-notebook' || reason === 'unavailable') {
      toast.warning(t('memo.fileTree.tableDropUnsupported'));
    } else if (reason === 'read-only') {
      toast.warning(t('multidimensionalTable.tableDropReadOnly'));
    } else if (reason === 'filtered') {
      toast.warning(t('multidimensionalTable.tableDropFiltered'));
    }
  }, [t]);
  useTableNoteDropTarget({
    id: `table:${tableDropTargetId}`,
    active: activeView?.layout === 'table',
    notebookId: resolvedNotebookId,
    canDrop: editable && !saving,
    canHandleDrop: true,
    hitTest: ({ x, y }) => {
      const area = recordsScrollerRef.current;
      if (!area) return null;
      const bounds = area.getBoundingClientRect();
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
      const rows = [...(tableDropAreaRef.current?.querySelectorAll<HTMLElement>('tbody tr[data-table-record]') ?? [])]
        .filter((candidate) => {
          const rowBounds = candidate.getBoundingClientRect();
          return rowBounds.bottom > bounds.top && rowBounds.top < bounds.bottom;
        });
      if (!rows.length) return { beforeRecordId: null };
      const row = rows.reduce((nearest, candidate) => {
        const rowBounds = candidate.getBoundingClientRect();
        const nearestBounds = nearest.getBoundingClientRect();
        return Math.abs(y - (rowBounds.top + rowBounds.height / 2))
          < Math.abs(y - (nearestBounds.top + nearestBounds.height / 2)) ? candidate : nearest;
      });
      const index = rows.indexOf(row);
      const rowBounds = row.getBoundingClientRect();
      const insertAfter = y >= rowBounds.top + rowBounds.height / 2;
      return {
        beforeRecordId: rows[index + (insertAfter ? 1 : 0)]?.dataset.tableRecord
          ?? (insertAfter ? nextTableRecordId : null),
      };
    },
    locationKey: ({ beforeRecordId }) => beforeRecordId ?? 'end',
    preview: previewTableDrop,
    onPreview: onTableDropPreview,
    onDrop: (droppedNotes, location) => addExternalNotesToTable(droppedNotes, location.beforeRecordId),
    onReject: onTableDropReject,
    onError: (error) => toast.error(friendlyErrorMessage(error, t, 'errors.friendly.noteMove')),
  });

  const addExternalNotesToCalendar = useCallback(async (
    draggedNotes: NotebookNoteDragResource[],
    date: string,
  ) => {
    if (!editable || !document || !noteField || !notebookPath || !calendarDateFieldId
      || !calendarField || calendarField.type !== 'Date' || saving) return;
    const sequence = loadSequenceRef.current;
    const uniqueNotes = [...new Map(draggedNotes.map((note) => [canonicalPath(note.relativePath), note])).values()];
    const resolved = uniqueNotes.map((draggedNote) => {
      if (!isMarkdownNoteDragResource(draggedNote) || draggedNote.notebookId !== resolvedNotebookId) return null;
      const relativePath = canonicalPath(draggedNote.relativePath).replace(/^\/+/, '');
      const note = notes.find((item) => item.relativePath.replace(/\\/g, '/') === relativePath);
      if (!note) return null;
      return { note, relativePath };
    });
    if (!resolved.length || resolved.some((item) => !item)) {
      toast.warning(t('memo.fileTree.calendarDropUnsupported'));
      return;
    }
    if (!isCurrentSession(sequence)) return;
    setSaving(true);
    try {
      for (const item of resolved) {
        if (!item || !isCurrentSession(sequence)) return;
        const datedNote = await applyCalendarDateToNote(item.note, { fieldId: calendarDateFieldId, date });
        if (!isCurrentSession(sequence)) return;
        setNotes((current) => current.map((note) => (
          note.relativePath.replace(/\\/g, '/') === item.relativePath ? datedNote : note
        )));
      }

      let records = [...document.dataset.records.include];
      const now = new Date().toISOString();
      for (const item of resolved) {
        if (!item) continue;
        const existing = datasetRecords.find((record) => record.note_path.replace(/\\/g, '/') === item.relativePath);
        const linkedRecord = existing
          ? { ...existing, updated_at: now, note_path: item.relativePath }
          : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: item.relativePath };
        records = upsertTableRecord(records, linkedRecord);
      }
      const next: MultidimensionalTableDocument = {
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      };
      if (!await save(next, true, sequence) || !isCurrentSession(sequence)) {
        toast.error('日历关联未保存，请重试');
        return;
      }
    } catch (error) {
      if (isCurrentSession(sequence)) toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableLink'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [applyCalendarDateToNote, calendarDateFieldId, calendarField, currentFilePath, datasetRecords, document, editable, isCurrentSession, loadSequenceRef, noteField, notes, notebookPath, resolvedNotebookId, save, saving, setNotes, setSaving, t]);

  return {
    tableDropPreview,
    previewTableDrop,
    onTableDropPreview,
    onTableDropReject,
    previewExternalGalleryDrop,
    addExternalNotesToGallery,
    addExternalNotesToTable,
    addExternalNotesToCalendar,
  };
}
