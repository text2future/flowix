import { canonicalPath, isPathInDirectory, pathComparisonKey } from '@/lib/path';

export interface PathMove { oldPath: string; newPath: string; folder?: boolean }

export function movedPath(path: string, move: PathMove, reverse = false): string {
  const from = canonicalPath(reverse ? move.newPath : move.oldPath);
  const to = canonicalPath(reverse ? move.oldPath : move.newPath);
  if (pathComparisonKey(path) === pathComparisonKey(from)) return to;
  return move.folder && isPathInDirectory(path, from) ? to + canonicalPath(path).slice(from.length) : path;
}
