export const PHOTO_WALL_CANDIDATE_LIMIT = 40;
export interface PhotoWallRow { from: number; to: number; height: number }

/** Preserve order and aspect ratios; every row, including the last, fills the width. */
export function layoutPhotoWall(ratios: readonly number[], width: number, gap = 2) {
  if (!ratios.length || width <= 0) return { rows: [] as PhotoWallRow[], count: 0, targetHeight: 160 };
  const targetHeight = Math.min(160, width * 0.65);
  const size = Math.min(ratios.length, PHOTO_WALL_CANDIDATE_LIMIT);
  const costs = Array<number>(size + 1).fill(Infinity);
  const previous = Array<number>(size + 1).fill(0);
  const heights = Array<number>(size + 1).fill(0);
  costs[0] = 0;
  for (let end = 1; end <= size; end += 1) {
    let totalRatio = 0;
    for (let start = end - 1; start >= 0; start -= 1) {
      const ratio = ratios[start];
      totalRatio += Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
      const count = end - start;
      const available = width - gap * (count - 1);
      if (available <= 0) break;
      const height = available / totalRatio;
      const relative = height / targetHeight;
      const deviation = (relative - 1) ** 2;
      const extreme = relative < 0.55 ? (0.55 - relative) ** 2 * 20 : relative > 1.8 ? (relative - 1.8) ** 2 * 20 : 0;
      const cost = costs[start] + (deviation + extreme) * count + (count === 1 && size > 1 ? 0.35 : 0);
      if (cost < costs[end]) { costs[end] = cost; previous[end] = start; heights[end] = height; }
    }
  }
  let count = Math.min(15, size);
  let best = Infinity;
  for (let end = count; end <= size; end += 1) {
    const score = costs[end] / end + (end > 30 ? (end - 30) * 0.03 : (30 - end) * 0.002);
    if (score < best) { count = end; best = score; }
  }
  const rows: PhotoWallRow[] = [];
  for (let end = count; end > 0; end = previous[end]) rows.unshift({ from: previous[end], to: end, height: heights[end] });
  return { rows, count, targetHeight };
}
