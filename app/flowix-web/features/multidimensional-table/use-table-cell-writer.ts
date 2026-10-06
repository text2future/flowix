import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { NoteEntry } from '@platform/tauri/client';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import type { TableField, TableRecord } from './model';

export interface TableCellSaveStatus {
  saving: boolean;
  error?: string;
}

interface TableCellWriteRequest {
  path: string;
  propertyValue: unknown;
}

interface TableCellWriteQueue {
  sequence: number;
  pending: TableCellWriteRequest | null;
  notePathKey: string;
  propertyKey: string;
  rollbackValueExists: boolean;
  rollbackValue: unknown;
  cells: Map<string, { recordId: string; fieldId: string }>;
}

interface TableCellWriterOptions {
  enabled: boolean;
  loadGeneration: number;
  notebookPath: string | null;
  loadSequenceRef: MutableRefObject<number>;
  setNotes: Dispatch<SetStateAction<NoteEntry[]>>;
  pendingNotePropertiesRef?: MutableRefObject<Map<string, Set<string>>>;
}

export function useTableCellWriter({ enabled, loadGeneration, notebookPath, loadSequenceRef, setNotes, pendingNotePropertiesRef }: TableCellWriterOptions) {
  const [cellStatusesByRecord, setCellStatusesByRecord] = useState<Map<string, ReadonlyMap<string, TableCellSaveStatus>>>(() => new Map());
  const cellWriteQueuesRef = useRef(new Map<string, TableCellWriteQueue>());

  useEffect(() => {
    setCellStatusesByRecord(new Map());
  }, [loadGeneration]);

  const updateCellStatus = useCallback((recordId: string, fieldId: string, status: TableCellSaveStatus | null) => {
    setCellStatusesByRecord((current) => {
      const rowStatuses = new Map(current.get(recordId) ?? []);
      if (status) rowStatuses.set(fieldId, status);
      else rowStatuses.delete(fieldId);
      const next = new Map(current);
      if (rowStatuses.size > 0) next.set(recordId, rowStatuses);
      else next.delete(recordId);
      return next;
    });
  }, []);

  const updateCell = useCallback((record: TableRecord, note: NoteEntry | undefined, field: TableField, value: unknown) => {
    if (!enabled || field.type === 'primary') return;
    const sequence = loadSequenceRef.current;
    const path = note && notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
    if (!note || !path) {
      toast.error('找不到关联笔记，无法保存属性');
      updateCellStatus(record.id, field.id, { saving: false, error: '找不到关联笔记，无法保存属性' });
      return;
    }

    const propertyKey = field.property_key ?? '';
    const lockKey = `${notebookPath}\u0000${note.relativePath.replace(/\\/g, '/')}\u0000${propertyKey}`;
    const propertyValue = field.type === 'Select'
      ? field.options?.find((option) => option.id === value)?.label ?? null
      : field.type === 'MultiSelect' && Array.isArray(value)
        ? value.map((id) => field.options?.find((option) => option.id === id)?.label ?? id)
        : value;
    const notePathKey = note.relativePath.replace(/\\/g, '/');
    if (pendingNotePropertiesRef) {
      const pendingProperties = pendingNotePropertiesRef.current.get(notePathKey) ?? new Set<string>();
      pendingProperties.add(propertyKey);
      pendingNotePropertiesRef.current.set(notePathKey, pendingProperties);
    }
    const cellKey = `${record.id}\u0000${field.id}`;
    const existingQueue = cellWriteQueuesRef.current.get(lockKey);
    const isNewQueue = !existingQueue;
    const queue: TableCellWriteQueue = existingQueue ?? {
      sequence,
      pending: null,
      notePathKey,
      propertyKey,
      rollbackValueExists: Object.prototype.hasOwnProperty.call(note.properties, propertyKey),
      rollbackValue: note.properties[propertyKey],
      cells: new Map(),
    };
    if (isNewQueue) cellWriteQueuesRef.current.set(lockKey, queue);
    else if (queue.sequence !== sequence) {
      queue.sequence = sequence;
      queue.cells.clear();
    }
    queue.pending = { path, propertyValue };
    queue.cells.set(cellKey, { recordId: record.id, fieldId: field.id });
    updateCellStatus(record.id, field.id, { saving: true });
    setNotes((current) => current.map((item) => item.relativePath.replace(/\\/g, '/') === notePathKey
      ? { ...item, properties: { ...item.properties, [propertyKey]: propertyValue } }
      : item));

    if (!isNewQueue) return;
    void (async () => {
      let failure: string | null = null;
      while (queue.pending) {
        const request = queue.pending;
        queue.pending = null;
        try {
          if (!await setDocumentProperties(request.path, { [queue.propertyKey]: request.propertyValue })) {
            throw new Error('笔记属性未能保存');
          }
          queue.rollbackValueExists = true;
          queue.rollbackValue = request.propertyValue;
          failure = null;
        } catch (error) {
          failure = error instanceof Error ? error.message : '保存笔记属性失败';
          if (!queue.pending) break;
        }
      }

      if (failure && queue.sequence === loadSequenceRef.current) {
        setNotes((current) => current.map((item) => {
          if (item.relativePath.replace(/\\/g, '/') !== queue.notePathKey) return item;
          const properties = { ...item.properties };
          if (queue.rollbackValueExists) properties[queue.propertyKey] = queue.rollbackValue;
          else delete properties[queue.propertyKey];
          return { ...item, properties };
        }));
        toast.error(failure);
      } else if (!failure && queue.sequence === loadSequenceRef.current) {
        toast.success('保存完成');
      }

      if (queue.sequence === loadSequenceRef.current) for (const cell of queue.cells.values()) {
        updateCellStatus(cell.recordId, cell.fieldId, failure ? { saving: false, error: failure } : null);
      }
      if (cellWriteQueuesRef.current.get(lockKey) === queue) cellWriteQueuesRef.current.delete(lockKey);
      if (![...cellWriteQueuesRef.current.values()].some((item) => item.notePathKey === notePathKey && item.propertyKey === queue.propertyKey)) {
        const pendingProperties = pendingNotePropertiesRef?.current.get(notePathKey);
        pendingProperties?.delete(queue.propertyKey);
        if (pendingProperties?.size === 0) pendingNotePropertiesRef?.current.delete(notePathKey);
      }
    })();
  }, [enabled, loadSequenceRef, notebookPath, pendingNotePropertiesRef, setNotes, updateCellStatus]);

  return { cellStatusesByRecord, updateCell };
}
