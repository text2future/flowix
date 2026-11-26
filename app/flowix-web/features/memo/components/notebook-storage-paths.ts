import { canonicalDirectoryPath } from '@/lib/path';
import type { Notebook } from '@features/memo/store';

export function filenameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

export function sameDirectorySet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightPaths = new Set(right.map(canonicalDirectoryPath));
  return left.every((path) => rightPaths.has(canonicalDirectoryPath(path)));
}

export function notebookStoragePaths(notebook: Notebook, repositories: { path: string }[]): string[] {
  return [notebook.path, ...repositories.map(({ path }) => path)
    .filter((path) => canonicalDirectoryPath(path) !== canonicalDirectoryPath(notebook.path))];
}

