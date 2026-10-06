import { describe, expect, it } from 'vitest';
import { asyncMapLimit } from './async-map-limit';

describe('asyncMapLimit', () => {
  it('bounds concurrent work and preserves result order', async () => {
    let active = 0;
    let peak = 0;
    const results = await asyncMapLimit([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return item * 2;
    });
    expect(peak).toBe(2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });
});
