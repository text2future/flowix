import { useCallback, useState } from 'react';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { joinNotebookMemoPath, notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { displayTitleFromFilename } from '@/lib/utils';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { renameMarkdownTitle } from '@features/document/use-cases/local-document-operations';
import { replaceExternalDocumentPath } from '@features/workspace/public/note-navigation-api';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { resolveCollectionSaveDirectory } from '@features/collection/save-location';
import { reviseCollection } from '@features/collection/model';
import { resolveDatasetFilterForLocation } from '@features/collection/dataset-filter-location';
import { notes as notesClient, type NoteEntry } from '@platform/tauri/client';
import type { NoteListItem } from '@/types/note-item';
import { useI18n } from '@/lib/i18n';
import { createUuidV7, type MultidimensionalTableDocument, type TableField, type TableRecord } from './model';
import { builtinPresetTableField } from './builtin-fields';
import { noteMatchesCollectionFilter } from './record-filter';
import { upsertTableRecord } from './table-view-helpers';
import { selectPropertyImage } from '@features/document/properties/image-value-input';
import type { useTableSession } from './use-table-session';

type TableSession = ReturnType<typeof useTableSession>;
type NoteForRecord = (record: TableRecord) => NoteEntry | undefined;

export interface UseTableNoteLinkingInput {
  session: Pick<TableSession,
    | 'document' | 'saving' | 'setSaving' | 'save' | 'loadSequenceRef' | 'isCurrentSession'
    | 'resolvedNotebookId' | 'setNotes' | 'reportSaveFailure'>;
  noteField: TableField | undefined;
  editable: boolean;
  notebookPath: string | null;
  notebookId: string | null;
  currentFilePath: string;
  availableNotes: NoteEntry[];
  visibleRecords: TableRecord[];
  collectionFilterFields: Parameters<typeof noteMatchesCollectionFilter>[1];
  activeViewLayout: string | undefined;
  noteForRecord: NoteForRecord;
  setPendingTablePageRecordId: (recordId: string | null) => void;
  setAutoOpenPrimaryRecordId: (recordId: string | null) => void;
  setTablePage: (page: number) => void;
  updateCell: (record: TableRecord, note: NoteEntry | undefined, field: TableField, value: unknown) => void;
}

/**
 * Note picking, linking, creating, renaming and record-level actions shared by
 * the table / gallery / kanban views. Pure logic container: state stays in the
 * session component and flows in through `input`; callback bodies are moved
 * verbatim from `table-document-view.tsx`.
 */
export function useTableNoteLinking(input: UseTableNoteLinkingInput) {
  const {
    session,
    editable, notebookPath, notebookId, currentFilePath,
    availableNotes, visibleRecords, collectionFilterFields, activeViewLayout,
    noteForRecord, setPendingTablePageRecordId, setAutoOpenPrimaryRecordId, setTablePage, updateCell,
  } = input;
  const { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, resolvedNotebookId,
    setNotes, reportSaveFailure } = session;
  const { noteField } = input;
  const { t } = useI18n();

  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [notePickerAnchorRect, setNotePickerAnchorRect] = useState<DOMRect | null>(null);
  const [notePickerRecordId, setNotePickerRecordId] = useState<string | null>(null);
  const [notePickerCalendarDate, setNotePickerCalendarDate] = useState<{ fieldId: string; date: string } | null>(null);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [rowActionRecordId, setRowActionRecordId] = useState<string | null>(null);

  const openNotePicker = useCallback((anchorRect: DOMRect, recordId: string | null, calendarDate: { fieldId: string; date: string } | null = null) => {
    setNotePickerAnchorRect(anchorRect);
    setNotePickerRecordId(recordId);
    setNotePickerCalendarDate(calendarDate);
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
    const records = [...document.dataset.records.include, record];
    setSaving(true);
    try {
      const saved = await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      }, true, sequence);
      if (!saved || !isCurrentSession(sequence)) return;
      setPendingTablePageRecordId(record.id);
      setAutoOpenPrimaryRecordId(record.id);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableAddRow'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [document, editable, isCurrentSession, loadSequenceRef, noteField, save, saving, setSaving, reportSaveFailure, setPendingTablePageRecordId, setAutoOpenPrimaryRecordId]);

  const applyCalendarDateToNote = useCallback(async (note: NoteEntry, calendarDate: { fieldId: string; date: string } | null): Promise<NoteEntry> => {
    if (!calendarDate) return note;
    if (!editable) throw new Error('当前引用为只读，无法修改笔记属性');
    const field = document?.dataset.schema.fields.find((item) => item.id === calendarDate.fieldId)
      ?? builtinPresetTableField(calendarDate.fieldId) ?? undefined;
    if (field?.type !== 'Date' || !field.property_key) return note;
    const path = notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
    if (!path) throw new Error('无法确定笔记路径，未能设置日期');
    if (!await setDocumentProperties(path, { [field.property_key]: calendarDate.date }, { [field.property_key]: 'Date' })) {
      throw new Error('笔记日期未能保存');
    }
    return { ...note, updatedAt: Date.now(), properties: { ...note.properties, [field.property_key]: calendarDate.date } };
  }, [document, editable, notebookPath]);

  const createNoteInNotebook = useCallback(async (title?: string) => {
    if (!editable) throw new Error('当前引用为只读，无法新建笔记');
    if (!resolvedNotebookId) throw new Error('无法确定当前笔记本');
    if (!document || !notebookPath) throw new Error('无法确定当前多维表路径');
    const directory = resolveCollectionSaveDirectory({
      filePath: currentFilePath, notebookPath, placement: document.collection.placement,
      source: document.dataset.source,
      filter: document.dataset.filter,
      defaultDirectory: parentDirectoryPath(currentFilePath, notebookPath),
    });
    const parentRelativePath = notebookRelativeDirectoryPath(notebookPath, directory) ?? undefined;
    return notesClient.create(resolvedNotebookId, undefined, parentRelativePath, title);
  }, [currentFilePath, document, editable, notebookPath, resolvedNotebookId]);

  const linkSelectedNote = useCallback(async (selectedNoteKey: string) => {
    if (!editable || !document || document.collection.placement === 'folder' || !noteField || !selectedNoteKey || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const selectedNote = availableNotes.find((note) => note.relativePath.replace(/\\/g, '/') === selectedNoteKey);
      const updatedNote = selectedNote ? await applyCalendarDateToNote(selectedNote, notePickerCalendarDate) : null;
      if (!isCurrentSession(sequence)) return;
      if (updatedNote && notePickerCalendarDate) {
        const field = document.dataset.schema.fields.find((item) => item.id === notePickerCalendarDate.fieldId)
          ?? builtinPresetTableField(notePickerCalendarDate.fieldId);
        if (field?.type === 'Date' && field.property_key) {
          setNotes((current) => current.map((note) => note.relativePath.replace(/\\/g, '/') === selectedNoteKey ? updatedNote : note));
        }
      }
      const now = new Date().toISOString();
      const targetRecord = notePickerRecordId ? visibleRecords.find((record) => record.id === notePickerRecordId) : undefined;
      const linkedRecord = targetRecord
        ? { ...targetRecord, updated_at: now, note_path: selectedNoteKey }
        : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: selectedNoteKey };
      const records = upsertTableRecord(document.dataset.records.include, linkedRecord);
      const next: MultidimensionalTableDocument = { ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } };
      setNotePickerOpen(false);
      setNotePickerRecordId(null);
      setNotePickerCalendarDate(null);
      const saved = await save(next, true, sequence);
      if (saved && isCurrentSession(sequence) && activeViewLayout === 'table' && (!targetRecord || !targetRecord.note_path)) setPendingTablePageRecordId(linkedRecord.id);
      if (!saved && updatedNote && notePickerCalendarDate) toast.error('笔记日期已修改，但表格关联未保存，请重试关联');
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableLink'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [activeViewLayout, applyCalendarDateToNote, availableNotes, document, editable, isCurrentSession, loadSequenceRef, noteField, notePickerCalendarDate, notePickerRecordId, save, saving, setNotes, setSaving, visibleRecords, reportSaveFailure, setPendingTablePageRecordId]);

  const replaceLinkedNote = useCallback((recordId: string, noteKey: string) => {
    if (!document || document.collection.placement === 'folder' || !noteField || saving) return;
    const now = new Date().toISOString();
    const targetRecord = visibleRecords.find((record) => record.id === recordId);
    if (!targetRecord) return;
    const records = upsertTableRecord(document.dataset.records.include, { ...targetRecord, updated_at: now, note_path: noteKey });
    void save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } })
      .then((saved) => {
        if (saved && !targetRecord.note_path) setPendingTablePageRecordId(recordId);
      });
  }, [document, noteField, save, saving, visibleRecords, setPendingTablePageRecordId]);

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
      const records = upsertTableRecord(document.dataset.records.include, { ...targetRecord, updated_at: now, note_path: noteKey });
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      const saved = await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, true, sequence);
      if (saved && isCurrentSession(sequence) && !targetRecord.note_path) setPendingTablePageRecordId(recordId);
      return saved && isCurrentSession(sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableCreateLink'));
      return false;
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, noteField, resolvedNotebookId, save, saving, visibleRecords, reportSaveFailure, setSaving, setNotes, setPendingTablePageRecordId]);

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
      const records = upsertTableRecord(document.dataset.records.include, linkedRecord);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      setNotePickerOpen(false);
      setNotePickerRecordId(null);
      setNotePickerCalendarDate(null);
      setNewNoteTitle('');
      const saved = await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, false, sequence);
      if (saved && isCurrentSession(sequence) && activeViewLayout === 'table' && (!targetRecord || !targetRecord.note_path)) setPendingTablePageRecordId(linkedRecord.id);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableCreateLink'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [activeViewLayout, applyCalendarDateToNote, createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, newNoteTitle, noteField, notePickerCalendarDate, notePickerRecordId, resolvedNotebookId, save, saving, visibleRecords, reportSaveFailure, setSaving, setNotes, setPendingTablePageRecordId]);

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
        notebook: notebookId ? { id: notebookId, path: notebookPath } : null,
        displayId: identity.displayId,
        onPathChanged: (previousPath, nextPath) => replaceExternalDocumentPath(identity.displayId, previousPath, nextPath),
      });
      if (!renamed) {
        reportSaveFailure(sequence);
        return null;
      }
      if (!renamed.changed) return note;
      const parentPath = note.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const nextRelativePath = `${parentPath ? `${parentPath}/` : ''}${renamed.filename}`;
      const updatedNote = { ...note, relativePath: nextRelativePath, title: displayTitleFromFilename(nextRelativePath) };
      if (isCurrentSession(sequence)) {
        setNotes((current) => current.map((item) => item.relativePath.replace(/\\/g, '/') === note.relativePath.replace(/\\/g, '/') ? updatedNote : item));
      }
      return updatedNote;
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.noteRename'));
      return null;
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [editable, isCurrentSession, loadSequenceRef, notebookPath, saving, setNotes, reportSaveFailure, setSaving, notebookId]);

  const deleteRecord = useCallback((recordId: string) => {
    if (!document || saving) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    if (!record) return;
    const primaryField = document.dataset.schema.fields[0];
    const datasetFilter = resolveDatasetFilterForLocation(document.dataset.filter, document.collection.placement, currentFilePath, notebookPath);
    let nextDocument = document;
    const note = record ? noteForRecord(record) : undefined;
    const ruleMatch = primaryField && record && note
      ? datasetFilter !== null && noteMatchesCollectionFilter(note, collectionFilterFields, primaryField.id, datasetFilter)
      : false;
    if (primaryField && record && note && ruleMatch) {
      const notePath = note.relativePath.replace(/\\/g, '/');
      nextDocument = {
        ...document,
        dataset: { ...document.dataset, records: { ...document.dataset.records,
          exclude: document.dataset.records.exclude.some((item) => item.note_path === notePath)
            ? document.dataset.records.exclude
            : [...document.dataset.records.exclude, { note_path: notePath }] } },
      };
    }
    const next = {
      ...nextDocument,
      collection: reviseCollection(nextDocument.collection),
      dataset: { ...nextDocument.dataset, records: { ...nextDocument.dataset.records, include: document.dataset.records.include.filter((item) => item.id !== recordId) } },
    };
    void save(next);
  }, [collectionFilterFields, currentFilePath, document, notebookPath, noteForRecord, save, saving, visibleRecords]);

  const updateRecordField = useCallback((recordId: string, fieldId: string, value: unknown) => {
    if (!document) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    const field = document.dataset.schema.fields.find((item) => item.id === fieldId) ?? builtinPresetTableField(fieldId) ?? undefined;
    if (record && field) updateCell(record, noteForRecord(record), field, value);
  }, [document, noteForRecord, updateCell, visibleRecords]);

  const selectImageForCell = useCallback(async (record: TableRecord, note: NoteEntry, field: TableField) => {
    if (field.type !== 'Image' || !editable || saving) return;
    if (!notebookPath || !notebookId) {
      toast.error(t('document.properties.imageUploadFailed'));
      return;
    }
    const relativePath = await selectPropertyImage({ id: notebookId, path: notebookPath }, t);
    if (relativePath) updateCell(record, note, field, relativePath);
  }, [editable, notebookId, notebookPath, saving, t, updateCell]);

  const createBlankGalleryNote = useCallback(async (nextNoteNumber: number) => {
    if (!editable || !document || !noteField || !resolvedNotebookId || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(`未命名笔记 ${nextNoteNumber}`);
      if (!isCurrentSession(sequence)) return;
      const note = created.entry;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      const record: TableRecord = {
        id: `rec_${createUuidV7()}`,
        updated_at: new Date().toISOString(),
        note_path: noteKey,
      };
      const records = upsertTableRecord(document.dataset.records.include, record);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      const saved = await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      }, true, sequence);
      if (saved && isCurrentSession(sequence)) {
        setTablePage(0);
      }
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableCreateLink'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, noteField, reportSaveFailure, resolvedNotebookId, save, saving, setNotes, setSaving, setTablePage]);

  const requestDeleteLinkedNote = useCallback((note: NoteEntry) => {
    const targetNotebookId = resolvedNotebookId ?? notebookId;
    if (!targetNotebookId) return;
    const filename = note.relativePath.split(/[\\/]/).filter(Boolean).pop() ?? note.relativePath;
    const target: NoteListItem = {
      kind: 'path-note',
      notebookId: targetNotebookId,
      relativePath: note.relativePath,
      filename,
      title: note.title,
      preview: note.preview,
      thumbnail: note.thumbnail,
      tags: note.tags,
      todos: note.todos,
      agents: note.agents,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      favorited: note.favorited,
      icon: note.icon,
      colors: note.colors,
      properties: note.properties,
    };
    window.dispatchEvent(new CustomEvent<NoteListItem>('flowix:request-delete-memo', { detail: target }));
  }, [notebookId, resolvedNotebookId]);


  return {
    notePickerOpen, setNotePickerOpen,
    notePickerAnchorRect, setNotePickerAnchorRect,
    notePickerRecordId, setNotePickerRecordId,
    notePickerCalendarDate, setNotePickerCalendarDate,
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
    createBlankGalleryNote,
    requestDeleteLinkedNote,
  };
}
