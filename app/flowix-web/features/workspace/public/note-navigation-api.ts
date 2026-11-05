/** Stable navigation commands consumed by note-oriented features. */
export {
  replaceExternalDocumentPath,
  historyEntryFromWorkColumnTarget,
} from '@features/workspace/use-cases/workspace-navigation';
export { clearColumnAtIndex as clearWorkspaceDocument } from './column-commands-api';
export { openWorkspaceSurface } from './open-surface-api';
export type { OpenWorkspaceSurfaceRequest } from './open-surface-api';
export type { WorkspaceContentLocation } from '@features/workspace/use-cases/workspace-content-activation';
