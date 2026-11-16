import type { FileBrowserTarget, WorkspaceContentTarget } from './surface-target';

/** A resolved target has the same shape in every session and container. */
export type SessionSurfaceTarget = FileBrowserTarget | Exclude<WorkspaceContentTarget, { kind: 'external' }>
  | (Extract<WorkspaceContentTarget, { kind: 'external' }> & { transitionId: number | null });

/** The blank main-column state; empty is a host state, not an open request. */
export const EMPTY_SESSION_TARGET = { kind: 'empty' } as const satisfies SessionSurfaceTarget;

/** Local file path the target presents, if any. */
export function sessionTargetFilePath(target: SessionSurfaceTarget): string | null {
  switch (target.kind) {
    case 'file-browser': return target.activeFilePath;
    case 'external':
      return target.path;
    case 'media':
      return target.filePath;
    case 'collection':
    case 'table':
      return target.filePath;
    case 'media-library':
      return target.filePath;
    default:
      return null;
  }
}

/**
 * Markdown paints its own note skeleton, so opening it must not flash the
 * main-column blocking loader over the document area.
 */
export function sessionTargetShowsBlockingLoading(target: SessionSurfaceTarget): boolean {
  return !(target.kind === 'external' && /\.(md|markdown)$/i.test(target.path));
}
