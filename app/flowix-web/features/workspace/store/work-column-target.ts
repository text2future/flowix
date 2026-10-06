import type { FileBrowserContext } from './file-browser-target';
import type { PluginDescriptor } from '@platform/tauri/client';
import { canonicalPath } from '@/lib/path';

export type DocumentListScope = {
  kind: 'folder';
  path: string;
  notebookPath: string;
  notebookId: string | null;
};

export type DocumentListFilters = {
  resourceKinds?: string[];
  tags?: string[];
  customFilterId?: string;
};

export type DocumentListTarget = {
  kind: 'document-list';
  displayId: string;
  scope: DocumentListScope;
  filters: DocumentListFilters;
};

/** Stable identity for a folder list and its active filter set. */
export function createDocumentListTarget(
  scope: DocumentListScope,
  filters: DocumentListFilters,
): DocumentListTarget {
  const normalizedScope = {
    ...scope,
    path: canonicalPath(scope.path),
    notebookPath: canonicalPath(scope.notebookPath),
  };
  const normalizedFilters: DocumentListFilters = {
    ...(filters.resourceKinds ? { resourceKinds: [...new Set(filters.resourceKinds)].sort() } : {}),
    ...(filters.tags ? { tags: [...new Set(filters.tags)].sort() } : {}),
    ...(filters.customFilterId ? { customFilterId: filters.customFilterId } : {}),
  };
  const displayId = `document-list:${JSON.stringify([
    normalizedScope.path,
    normalizedScope.notebookPath,
    normalizedScope.notebookId,
    normalizedFilters,
  ])}`;
  return { kind: 'document-list', displayId, scope: normalizedScope, filters: normalizedFilters };
}

/**
 * The stable target currently owned by the workColumn.
 *
 * The selected notebook remains in NoteLibraryStore; folder-list destinations are
 * explicit targets so they can be restored independently of that selection.
 */
export type WorkColumnTarget =
  | { kind: 'empty' }
  | DocumentListTarget
  | {
      kind: 'external';
      fileBrowser?: FileBrowserContext;
      path: string;
      scopePath: string | null;
      transitionId: number | null;
    }
  | { kind: 'table'; filePath: string; notebookPath: string | null; notebookId: string | null }
  | {
      kind: 'media';
      filePath: string;
      notebookId: string | null;
      notebookPath: string | null;
      resourceKind: 'image' | 'video';
    }
  | { kind: 'media-library'; filePath: string; notebookPath: string | null; notebookId: string | null }
  | { kind: 'agent-conversation'; instanceId: string }
  /** View identity only. Plugin run state and artifacts live in host stores. */
  | { kind: 'plugin-workbench'; plugin: PluginDescriptor }
  | { kind: 'web'; url: string };

/** Local file path for the last successfully committed workColumn target. */
export function workColumnTargetFilePath(target: WorkColumnTarget): string | null {
  switch (target.kind) {
    case 'external':
      return target.path;
    case 'media':
      return target.filePath;
    case 'table':
      return target.filePath;
    case 'media-library':
      return target.filePath;
    default:
      return null;
  }
}

export const EMPTY_WORK_COLUMN_TARGET = { kind: 'empty' } as const satisfies WorkColumnTarget;

export type WorkColumnNavigationPhase = 'idle' | 'loading' | 'committed' | 'failed';

export interface WorkColumnNavigationFailure {
  code: 'navigation-failed' | 'navigation-stale';
  message: string;
  requestId: number;
  retryToken: string | null;
}

export interface WorkColumnNavigationState {
  /** The last successfully committed workColumn target. */
  phase: WorkColumnNavigationPhase;
  /** Whether an in-flight transaction should visually block the workColumn. */
  showWorkColumnLoading: boolean;
  requestId: number;
  target: WorkColumnTarget;
  /** The target currently being attempted, if any. */
  pendingTarget: WorkColumnTarget | null;
  /** Target that was active when the current request began. */
  previousTarget: WorkColumnTarget | null;
  failure: WorkColumnNavigationFailure | null;
  retryToken: string | null;
}
