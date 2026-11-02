import type { SessionSurfaceTarget } from '../model/session-target';
import type { SessionNavigationTransaction, SessionNavigationFailure, SessionNavigationPhase } from '../model/session-navigation';
export type CollectionWorkspaceTarget = import('../model/surface-target').CollectionSurfaceTarget;

/** Deprecated renderer compatibility name; the model is owned by sessions. */
export type WorkColumnTarget = SessionSurfaceTarget;

/** Local file path for the last successfully committed workColumn target. */
export function workColumnTargetFilePath(target: WorkColumnTarget): string | null {
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

export const EMPTY_WORK_COLUMN_TARGET = { kind: 'empty' } as const satisfies WorkColumnTarget;

export type WorkColumnNavigationPhase = SessionNavigationPhase;
export type WorkColumnNavigationFailure = SessionNavigationFailure;
export interface WorkColumnNavigationState extends Omit<SessionNavigationTransaction, 'showBlockingLoading'> {
  showWorkColumnLoading: boolean;
  target: SessionSurfaceTarget;
}
