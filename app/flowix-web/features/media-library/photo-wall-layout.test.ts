import { describe, expect, it } from 'vitest';
import { layoutPhotoWall } from './photo-wall-layout';

describe('layoutPhotoWall', () => {
  it.each([280, 640, 960, 1400])('fills every row without changing aspect ratios at width %i', (width) => {
    const ratios = Array.from({ length: 40 }, (_, i) => [1, 1.5, 0.66, 2, 0.8][i % 5]);
    const result = layoutPhotoWall(ratios, width);
    expect(result.count).toBeGreaterThanOrEqual(15);
    expect(result.count).toBeLessThanOrEqual(40);
    let end = 0;
    for (const row of result.rows) {
      expect(row.from).toBe(end);
      expect(row.height).toBeGreaterThan(0);
      const widths = ratios.slice(row.from, row.to).map((ratio) => ratio * row.height);
      expect(widths.reduce((sum, value) => sum + value, 0) + 2 * (widths.length - 1)).toBeCloseTo(width, 8);
      end = row.to;
    }
    expect(end).toBe(result.count);
    expect(result.rows[result.rows.length - 1]?.to).toBe(result.count);
  });

  it('shows all resources when fewer than fifteen exist', () => {
    const result = layoutPhotoWall([0.2, 1, 5], 600);
    expect(result.count).toBe(3);
    expect(result.rows.every((row) => Number.isFinite(row.height))).toBe(true);
  });

  it('handles empty inputs and unmeasured containers', () => {
    expect(layoutPhotoWall([], 600).rows).toEqual([]);
    expect(layoutPhotoWall([1, 2], 0).rows).toEqual([]);
  });

  it('bounds the candidate count even for a larger library', () => {
    expect(layoutPhotoWall(Array(100).fill(1), 800).count).toBeLessThanOrEqual(40);
  });

  it('can expand beyond thirty to avoid an excessively tall row of narrow portraits', () => {
    expect(layoutPhotoWall(Array(40).fill(0.1), 1000).count).toBeGreaterThan(30);
  });
});
