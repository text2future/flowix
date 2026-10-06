import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import type { TableField, TableRecord } from './model';

vi.mock('@shared/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
}));

import { TableRecordRow } from './table-record-row';

const record: TableRecord = {
  id: `rec_${'a'.repeat(32)}`,
  updated_at: '',
  note_path: 'missing.md',
};
const fields: TableField[] = [
  { id: `fld_${'b'.repeat(32)}`, type: 'primary', property_key: 'note' },
  { id: `fld_${'c'.repeat(32)}`, type: 'Boolean', property_key: 'done' },
];
const linkedNote = {
  relativePath: 'missing.md',
  title: 'Missing',
  properties: { done: false },
} as unknown as NoteEntry;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderRow(noteStatus: 'draft' | 'linked' | 'unknown' | 'missing', note?: NoteEntry) {
  container = document.createElement('div');
  root = createRoot(container);
  const handlers = {
    openNotePicker: vi.fn(),
    retryNoteLookup: vi.fn(),
  };
  act(() => root?.render(<table><tbody><TableRecordRow
    record={{ ...record, note_path: noteStatus === 'draft' ? '' : record.note_path }}
    imagePaths={() => []}
    fieldColumnWidth={() => 'w-40'}
    notePropertyEditorValue={(currentNote, field) => field.type === 'primary' ? currentNote?.relativePath : currentNote?.properties.done}
    fields={fields}
    note={note}
    isRuleLinked={false}
    notebookPath="/notebook"
    getAvailableNotes={() => []}
    subscribeAvailableNotes={() => () => {}}
    noteStatus={noteStatus}
    autoOpenPrimaryEditor={false}
    imageUrls={{}}
    saving={false}
    cellStatuses={new Map()}
    rowActionOpen={false}
    onOpenNotePicker={handlers.openNotePicker}
    onRetryNoteLookup={handlers.retryNoteLookup}
    onReplaceNote={vi.fn()}
    onCreateAndLinkRecordNote={vi.fn(async () => true)}
    onAutoOpenHandled={vi.fn()}
    onRenameNote={vi.fn(async () => null)}
    onOpenNote={vi.fn()}
    onSelectImage={vi.fn(async () => {})}
    onUpdateCell={vi.fn()}
    onDeleteRecord={vi.fn()}
    onRowActionOpenChange={vi.fn()}
  /></tbody></table>));
  return { container, ...handlers };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
});

describe('TableRecordRow note fallback', () => {
  it('offers retry and disables property edits when note-list status is unknown', () => {
    const view = renderRow('unknown');
    const retry = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('无法确认关联状态'));
    expect(retry).toBeTruthy();
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);

    act(() => retry?.click());
    expect(view.retryNoteLookup).toHaveBeenCalledOnce();
    expect(view.openNotePicker).not.toHaveBeenCalled();
  });

  it('keeps a missing relation and lets the user replace it while disabling property edits', () => {
    const view = renderRow('missing');
    const replace = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('未在笔记列表找到'));
    expect(replace).toBeTruthy();
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);

    act(() => replace?.click());
    expect(view.openNotePicker).toHaveBeenCalledOnce();
  });

  it('keeps property editing enabled for a resolved note', () => {
    const view = renderRow('linked', linkedNote);
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(false);
  });

  it('disables property editing in an unlinked draft row', () => {
    const view = renderRow('draft');
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
  });
});
