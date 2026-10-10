import { describe, expect, it } from 'vitest';
import { normalizeTauriDropPosition } from './drag-drop-position';

describe('normalizeTauriDropPosition', () => {
  it('converts Windows physical pixels to CSS pixels', () => {
    expect(normalizeTauriDropPosition({ x: 20, y: 40 }, 2, 'windows'))
      .toEqual({ x: 10, y: 20 });
  });

  it.each(['mac', 'linux', 'unknown'] as const)(
    'keeps %s view coordinates in CSS pixels',
    (platform) => {
      expect(normalizeTauriDropPosition({ x: 20, y: 40 }, 2, platform))
        .toEqual({ x: 20, y: 40 });
    },
  );

  it('falls back to an unscaled position when the scale factor is invalid', () => {
    expect(normalizeTauriDropPosition({ x: 20, y: 40 }, Number.NaN, 'windows'))
      .toEqual({ x: 20, y: 40 });
  });
});
