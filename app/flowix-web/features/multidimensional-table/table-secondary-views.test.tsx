import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableField, TableRecord } from './model';
import { TableKanbanView } from './table-secondary-views';

const groupField: TableField = {
  id: 'status',
  type: 'Select',
  property_key: 'status',
  options: [{ id: 'todo', label: '待办' }, { id: 'done', label: '完成' }],
};
const titleField: TableField = { id: 'note', type: 'primary', property_key: 'note' };
const first: TableRecord = { id: 'first', note_path: 'first.md', updated_at: '' };
const second: TableRecord = { id: 'second', note_path: 'second.md', updated_at: '' };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function pointer(source: HTMLElement, type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
  });
  act(() => source.dispatchEvent(event));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('TableKanbanView pointer movement', () => {
  it('resolves another lane and passes its select option to the move handler', () => {
    container = document.createElement('div');
    root = createRoot(container);
    const onDropRecord = vi.fn();
    act(() => root?.render(<TableKanbanView
      groupField={groupField}
      titleField={titleField}
      groups={new Map([['todo', [first]], ['done', [second]]])}
      renderValue={(record) => record.note_path}
      onDropRecord={onDropRecord}
      onReorderLane={vi.fn()}
    />));

    const source = container.querySelector<HTMLElement>('[data-kanban-record="first"]')!;
    const destination = container.querySelector<HTMLElement>('[data-kanban-lane="done"]')!;
    Object.defineProperty(source, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => destination });

    pointer(source, 'pointerdown', 10, 10);
    pointer(source, 'pointermove', 30, 30);
    const preview = destination.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(preview?.textContent).toContain('first.md');
    expect(preview?.classList.contains('opacity-50')).toBe(true);
    expect(destination.hasAttribute('data-drag-over')).toBe(false);
    const floating = document.querySelector<HTMLElement>('[data-kanban-floating-preview]');
    expect(floating?.textContent).toContain('first.md');
    expect(floating?.classList.contains('opacity-50')).toBe(false);
    expect(floating?.style.left).toBe('44px');
    expect(floating?.style.top).toBe('44px');
    pointer(source, 'pointerup', 30, 30);

    expect(onDropRecord).toHaveBeenCalledWith('first', 'done', null);
    expect(document.querySelector('[data-kanban-floating-preview]')).toBeNull();
  });

  it('keeps a single half-transparent card when returning to the original position', () => {
    container = document.createElement('div');
    root = createRoot(container);
    act(() => root?.render(<TableKanbanView
      groupField={groupField}
      titleField={titleField}
      groups={new Map([['todo', [first, second]], ['done', []]])}
      renderValue={(record) => record.note_path}
      onDropRecord={vi.fn()}
      onReorderLane={vi.fn()}
    />));

    const source = container.querySelector<HTMLElement>('[data-kanban-record="first"]')!;
    const nextCard = container.querySelector<HTMLElement>('[data-kanban-record="second"]')!;
    const destination = container.querySelector<HTMLElement>('[data-kanban-lane="done"]')!;
    const emptyHint = destination.querySelector<HTMLElement>('.multidimensional-table__kanban-empty')!;
    expect(emptyHint.classList.contains('select-none')).toBe(true);
    expect(emptyHint.classList.contains('pointer-events-none')).toBe(true);
    Object.defineProperty(source, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(nextCard, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 50, height: 20 }),
    });
    let hit: HTMLElement = destination;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });

    pointer(source, 'pointerdown', 10, 10);
    pointer(source, 'pointermove', 30, 30);
    expect(destination.querySelector('.multidimensional-table__kanban-card[aria-hidden="true"]')).not.toBeNull();

    hit = source;
    pointer(source, 'pointermove', 31, 30);
    const sourceLane = container.querySelector<HTMLElement>('[data-kanban-lane="todo"]')!;
    expect(source.classList.contains('opacity-50')).toBe(true);
    expect(sourceLane.querySelector('.multidimensional-table__kanban-card[aria-hidden="true"]')).toBeNull();
    expect(sourceLane.querySelector('.multidimensional-table__kanban-empty')).toBeNull();
  });

  it('passes the insertion card when reordering within a lane', () => {
    container = document.createElement('div');
    root = createRoot(container);
    const onDropRecord = vi.fn();
    act(() => root?.render(<TableKanbanView
      groupField={groupField}
      titleField={titleField}
      groups={new Map([['todo', [first, second]]])}
      renderValue={(record) => record.note_path}
      onDropRecord={onDropRecord}
      onReorderLane={vi.fn()}
    />));

    const source = container.querySelector<HTMLElement>('[data-kanban-record="second"]')!;
    const beforeCard = container.querySelector<HTMLElement>('[data-kanban-record="first"]')!;
    const lane = container.querySelector<HTMLElement>('[data-kanban-lane="todo"]')!;
    Object.defineProperty(source, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(beforeCard, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 20, height: 20 }),
    });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => lane });

    pointer(source, 'pointerdown', 10, 10);
    pointer(source, 'pointermove', 30, 25);
    pointer(source, 'pointerup', 30, 25);

    expect(onDropRecord).toHaveBeenCalledWith('second', 'todo', 'first');
  });
});
