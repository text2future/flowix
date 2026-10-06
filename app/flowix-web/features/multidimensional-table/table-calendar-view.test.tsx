import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableField, TableRecord } from './model';
import { TableCalendarView } from './table-secondary-views';

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

describe('TableCalendarView pointer movement', () => {
  it('moves a note between day cells and keeps its time value', () => {
    container = document.createElement('div');
    root = createRoot(container);
    const onMoveRecord = vi.fn();
    const days = [12, 13, 14, 15, 16, 17, 30].map((day) => ({
      date: new Date(2026, 9, day),
      iso: `2026-10-${String(day).padStart(2, '0')}`,
      inMonth: true,
    }));
    act(() => root?.render(<TableCalendarView
      cursor={new Date(2026, 9, 1)}
      onCursorChange={vi.fn()}
      days={days}
      groups={new Map([['2026-10-12', [first]]])}
      dateFieldId="due"
      titleField={titleField}
      renderValue={(record) => record.note_path}
      dateValueForRecord={() => '2026-10-12T21:43'}
      onMoveRecord={onMoveRecord}
    />));

    const source = container.querySelector<HTMLElement>('[data-calendar-date="2026-10-12"] [data-calendar-record="first"]')!;
    const destination = container.querySelector<HTMLElement>('[data-calendar-date="2026-10-30"]')!;
    expect(source.closest('button')).toBeNull();
    Object.defineProperty(source, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => destination });

    pointer(source, 'pointerdown', 10, 10);
    pointer(source, 'pointermove', 30, 30);
    expect(destination.dataset.calendarDropTarget).toBe('true');
    expect(document.querySelector('[data-calendar-floating-preview]')).not.toBeNull();
    pointer(source, 'pointerup', 30, 30);

    expect(onMoveRecord).toHaveBeenCalledWith('first', 'due', '2026-10-30T21:43');
    expect(document.querySelector('[data-calendar-floating-preview]')).toBeNull();
  });

  it('can drag a note from the expanded day list', () => {
    container = document.createElement('div');
    root = createRoot(container);
    const onMoveRecord = vi.fn();
    const days = [12, 13, 14, 15, 16, 17, 30].map((day) => ({
      date: new Date(2026, 9, day),
      iso: `2026-10-${String(day).padStart(2, '0')}`,
      inMonth: true,
    }));
    const third = { ...first, id: 'third', note_path: 'third.md' };
    const fourth = { ...first, id: 'fourth', note_path: 'fourth.md' };
    act(() => root?.render(<TableCalendarView
      cursor={new Date(2026, 9, 1)}
      onCursorChange={vi.fn()}
      days={days}
      groups={new Map([['2026-10-12', [first, second, third, fourth]]])}
      dateFieldId="due"
      titleField={titleField}
      renderValue={(record) => record.note_path}
      onMoveRecord={onMoveRecord}
    />));

    const more = container.querySelector<HTMLButtonElement>('[data-calendar-date="2026-10-12"] button')!;
    act(() => more.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const source = document.querySelector<HTMLElement>('[data-calendar-record="fourth"]')!;
    const destination = container.querySelector<HTMLElement>('[data-calendar-date="2026-10-30"]')!;
    Object.defineProperty(source, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => destination });

    pointer(source, 'pointerdown', 10, 10);
    pointer(source, 'pointermove', 30, 30);
    pointer(source, 'pointerup', 30, 30);

    expect(onMoveRecord).toHaveBeenCalledWith('fourth', 'due', '2026-10-30');
  });
});
