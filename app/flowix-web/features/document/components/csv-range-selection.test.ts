import { describe, expect, it, vi } from 'vitest';
import { SelectRangeModule, type TabulatorFull as Tabulator } from 'tabulator-tables';
import { ensureCsvPointerRange } from './csv-range-selection';

// Exercise the installed library's event handlers, not a replacement for them.
const handleCellMouseDown = Reflect.get(SelectRangeModule.prototype, 'handleCellMouseDown');
const newSelection = Reflect.get(SelectRangeModule.prototype, 'newSelection');

describe('CSV with no initial range', () => {
  it.each([
    { name: 'Shift click', shiftKey: true, button: 0 },
    { name: 'right click', shiftKey: false, button: 2 },
  ])('prepares the first $name before Tabulator handles it', ({ shiftKey, button }) => {
    const cellElement = document.createElement('div');
    cellElement.className = 'tabulator-cell';
    const rowElement = document.createElement('div');
    rowElement.className = 'tabulator-row';
    rowElement.append(cellElement);
    const cell = { getElement: () => cellElement, getField: () => 'c0' };
    const internalCell = { type: 'cell', column: {} };
    const range = { occupies: () => true, setBounds: vi.fn() };
    const manager = {
      activeRange: false as false | typeof range,
      selecting: 'cell', mouseUpEvent: vi.fn(),
      newSelection(event: MouseEvent, target: object) { Reflect.apply(newSelection, this, [event, target]); },
    };
    const table = {
      getRanges: () => manager.activeRange ? [range] : [],
      getRow: () => ({ getCells: () => [cell] }),
      addRange: vi.fn(() => { manager.activeRange = range; return range; }),
    };
    const event = new MouseEvent('mousedown', { bubbles: true, shiftKey, button });
    try {
      // Verify the reported failure against the installed Tabulator version.
      expect(() => Reflect.apply(handleCellMouseDown, manager, [event, internalCell])).toThrow(TypeError);
      cellElement.addEventListener('mousedown', e => ensureCsvPointerRange(table as unknown as Tabulator, e), true);
      cellElement.dispatchEvent(event);
      expect(table.addRange).toHaveBeenCalledExactlyOnceWith(cell, cell);
      expect(range.setBounds).toHaveBeenCalledWith(cell, cell);
      expect(() => Reflect.apply(handleCellMouseDown, manager, [event, internalCell])).not.toThrow();
      // Existing selections are left intact.
      ensureCsvPointerRange(table as unknown as Tabulator, event);
      expect(table.addRange).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('mouseup', manager.mouseUpEvent);
    }
  });

  it('does not create a range before an ordinary click', () => {
    const table = { getRanges: vi.fn(), addRange: vi.fn() };
    ensureCsvPointerRange(table as unknown as Tabulator, new MouseEvent('mousedown'));
    expect(table.getRanges).not.toHaveBeenCalled();
    expect(table.addRange).not.toHaveBeenCalled();
  });
});
