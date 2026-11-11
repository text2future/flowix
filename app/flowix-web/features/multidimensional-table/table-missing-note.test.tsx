import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createTableDocument, type TableRecord } from './model';
import { useTableNoteLinking, type UseTableNoteLinkingInput } from './use-table-note-linking';

const mocks = vi.hoisted(() => ({ pruneMissing: vi.fn(), error: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ notes: { pruneMissing: mocks.pruneMissing }, files: {} }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error } }));

it.each([
  ['missingCleaned', '操作笔记已不存在'],
  ['present', '笔记仍然存在，请刷新后重试'],
])('checks disk before cleaning a missing note: %s', async (result, message) => {
  mocks.error.mockClear();
  mocks.pruneMissing.mockReset().mockResolvedValue(result);
  const record: TableRecord = { id: 'rec_1', note_path: 'folder/note.md', updated_at: new Date().toISOString() };
  const table = createTableDocument();
  table.dataset.records.include = [record];
  const save = vi.fn();
  const input = { session: { document: table, saving: false, save }, notebookPath: '/book', editable: true, visibleRecords: [record], noteForRecord: () => undefined } as unknown as UseTableNoteLinkingInput;
  let linking!: ReturnType<typeof useTableNoteLinking>;
  function Probe() { linking = useTableNoteLinking(input); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => linking.cleanMissingRecord(record));
    expect(mocks.pruneMissing).toHaveBeenCalledWith('/book/folder/note.md');
    expect(mocks.error).toHaveBeenCalledWith(message);
    if (result === 'missingCleaned') expect(save).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); }
});

it('does not report missing when verification fails', async () => {
  mocks.error.mockClear();
  mocks.pruneMissing.mockReset().mockRejectedValue(new Error('access denied'));
  const record: TableRecord = { id: 'rec_1', note_path: 'folder/note.md', updated_at: new Date().toISOString() };
  const input = { session: { document: createTableDocument(), saving: false }, notebookPath: '/book' } as unknown as UseTableNoteLinkingInput;
  let linking!: ReturnType<typeof useTableNoteLinking>;
  function Probe() { linking = useTableNoteLinking(input); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => linking.cleanMissingRecord(record));
    expect(mocks.error).not.toHaveBeenCalledWith('操作笔记已不存在');
    expect(mocks.error).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); }
});
