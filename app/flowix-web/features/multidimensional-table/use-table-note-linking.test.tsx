import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createTableDocument, type TableRecord } from './model';
import { useTableNoteLinking, type UseTableNoteLinkingInput } from './use-table-note-linking';
import type { NoteEntry } from '@platform/tauri/client';

const mocks = vi.hoisted(() => ({ pruneMissing: vi.fn(), error: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ notes: { pruneMissing: mocks.pruneMissing }, files: {} }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error } }));

it('requests confirmed physical note deletion without excluding or saving the record', async () => {
  const table = createTableDocument();
  const record: TableRecord = { id: 'rec_1', note_path: 'database/test/note.md', updated_at: new Date().toISOString() };
  table.dataset.records.include = [record];
  const note = { relativePath: record.note_path, title: 'note' } as NoteEntry;
  const save = vi.fn();
  const input = {
    session: { document: table, saving: false, save, resolvedNotebookId: 'nb' },
    editable: true, notebookId: 'nb', notebookPath: '/book', visibleRecords: [record], noteForRecord: () => note,
  } as unknown as UseTableNoteLinkingInput;
  let linking!: ReturnType<typeof useTableNoteLinking>;
  function Probe() { linking = useTableNoteLinking(input); return null; }
  const listener = vi.fn();
  window.addEventListener('flowix:request-delete-memo', listener);
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    act(() => linking.deleteRecord(record.id));
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ notebookId: 'nb', relativePath: record.note_path });
    expect(save).not.toHaveBeenCalled();
    expect(table.dataset.records.exclude).toEqual([]);
  } finally {
    window.removeEventListener('flowix:request-delete-memo', listener);
    act(() => root.unmount());
  }
});

it('removes an explicitly linked row without requesting deletion of its file', async () => {
  const table = createTableDocument();
  const record: TableRecord = { id: 'rec_1', note_path: 'database/test/note.md', updated_at: new Date().toISOString() };
  table.dataset.records.include = [record];
  const save = vi.fn();
  const note = { relativePath: record.note_path, title: 'note' } as NoteEntry;
  const input = {
    session: { document: table, saving: false, save, resolvedNotebookId: 'nb' },
    editable: true, notebookId: 'nb', notebookPath: '/book', currentFilePath: '/book/table.md',
    visibleRecords: [record], noteForRecord: () => note,
  } as unknown as UseTableNoteLinkingInput;
  let linking!: ReturnType<typeof useTableNoteLinking>;
  function Probe() { linking = useTableNoteLinking(input); return null; }
  const listener = vi.fn();
  window.addEventListener('flowix:request-delete-memo', listener);
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => linking.removeTableRow(record.id));
    expect(listener).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].dataset.records.include).toEqual([]);
  } finally {
    window.removeEventListener('flowix:request-delete-memo', listener);
    act(() => root.unmount());
  }
});

it('excludes an automatically collected row instead of removing its source note', async () => {
  const table = createTableDocument();
  const field = { id: 'fld_00000000000000000000000000000002', type: 'Text' as const, property_key: 'status', name: 'Status' };
  table.dataset.schema.fields.push(field);
  table.dataset.filter = { all: [{ field: field.property_key, op: 'eq', value: 'done' }], any: [] };
  const record: TableRecord = { id: 'rec_1', note_path: 'folder/note.md', updated_at: new Date().toISOString() };
  table.dataset.records.include = [record];
  const note = { relativePath: record.note_path, title: 'note', properties: { [field.property_key ?? '']: 'done' } } as NoteEntry;
  const save = vi.fn();
  const input = {
    session: { document: table, saving: false, save, resolvedNotebookId: 'nb' },
    editable: true, notebookId: 'nb', notebookPath: '/book', currentFilePath: '/book/table.md',
    visibleRecords: [record], collectionFilterFields: [field], noteForRecord: () => note,
  } as unknown as UseTableNoteLinkingInput;
  let linking!: ReturnType<typeof useTableNoteLinking>;
  function Probe() { linking = useTableNoteLinking(input); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => linking.removeTableRow(record.id));
    const next = save.mock.calls[0][0];
    expect(next.dataset.records.include).toEqual([record]);
    expect(next.dataset.records.exclude).toEqual([{ note_path: record.note_path }]);
  } finally { act(() => root.unmount()); }
});

it('removes an empty draft without requesting deletion of a file', async () => {
  const table = createTableDocument();
  const record: TableRecord = { id: 'rec_1', note_path: '', updated_at: new Date().toISOString() };
  table.dataset.records.include = [record];
  const save = vi.fn();
  const input = { session: { document: table, saving: false, save }, editable: true, visibleRecords: [record], noteForRecord: () => undefined } as unknown as UseTableNoteLinkingInput;
  let linking!: ReturnType<typeof useTableNoteLinking>;
  function Probe() { linking = useTableNoteLinking(input); return null; }
  const listener = vi.fn();
  window.addEventListener('flowix:request-delete-memo', listener);
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    act(() => { void linking.deleteTableRow(record.id); });
    expect(listener).not.toHaveBeenCalled();
    expect(save.mock.calls[0][0].dataset.records.include).toEqual([]);
  } finally {
    window.removeEventListener('flowix:request-delete-memo', listener);
    act(() => root.unmount());
  }
});
