import { canonicalPath } from '@/lib/path';
import type { WorkspaceContentTarget } from './surface-target';
import type { BrowserColumnTarget } from './browser-column-target';
import type { LegacyFolderListTarget } from './legacy-folder-list';

export function movedFilePath(path: string, previous: string, next: string, directory: boolean): string {
  const normalized = canonicalPath(path);
  if (normalized === previous) return next;
  return directory && normalized.startsWith(`${previous}/`)
    ? `${next}${normalized.slice(previous.length)}` : path;
}

/** Rebase address hints, preserving display identity, view selection and host state. */
export function rebaseWorkspaceTargetPath<T extends WorkspaceContentTarget | BrowserColumnTarget | LegacyFolderListTarget | import('./surface-target').CollectionReferenceSurfaceTarget>(
  target: T, previous: string, next: string, directory: boolean,
): T {
  const move = (path: string) => movedFilePath(path, previous, next, directory);
  switch (target.kind) {
    case 'external': {
      const path = move(target.path);
      const folderPath = target.fileBrowser?.folderPath;
      const movedFolder = folderPath ? move(folderPath) : folderPath;
      if (path === target.path && movedFolder === folderPath) return target;
      return { ...target, path, fileBrowser: target.fileBrowser
        ? { ...target.fileBrowser, folderPath: movedFolder ?? null } : undefined };
    }
    case 'file-browser': {
      const activeFilePath = target.activeFilePath ? move(target.activeFilePath) : null;
      const folderPath = target.folderPath ? move(target.folderPath) : null;
      return activeFilePath === target.activeFilePath && folderPath === target.folderPath
        ? target : { ...target, activeFilePath, folderPath };
    }
    case 'folder-collection': {
      const folderPath = move(target.folderPath);
      return folderPath === target.folderPath ? target : {
        ...target, folderPath, folderName: folderPath.split('/').pop() ?? target.folderName,
      };
    }
    case 'collection':
    case 'table':
    case 'media-library':
    case 'media': {
      const filePath = move(target.filePath);
      return filePath === target.filePath ? target : { ...target, filePath };
    }
    default: return target;
  }
}
