import { describe, expect, it } from 'vitest';
import {
  expandScreenRect,
  isOutsideRect,
  tabDragMode,
  tabDropBeforeId,
  tearOffWindowPosition,
  toScreenRect,
} from './tab-tear-off';

describe('tab tear-off geometry', () => {
  it('uses tab-item dragging for both single and multi-tab hosts', () => {
    expect(tabDragMode(0)).toBe('disabled');
    expect(tabDragMode(1)).toBe('tear_off');
    expect(tabDragMode(2)).toBe('tear_off');
  });

  it('maps the titlebar viewport bounds into screen coordinates', () => {
    expect(toScreenRect(
      { left: 0, top: 0, right: 900, bottom: 48 },
      { clientX: 240, clientY: 20, screenX: 1240, screenY: 420 },
    )).toEqual({ left: 1000, top: 400, right: 1900, bottom: 448 });
  });

  it('only tears off after the pointer leaves the header bounds', () => {
    const header = { left: 100, top: 200, right: 1000, bottom: 248 };
    expect(isOutsideRect({ x: 500, y: 248 }, header)).toBe(false);
    expect(isOutsideRect({ x: 500, y: 249 }, header)).toBe(true);
    expect(isOutsideRect({ x: 1001, y: 220 }, header)).toBe(true);
  });

  it('expands the tear-off boundary by half the header height', () => {
    const header = { left: 100, top: 200, right: 1000, bottom: 232 };
    const expanded = expandScreenRect(header, (header.bottom - header.top) * 0.5);
    expect(expanded).toEqual({ left: 84, top: 184, right: 1016, bottom: 248 });
    expect(isOutsideRect({ x: 500, y: 248 }, expanded)).toBe(false);
    expect(isOutsideRect({ x: 500, y: 249 }, expanded)).toBe(true);
  });

  it('updates the insertion target as the pointer crosses tab midpoints', () => {
    const tabs = [
      { id: 'a', left: 0, width: 100 },
      { id: 'b', left: 100, width: 100 },
      { id: 'c', left: 200, width: 100 },
    ];
    expect(tabDropBeforeId(tabs, 'b', 20)).toBe('a');
    expect(tabDropBeforeId(tabs, 'b', 170)).toBe('c');
    expect(tabDropBeforeId(tabs, 'b', 280)).toBeNull();
  });

  it('places the new window under the dragged tab', () => {
    expect(tearOffWindowPosition(
      { x: 720, y: 540 },
      { x: 210, y: 20 },
    )).toEqual({ x: 510, y: 520 });
  });
});
