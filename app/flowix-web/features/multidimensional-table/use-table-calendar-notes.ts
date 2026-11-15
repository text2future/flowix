import { useCallback, useMemo, useRef, useState } from 'react';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import type { PropertyKind } from '@/lib/property-types';
import { setDocumentProperties, compareAndPatchDocumentProperties } from '@features/document/public/path-properties';
import { reviseCollection } from '@features/collection/model';
import type { NoteEntry } from '@platform/tauri/client';
import { notePropertyEditorValue, calendarCreatePropertyValue } from './table-note-properties';
import { isoDate, calendarDateKey, calendarDateTimeForTimestamp } from './table-view-helpers';
import type { TableField, TableRecord } from './model';
import { createUuidV7 } from './model';
import { upsertTableRecord } from './table-view-helpers';
import { NOTE_CALENDAR_DATE_FIELDS } from './use-calendar-controller';
import type { useTableSession } from './use-table-session';

type TableSession = ReturnType<typeof useTableSession>;

export interface CalendarControllerPieces {
  dateFieldId: string | null;
  dateMetadata: (typeof NOTE_CALENDAR_DATE_FIELDS)[number] | null;
  openAddDialog: (date: string, anchorRect: DOMRect, fieldId: string) => void;
  closeAddDialog: () => void;
  setTitle: (title: string) => void;
  addDialog: { open: boolean; anchorRect: DOMRect | null; date: { fieldId: string; date: string } | null; title: string };
}

export interface UseTableCalendarNotesInput {
  session: Pick<TableSession,
    | 'document' | 'saving' | 'setSaving' | 'save' | 'loadSequenceRef' | 'isCurrentSession'
    | 'resolvedNotebookId' | 'setNotes' | 'reportSaveFailure'>;
  noteField: TableField | undefined;
  editable: boolean;
  notebookPath: string | null;
  calendar: CalendarControllerPieces;
  calendarWeekStart: number;
  calendarField: TableField | undefined;
  calendarCreateFields: TableField[];
  visibleRecords: TableRecord[];
  noteForRecord: (record: TableRecord) => NoteEntry | undefined;
  applyCalendarDateToNote: (note: NoteEntry, calendarDate: { fieldId: string; date: string } | null) => Promise<NoteEntry>;
  createNoteInNotebook: (title?: string) => Promise<{ entry: NoteEntry }>;
  renameLinkedNote: (recordId: string, note: NoteEntry, title: string) => Promise<NoteEntry | null>;
}

/**
 * Calendar note creation and editing popovers: the create form (with per-field
 * property values), the per-record edit dialog, and the month grid derivation.
 * Callback bodies are moved verbatim from `table-document-view.tsx`.
 */
export function useTableCalendarNotes(input: UseTableCalendarNotesInput) {
  const {
    session, editable, notebookPath, calendar, calendarWeekStart, calendarField,
    calendarCreateFields, visibleRecords, noteForRecord, applyCalendarDateToNote, createNoteInNotebook, renameLinkedNote,
  } = input;
  const { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, resolvedNotebookId,
    setNotes, reportSaveFailure } = session;
  const { noteField } = input;
  const { t } = useI18n();
  const { dateFieldId: calendarDateFieldId, dateMetadata: calendarDateMetadata } = calendar;

  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [calendarCreatePropertyValues, setCalendarCreatePropertyValues] = useState<Record<string, unknown>>({});
  const [calendarEditingRecord, setCalendarEditingRecord] = useState<TableRecord | null>(null);
  const calendarPendingCreatedNoteRef = useRef<{ title: string; entry: NoteEntry } | null>(null);

  const openCalendarNotePopover = useCallback((date: string, anchorRect: DOMRect, fieldId: string) => {
    calendarPendingCreatedNoteRef.current = null;
    setCalendarEditingRecord(null);
    setCalendarCreatePropertyValues(Object.fromEntries(calendarCreateFields.map((field) => [
      field.id,
      field.type === 'Date' && field.id === fieldId ? date
        : field.type === 'Boolean' ? false
          : field.type === 'MultiSelect' || field.type === 'Tag' || field.type === 'Color' || field.type === 'Image' ? []
            : '',
    ])));
    calendar.openAddDialog(date, anchorRect, fieldId);
  }, [calendar, calendarCreateFields]);

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

  const closeCalendarNoteDialog = useCallback(() => {
    calendarPendingCreatedNoteRef.current = null;
    setCalendarEditingRecord(null);
    calendar.closeAddDialog();
  }, [calendar]);

  const persistCalendarNote = useCallback(async (note: NoteEntry, calendarDate: { fieldId: string; date: string } | null, sequence: number) => {
    if (!editable || !document || !noteField || !isCurrentSession(sequence)) return false;
    const datedNote = await applyCalendarDateToNote(note, calendarDate);
    if (!isCurrentSession(sequence)) return false;
    const noteKey = datedNote.relativePath.replace(/\\/g, '/');
    const now = new Date().toISOString();
    const record: TableRecord = { id: `rec_${createUuidV7()}`, updated_at: now, note_path: noteKey };
    const records = upsertTableRecord(document.dataset.records.include, record);
    setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), datedNote]);
    const saved = await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, true, sequence);
    if (saved && isCurrentSession(sequence)) {
      calendar.closeAddDialog();
    }
    return saved;
  }, [applyCalendarDateToNote, calendar, document, editable, isCurrentSession, noteField, save, setNotes]);

  const createCalendarNote = useCallback(async () => {
    const title = calendar.addDialog.title.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !calendar.addDialog.date || !title || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      let pending = calendarPendingCreatedNoteRef.current;
      if (!pending || pending.title !== title) {
        const created = await createNoteInNotebook(title);
        if (!isCurrentSession(sequence)) return;
        pending = { title, entry: created.entry };
        calendarPendingCreatedNoteRef.current = pending;
      }
      let note = await applyCalendarDateToNote(pending.entry, calendar.addDialog.date);
      if (!isCurrentSession(sequence)) return;
      const properties: Record<string, unknown> = {};
      const types: Record<string, PropertyKind | null | undefined> = {};
      for (const field of calendarCreateFields) {
        if (field.type === 'primary' || !field.property_key) continue;
        const property = calendarCreatePropertyValue(field, calendarCreatePropertyValues[field.id]);
        if (!property.include) continue;
        properties[field.property_key] = property.value;
        types[field.property_key] = field.type;
      }
      if (Object.keys(properties).length) {
        const path = notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
        if (!path || !await setDocumentProperties(path, properties, types)) throw new Error('笔记属性未能保存');
        note = { ...note, updatedAt: Date.now(), properties: { ...note.properties, ...properties } };
      }
      const saved = await persistCalendarNote(note, null, sequence);
      if (saved && calendarPendingCreatedNoteRef.current?.entry.relativePath === pending.entry.relativePath) {
        calendarPendingCreatedNoteRef.current = null;
      }
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableCreateLink'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [applyCalendarDateToNote, calendar, calendarCreateFields, calendarCreatePropertyValues, createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, noteField, notebookPath, persistCalendarNote, resolvedNotebookId, saving, setSaving, reportSaveFailure]);

  const openCalendarEditPopover = useCallback((recordId: string, anchorRect: DOMRect) => {
    const record = visibleRecords.find((item) => item.id === recordId);
    const note = record ? noteForRecord(record) : undefined;
    if (!record || !note) {
      toast.warning('无法找到这篇笔记');
      return;
    }
    if (!editable) {
      toast.warning('当前多维表格为只读状态');
      return;
    }
    const dateValue = calendarDateMetadata
      ? calendarDateTimeForTimestamp(note[calendarDateMetadata.timestamp])
      : calendarField ? notePropertyEditorValue(note, calendarField) : null;
    const date = calendarDateKey(dateValue) ?? isoDate(new Date());
    setCalendarEditingRecord(record);
    setCalendarCreatePropertyValues(Object.fromEntries(calendarCreateFields.map((field) => {
      const value = notePropertyEditorValue(note, field);
      return [field.id, value ?? (field.type === 'Boolean' ? false : field.type === 'MultiSelect' || field.type === 'Tag' || field.type === 'Color' || field.type === 'Image' ? [] : '')];
    })));
    calendar.openAddDialog(date, anchorRect, calendarDateFieldId ?? '');
    calendar.setTitle(note.title);
  }, [calendar, calendarCreateFields, calendarDateFieldId, calendarDateMetadata, calendarField, editable, noteForRecord, visibleRecords]);

  const saveCalendarNoteEdit = useCallback(async () => {
    const record = calendarEditingRecord;
    const initialNote = record ? noteForRecord(record) : undefined;
    const title = calendar.addDialog.title.trim();
    if (!record || !initialNote || !editable || !document || !title || saving) return;
    const sequence = loadSequenceRef.current;
    try {
      const note = title === initialNote.title ? initialNote : await renameLinkedNote(record.id, initialNote, title);
      if (!note || !isCurrentSession(sequence)) return;
      if (note.relativePath.replace(/\\/g, '/') !== record.note_path.replace(/\\/g, '/')) {
        setCalendarEditingRecord((current) => current?.id === record.id
          ? { ...current, note_path: note.relativePath.replace(/\\/g, '/') }
          : current);
      }
      if (!notebookPath) throw new Error('无法确定笔记路径');
      const path = joinNotebookMemoPath(notebookPath, note.relativePath);
      if (!path) throw new Error('无法确定笔记路径');
      const expected: Record<string, { exists: boolean; value?: unknown }> = {};
      const next: Record<string, { exists: boolean; value?: unknown }> = {};
      const types: Record<string, PropertyKind> = {};
      for (const field of calendarCreateFields) {
        if (!field.property_key) continue;
        const key = field.property_key;
        const property = calendarCreatePropertyValue(field, calendarCreatePropertyValues[field.id]);
        expected[key] = {
          exists: Object.prototype.hasOwnProperty.call(note.properties, key),
          value: note.properties[key],
        };
        next[key] = property.include ? { exists: true, value: property.value } : { exists: false };
        types[key] = field.type as PropertyKind;
      }
      setSaving(true);
      const saved = Object.keys(next).length
        ? await compareAndPatchDocumentProperties(path, expected, next, types)
        : true;
      if (!saved) throw new Error('笔记属性未能保存');
      if (!isCurrentSession(sequence)) return;
      const properties = { ...note.properties };
      for (const [key, state] of Object.entries(next)) {
        if (state.exists) properties[key] = state.value;
        else delete properties[key];
      }
      setNotes((current) => current.map((item) => item.relativePath.replace(/\\/g, '/') === note.relativePath.replace(/\\/g, '/')
        ? { ...note, updatedAt: Date.now(), properties }
        : item));
      closeCalendarNoteDialog();
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.noteEdit'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [calendar, calendarCreateFields, calendarCreatePropertyValues, calendarEditingRecord, closeCalendarNoteDialog, document, editable, isCurrentSession, loadSequenceRef, noteForRecord, notebookPath, renameLinkedNote, reportSaveFailure, saving, setCalendarEditingRecord, setNotes, setSaving]);

  return {
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
  };
}
