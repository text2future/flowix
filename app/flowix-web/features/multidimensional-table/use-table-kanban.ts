import { useCallback, useMemo } from 'react';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { reviseCollection } from '@features/collection/model';
import { removeDocumentProperty, setDocumentProperties } from '@features/document/public/path-properties';
import type { NoteEntry } from '@platform/tauri/client';
import { isMarkdownNoteDragResource, type NotebookNoteDragResource } from '@features/memo/public/drag-resource-api';
import { createUuidV7, type MultidimensionalTableDocument, type TableField, type TableRecord } from './model';
import { groupRecordsByValue, KANBAN_UNASSIGNED_GROUP_ID } from './view-index';
import { notePropertyEditorValue } from './table-note-properties';
import { upsertTableRecord } from './table-view-helpers';
import type { useTableSession } from './use-table-session';

type TableSession = ReturnType<typeof useTableSession>;

export interface UseTableKanbanInput {
  session: Pick<TableSession,
    | 'document' | 'saving' | 'setSaving' | 'save' | 'loadSequenceRef' | 'isCurrentSession'
    | 'resolvedNotebookId' | 'notes' | 'setNotes' | 'reportSaveFailure'>;
  noteField: TableField | undefined;
  editable: boolean;
  notebookPath: string | null;
  currentFilePath: string;
  groupField: TableField | undefined;
  datasetRecords: TableRecord[];
  visibleRecords: TableRecord[];
  secondaryViewRecords: TableRecord[];
  noteForRecord: (record: TableRecord) => NoteEntry | undefined;
  createNoteInNotebook: (title?: string) => Promise<{ entry: NoteEntry }>;
  renameLinkedNote: (recordId: string, note: NoteEntry, title: string) => Promise<NoteEntry | null>;
  setPendingKanbanOption: (option: { id: string; label: string } | null) => void;
  setMatchingOpen: (open: boolean) => void;
  setFieldPanelHeaderId: (fieldId: string | null) => void;
}

/**
 * Kanban view logic: grouping, lane add/reorder, task creation (blank or from
 * external note drops) and record drops across lanes. Callback bodies are
 * moved verbatim from `table-document-view.tsx`.
 */
export function useTableKanban(input: UseTableKanbanInput) {
  const {
    session, noteField, editable, notebookPath, currentFilePath, groupField, datasetRecords, visibleRecords,
    secondaryViewRecords, noteForRecord, createNoteInNotebook, renameLinkedNote,
    setPendingKanbanOption, setMatchingOpen, setFieldPanelHeaderId,
  } = input;
  const { document, saving, setSaving, save, loadSequenceRef, isCurrentSession, resolvedNotebookId,
    notes, setNotes, reportSaveFailure } = session;
  const { t } = useI18n();

  const kanbanGroups = useMemo(() => document && groupField?.type === 'Select'
    ? groupRecordsByValue(secondaryViewRecords, (record) => notePropertyEditorValue(noteForRecord(record), groupField))
    : new Map<string, TableRecord[]>(), [document, groupField, noteForRecord, secondaryViewRecords]);
  const kanbanUnassignedRecords = useMemo(() => {
    if (!document || groupField?.type !== 'Select') return [];
    const assignedIds = new Set((groupField.options ?? []).flatMap((option) => kanbanGroups.get(option.id) ?? []).map((record) => record.id));
    return secondaryViewRecords.filter((record) => !assignedIds.has(record.id));
  }, [document, groupField, kanbanGroups, secondaryViewRecords]);

  const addKanbanLane = useCallback(() => {
    if (!editable || saving || groupField?.type !== 'Select') return;
    const existingLabels = new Set((groupField.options ?? []).map((option) => option.label.trim()));
    let number = 1;
    while (existingLabels.has(`选项 ${number}`)) number += 1;
    const option = { id: `opt_${createUuidV7()}`, label: `选项 ${number}` };
    setPendingKanbanOption(option);
    setMatchingOpen(true);
    setFieldPanelHeaderId(groupField.id);
  }, [editable, groupField, saving, setPendingKanbanOption, setMatchingOpen, setFieldPanelHeaderId]);

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
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.map((field) => field.id === groupField.id ? updatedField : field) } },
    };
    await save(next);
  }, [document, groupField, save, saving]);

  const addKanbanTask = useCallback(async (targetGroupId: string) => {
    if (!editable || !document || !noteField || !resolvedNotebookId || groupField?.type !== 'Select' || saving) return;
    const targetIsUnassigned = targetGroupId === KANBAN_UNASSIGNED_GROUP_ID;
    const targetOption = groupField.options?.find((option) => option.id === targetGroupId);
    if (!targetIsUnassigned && !targetOption) return;
    if (!targetIsUnassigned && !groupField.property_key) {
      toast.error('状态字段未配置属性键，无法创建任务');
      return;
    }

    const nextTaskNumber = datasetRecords.reduce((max, record) => {
      const title = noteForRecord(record)?.title ?? '';
      const match = /^未命名任务\s+(\d+)$/.exec(title.trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    const title = `未命名任务 ${nextTaskNumber}`;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(title);
      if (!isCurrentSession(sequence)) return;
      let note = created.entry;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      if (targetOption) {
        const path = notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
        if (!path || !await setDocumentProperties(path, { [groupField.property_key!]: targetOption.label }, { [groupField.property_key!]: 'Select' })) {
          throw new Error('任务已创建，但无法设置状态');
        }
        note = { ...note, properties: { ...note.properties, [groupField.property_key!]: targetOption.label } };
      }
      const record: TableRecord = {
        id: `rec_${createUuidV7()}`,
        updated_at: new Date().toISOString(),
        note_path: noteKey,
      };
      const records = upsertTableRecord(document.dataset.records.include, record);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      }, true, sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.taskCreate'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, datasetRecords, document, editable, groupField, isCurrentSession, loadSequenceRef, noteForRecord, notebookPath, reportSaveFailure, resolvedNotebookId, save, saving, setNotes, setSaving, t]);

  const addExternalNotesToKanban = useCallback(async (
    draggedNotes: NotebookNoteDragResource[],
    targetGroupId: string,
    beforeRecordId: string | null,
  ) => {
    if (!editable || !document || !noteField || !notebookPath || !resolvedNotebookId
      || groupField?.type !== 'Select' || saving) return;
    const targetIsUnassigned = targetGroupId === KANBAN_UNASSIGNED_GROUP_ID;
    const targetOption = groupField.options?.find((option) => option.id === targetGroupId);
    if (!targetIsUnassigned && !targetOption) return;
    if (!targetIsUnassigned && !groupField.property_key) {
      toast.error('状态字段未配置属性键，无法加入任务');
      return;
    }
    const uniqueNotes = [...new Map(draggedNotes.map((note) => [canonicalPath(note.relativePath), note])).values()];
    const resolved = uniqueNotes.map((draggedNote) => {
      if (!isMarkdownNoteDragResource(draggedNote) || draggedNote.notebookId !== resolvedNotebookId) return null;
      const relativePath = canonicalPath(draggedNote.relativePath).replace(/^\/+/, '');
      const note = notes.find((item) => item.relativePath.replace(/\\/g, '/') === relativePath);
      if (!note) return null;
      return { note, relativePath };
    });
    if (!resolved.length || resolved.some((item) => !item)) {
      toast.warning(t('memo.fileTree.kanbanDropUnsupported'));
      return;
    }
    const sequence = loadSequenceRef.current;
    if (!isCurrentSession(sequence)) return;
    setSaving(true);
    try {
      for (const item of resolved) {
        if (!item || !isCurrentSession(sequence)) return;
        const path = joinNotebookMemoPath(notebookPath, item.relativePath);
        if (!path) throw new Error('无法确定笔记路径');
        if (groupField.property_key) {
          const saved = targetOption
            ? await setDocumentProperties(path, { [groupField.property_key]: targetOption.label }, { [groupField.property_key]: 'Select' })
            : !Object.prototype.hasOwnProperty.call(item.note.properties, groupField.property_key)
              || await removeDocumentProperty(path, groupField.property_key);
          if (!saved) throw new Error('笔记的分组属性未能保存');
        }
        if (!isCurrentSession(sequence)) return;
        setNotes((current) => current.map((note) => {
          if (note.relativePath.replace(/\\/g, '/') !== item.relativePath) return note;
          const properties = { ...note.properties };
          if (groupField.property_key) {
            if (targetOption) properties[groupField.property_key] = targetOption.label;
            else delete properties[groupField.property_key];
          }
          return { ...note, properties };
        }));
      }

      const linkedRecords: TableRecord[] = [];
      const now = new Date().toISOString();
      for (const item of resolved) {
        if (!item) continue;
        const existing = datasetRecords.find((record) => record.note_path.replace(/\\/g, '/') === item.relativePath);
        const linkedRecord = existing
          ? { ...existing, updated_at: now, note_path: item.relativePath }
          : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: item.relativePath };
        linkedRecords.push(linkedRecord);
      }
      const linkedIds = new Set(linkedRecords.map((record) => record.id));
      const recordsWithoutDropped = document.dataset.records.include.filter((record) => !linkedIds.has(record.id));
      let insertAt = beforeRecordId
        ? recordsWithoutDropped.findIndex((record) => record.id === beforeRecordId)
        : -1;
      if (insertAt < 0) {
        const targetRecords = (targetGroupId === KANBAN_UNASSIGNED_GROUP_ID
          ? kanbanUnassignedRecords
          : kanbanGroups.get(targetGroupId) ?? []).filter((record) => !linkedIds.has(record.id));
        const lastTargetRecord = targetRecords[targetRecords.length - 1];
        const lastTargetIndex = lastTargetRecord
          ? recordsWithoutDropped.findIndex((record) => record.id === lastTargetRecord.id)
          : -1;
        insertAt = lastTargetIndex >= 0 ? lastTargetIndex + 1 : recordsWithoutDropped.length;
      }
      const records = [
        ...recordsWithoutDropped.slice(0, insertAt),
        ...linkedRecords,
        ...recordsWithoutDropped.slice(insertAt),
      ];
      const next: MultidimensionalTableDocument = {
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      };
      if (!await save(next, true, sequence) || !isCurrentSession(sequence)) {
        toast.error(t('multidimensionalTable.kanbanDropFailed'));
      }
    } catch (error) {
      if (isCurrentSession(sequence)) toast.error(friendlyErrorMessage(error, t, 'errors.friendly.noteMove'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [currentFilePath, datasetRecords, document, editable, groupField, isCurrentSession, kanbanGroups, kanbanUnassignedRecords, loadSequenceRef, notes, notebookPath, resolvedNotebookId, save, saving, setNotes, setSaving, t]);

  const dropKanbanRecord = useCallback(async (recordId: string, targetGroupId: string, beforeRecordId: string | null) => {
    if (!editable || !document || groupField?.type !== 'Select' || saving) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    const targetIsUnassigned = targetGroupId === KANBAN_UNASSIGNED_GROUP_ID;
    const targetOption = groupField.options?.find((option) => option.id === targetGroupId);
    if (!record || (!targetIsUnassigned && !targetOption)) return;
    const isPersistedRecord = document.dataset.records.include.some((item) => item.id === recordId);
    const note = noteForRecord(record);
    const sourceGroupId = notePropertyEditorValue(note, groupField);
    const sourceGroupKey = groupField.options?.some((option) => option.id === sourceGroupId)
      ? String(sourceGroupId)
      : KANBAN_UNASSIGNED_GROUP_ID;
    const propertyKey = groupField.property_key;
    const recordNoteKey = record.note_path.replace(/\\/g, '/');
    const path = notebookPath && recordNoteKey ? joinNotebookMemoPath(notebookPath, record.note_path) : null;
    const updateNoteGroupValue = async () => {
      if (!propertyKey || !path) return false;
      return targetIsUnassigned
        ? removeDocumentProperty(path, propertyKey)
        : setDocumentProperties(path, { [propertyKey]: targetOption!.label }, { [propertyKey]: 'Select' });
    };
    const updateLocalNoteGroupValue = (noteKey: string) => {
      setNotes((current) => current.map((item) => {
        if (item.relativePath.replace(/\\/g, '/') !== noteKey) return item;
        const properties = { ...item.properties };
        if (targetIsUnassigned) delete properties[propertyKey!];
        else properties[propertyKey!] = targetOption!.label;
        return { ...item, properties };
      }));
    };
    if (!isPersistedRecord) {
      if (sourceGroupKey === targetGroupId) return;
      if (!propertyKey || !path) return;
      const sequence = loadSequenceRef.current;
      setSaving(true);
      try {
        if (!await updateNoteGroupValue()) throw new Error('笔记的单选属性未能保存');
        if (!isCurrentSession(sequence)) return;
        updateLocalNoteGroupValue(recordNoteKey);
      } catch (error) {
        reportSaveFailure(sequence);
        if (isCurrentSession(sequence)) toast.error(friendlyErrorMessage(error, t, 'errors.friendly.noteMove'));
      } finally {
        if (isCurrentSession(sequence)) setSaving(false);
      }
      return;
    }

    const targetGroup = (targetIsUnassigned ? kanbanUnassignedRecords : kanbanGroups.get(targetGroupId) ?? []).filter((item) => item.id !== recordId);
    const recordsWithoutDragged = document.dataset.records.include.filter((item) => item.id !== recordId);
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
    const orderChanged = records.some((item, index) => item.id !== document.dataset.records.include[index]?.id);
    if (!orderChanged && sourceGroupKey === targetGroupId) return;

    if (sourceGroupKey === targetGroupId) {
      await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } });
      return;
    }

    if (!propertyKey || !path) {
      toast.error('无法定位笔记文件，无法更新分组属性');
      return;
    }
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      if (!await updateNoteGroupValue()) {
        throw new Error('笔记的单选属性未能保存');
      }
      if (!isCurrentSession(sequence)) return;
      updateLocalNoteGroupValue(recordNoteKey);
      if (orderChanged) await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, true, sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      if (isCurrentSession(sequence)) toast.error(friendlyErrorMessage(error, t, 'errors.friendly.noteMove'));
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [document, editable, groupField, isCurrentSession, kanbanGroups, kanbanUnassignedRecords, loadSequenceRef, noteForRecord, notebookPath, save, saving, setNotes, setSaving, visibleRecords, reportSaveFailure]);

  const renameKanbanRecord = useCallback(async (recordId: string, title: string) => {
    const record = visibleRecords.find((item) => item.id === recordId);
    const note = record ? noteForRecord(record) : undefined;
    if (!record || !note) return;
    // The shared rename operation updates table references and emits the collection change event.
    await renameLinkedNote(recordId, note, title);
  }, [noteForRecord, renameLinkedNote, visibleRecords]);

  return {
    kanbanGroups,
    kanbanUnassignedRecords,
    addKanbanLane,
    reorderKanbanLane,
    addKanbanTask,
    addExternalNotesToKanban,
    dropKanbanRecord,
    renameKanbanRecord,
  };
}
