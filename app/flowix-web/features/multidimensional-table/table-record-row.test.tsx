import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import type { TableField, TableRecord } from './model';

vi.mock('@shared/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => renderPopupContent ? <>{children}</> : null,
}));

import { BUILTIN_TABLE_FIELDS, NOTE_PATH_FIELD_ID, NOTE_SIZE_FIELD_ID, builtinPresetTableField } from './builtin-fields';
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

let renderPopupContent = false;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderRow(noteStatus: 'draft' | 'linked' | 'unknown' | 'missing', note?: NoteEntry, showBuiltinFields = false, allowSwitchNote = true, options: { autoOpen?: boolean; availableNotes?: NoteEntry[] } = {}) {
  container = document.createElement('div');
  root = createRoot(container);
  const handlers = {
    retryNoteLookup: vi.fn(),
    missingNote: vi.fn(),
    updateCell: vi.fn(),
  };
  act(() => root?.render(<table><tbody><TableRecordRow
    record={{ ...record, note_path: noteStatus === 'draft' ? '' : record.note_path }}
    imagePaths={() => []}
    notePropertyEditorValue={(currentNote, field) => field.type === 'primary' ? currentNote?.relativePath : currentNote?.properties.done}
    fields={fields}
    builtinFields={showBuiltinFields ? BUILTIN_TABLE_FIELDS : []}
    note={note}
    isRuleLinked={false}
    notebookPath="/notebook"
    getAvailableNotes={() => options.availableNotes ?? []}
    subscribeAvailableNotes={() => () => {}}
    noteStatus={noteStatus}
    allowSwitchNote={allowSwitchNote}
    autoOpenPrimaryEditor={options.autoOpen ?? false}
    imageUrls={{}}
    saving={false}
    cellStatuses={new Map()}
    rowActionOpen={false}
    onRetryNoteLookup={handlers.retryNoteLookup}
    onMissingNote={handlers.missingNote}
    onReplaceNote={vi.fn()}
    onCreateAndLinkRecordNote={vi.fn(async () => true)}
    onAutoOpenHandled={vi.fn()}
    onRenameNote={vi.fn(async () => null)}
    onOpenNote={vi.fn()}
    onDeleteNote={vi.fn()}
    onSelectImage={vi.fn(async () => {})}
    onUpdateCell={handlers.updateCell}
    onDeleteRecord={vi.fn()}
    onRowActionOpenChange={vi.fn()}
  /></tbody></table>));
  return { container, ...handlers };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  renderPopupContent = false;
  vi.useRealTimers();
});

describe('TableRecordRow note fallback', () => {
  it('offers retry and disables property edits when note-list status is unknown', () => {
    const view = renderRow('unknown');
    const retry = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('无法确认关联状态'));
    expect(retry).toBeTruthy();
    expect(view.container.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="done"]')?.disabled).toBe(true);

    act(() => retry?.click());
    expect(view.retryNoteLookup).toHaveBeenCalledOnce();
  });

  it('checks and cleans a missing relation when the user acts on it', () => {
    renderPopupContent = true;
    const view = renderRow('missing');
    const replace = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('未找到笔记'));
    expect(replace).toBeTruthy();
    expect(view.container.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="done"]')?.disabled).toBe(true);

    act(() => replace?.click());
    expect(view.missingNote).toHaveBeenCalledOnce();
  });

  it('keeps property editing enabled for a resolved note', () => {
    const view = renderRow('linked', linkedNote);
    expect(view.container.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="done"]')?.disabled).toBe(false);
  });

  it('disables property editing in an unlinked draft row', () => {
    const view = renderRow('draft');
    expect(view.container.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="done"]')?.disabled).toBe(true);
  });
});

describe('TableRecordRow builtin metadata', () => {
  it('keeps file metadata read-only and makes mapped presets editable', () => {
    const view = renderRow('linked', { ...linkedNote, relativePath: '项目/方案.md', sizeBytes: 1_250_000, createdAt: 0, updatedAt: 0 }, true);
    const cells = view.container.querySelectorAll('td:not(.multidimensional-table__row-control-cell)');
    expect(cells).toHaveLength(3 + BUILTIN_TABLE_FIELDS.length);
    const pathIndex = BUILTIN_TABLE_FIELDS.findIndex((field) => field.id === NOTE_PATH_FIELD_ID);
    const sizeIndex = BUILTIN_TABLE_FIELDS.findIndex((field) => field.id === NOTE_SIZE_FIELD_ID);
    expect(cells[pathIndex + 2].textContent).toBe('项目');
    expect(cells[sizeIndex + 2].textContent).toBe('1.25 MB');
    BUILTIN_TABLE_FIELDS.forEach((field, index) => {
      const editor = cells[index + 2].querySelector('input,button,textarea');
      if (builtinPresetTableField(field.id)) expect(editor).toBeTruthy();
      else expect(editor).toBeNull();
    });
    expect(cells[cells.length - 1].querySelector('button[aria-label="更多行操作"]')).toBeTruthy();
  });
  it('writes pin edits using the shared preset key and stable column ID', async () => {
    vi.useFakeTimers();
    const view = renderRow('linked', { ...linkedNote, favorited: true }, true);
    const index = BUILTIN_TABLE_FIELDS.findIndex((field) => field.label === '置顶');
    const checkbox = view.container.querySelectorAll('td:not(.multidimensional-table__row-control-cell)')[index + 2].querySelector<HTMLButtonElement>('[role="checkbox"]');
    expect(checkbox?.getAttribute('aria-checked')).toBe('true');
    await act(async () => { checkbox?.click(); vi.advanceTimersByTime(1000); });
    expect(view.updateCell).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ id: '__note_pinned__', property_key: 'flowix_favorited', type: 'Boolean' }), false);
  });

  it('leaves every builtin cell empty without an associated note', () => {
    const view = renderRow('draft', undefined, true);
    for (const cell of [...view.container.querySelectorAll('td:not(.multidimensional-table__row-control-cell)')].slice(2, 2 + BUILTIN_TABLE_FIELDS.length)) {
      expect(cell.textContent).toBe('');
      expect(cell.querySelector('input,button,textarea')).toBeNull();
    }
  });

});

describe('folder table note switching', () => {
  it('retains title editing without editor action buttons', () => {
    renderPopupContent = true;
    const view = renderRow('linked', linkedNote, false, false);
    expect(view.container.querySelector('button[aria-label="跳转到目标文档"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="切换文档"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="从表格移除此行"]')).toBeNull();
    expect(view.container.querySelector('textarea')).toBeTruthy();
    expect(view.container.querySelector('input[type="search"]')).toBeNull();
  });

  it('disables switching draft notes while retaining title creation', () => {
    renderPopupContent = true;
    const view = renderRow('draft', undefined, false, false);
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    // allowSwitchNote=false 时 picker 退化为“只建标题”，aria-label 随之变成「笔记名称」。
    expect(view.container.querySelector('textarea[aria-label="笔记名称"]')).toBeTruthy();
    expect(view.container.querySelector('button[aria-label="从表格移除此行"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="创建笔记"]')?.textContent).toBe('');
    expect(view.container.querySelector('input[type="search"]')).toBeNull();
  });

  it('loads candidates when an empty row opens without a separate switching control', () => {
    renderPopupContent = true;
    const view = renderRow('draft', undefined, false, true, { autoOpen: true, availableNotes: [linkedNote] });
    expect(view.container.querySelector('[role="option"]')).toBeNull();
    expect(view.container.querySelector('textarea[aria-label="笔记名称"]')).toBeTruthy();
    expect(view.container.querySelector('input[type="search"]')).toBeNull();
  });

  it('keeps switching available for standalone tables', () => {
    renderPopupContent = true;
    const view = renderRow('draft');
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    expect(view.container.querySelector('textarea[aria-label="笔记名称"]')).toBeTruthy();
  });
});
