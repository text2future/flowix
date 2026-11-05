import { describe, expect, it } from 'vitest';
import { getTableMenuHorizontalLayout } from './table-menu-position';

describe('table menu horizontal placement', () => {
  it('centers the measured menu on the table when there is room', () => {
    expect(getTableMenuHorizontalLayout(600, { left: 100, right: 1100 }, 1200, 480))
      .toEqual({ left: 500, maxWidth: 720 });
  });

  it('limits a wide toolbar to its narrow editor pane', () => {
    expect(getTableMenuHorizontalLayout(400, { left: 240, right: 560 }, 1200, 500))
      .toEqual({ left: 160, maxWidth: 304 });
  });

  it.each([[-100, 248], [1500, 952]])('clamps table center %i inside the pane', (center, expected) => {
    const layout = getTableMenuHorizontalLayout(center, { left: 0, right: 1200 }, 1200, 480);
    expect(layout?.left).toBe(expected);
  });

  it('uses the intersection of the editor and viewport', () => {
    expect(getTableMenuHorizontalLayout(900, { left: 800, right: 1400 }, 1000, 480))
      .toEqual({ left: 100, maxWidth: 184 });
  });

  it('returns no layout for an editor outside the viewport', () => {
    expect(getTableMenuHorizontalLayout(1300, { left: 1200, right: 1500 }, 1000)).toBeNull();
  });
});
