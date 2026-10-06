import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import type { TableField, TableRecord } from './model';

const mocks = vi.hoisted(() => ({ writeProperty: vi.fn() }));
vi.mock('@features/document/public/path-properties', () => ({ setDocumentProperties: mocks.writeProperty }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useTableCellWriter } from './use-table-cell-writer';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const record: TableRecord = { id: `rec_${'a'.repeat(32)}`, updated_at: '', note_path: 'note.md' };
const field: TableField = { id: `fld_${'b'.repeat(32)}`, type: 'Text', property_key: 'status' };
const note = { relativePath: 'note.md', properties: { status: 'old' } } as unknown as NoteEntry;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe({ generation }: { generation: number }) {
  const [notes, setNotes] = useState<NoteEntry[]>([note]);
  const sequenceRef = useRef(generation);
  sequenceRef.current = generation;
  const writer = useTableCellWriter({
    enabled: true,
    loadGeneration: generation,
    notebookPath: '/notebook',
    loadSequenceRef: sequenceRef,
    setNotes,
  });
  latestWriter = writer;
  return <output>{String(notes[0]?.properties.status ?? '')}</output>;
}

let latestWriter: ReturnType<typeof useTableCellWriter> | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container = null;
  latestWriter = null;
  mocks.writeProperty.mockReset();
});

describe('useTableCellWriter', () => {
  it('applies the latest generation rollback after a queued write fails', async () => {
    const firstWrite = deferred<boolean>();
    const secondWrite = deferred<boolean>();
    mocks.writeProperty.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(secondWrite.promise);
    container = document.createElement('div');
    root = createRoot(container);

    await act(async () => root?.render(<Probe generation={1} />));
    await act(async () => { latestWriter?.updateCell(record, note, field, 'first'); });
    expect(mocks.writeProperty).toHaveBeenCalledTimes(1);

    await act(async () => root?.render(<Probe generation={2} />));
    await act(async () => { latestWriter?.updateCell(record, note, field, 'second'); });
    expect(container.textContent).toBe('second');

    await act(async () => {
      firstWrite.resolve(true);
      await firstWrite.promise;
      await Promise.resolve();
    });
    expect(mocks.writeProperty).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondWrite.reject(new Error('write failed'));
      await secondWrite.promise.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toBe('first');
  });
});
