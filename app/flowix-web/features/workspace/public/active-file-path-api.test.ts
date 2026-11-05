import { describe, expect, it } from 'vitest';

import { resolveActiveFilePath } from './active-file-path-api';

describe('active file path resolution', () => {
  it('always follows the main column, even while the side column holds another file', () => {
    expect(resolveActiveFilePath({
      mainPath: '/notes/main.md',
      sidePath: '/repo/side.md',
      sideVisible: true,
    })).toBe('/notes/main.md');
  });

  it('falls back to the side column only while it is on screen and the main column is empty', () => {
    expect(resolveActiveFilePath({
      mainPath: null,
      sidePath: '/repo/side.md',
      sideVisible: true,
    })).toBe('/repo/side.md');

    expect(resolveActiveFilePath({
      mainPath: null,
      sidePath: '/repo/side.md',
      sideVisible: false,
    })).toBeNull();
  });

  it('reports nothing when neither column shows a file', () => {
    expect(resolveActiveFilePath({ mainPath: null, sidePath: null, sideVisible: true })).toBeNull();
  });
});
