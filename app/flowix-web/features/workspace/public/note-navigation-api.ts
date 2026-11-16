/** Stable navigation commands consumed by note-oriented features. */
export {
  replaceExternalDocumentPath,
  historyEntryFromWorkColumnTarget,
} from '@features/workspace/use-cases/workspace-navigation';
export { clearColumnAtIndex as clearWorkspaceDocument } from './column-commands-api';
export { openSurfaceAtPosition } from './open-surface-api';
export type { OpenSurfaceAtPositionRequest } from './open-surface-api';
export type { WorkspaceContentLocation } from '@features/workspace/use-cases/workspace-content-activation';
