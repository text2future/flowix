/** Shared surface support and routing metadata for workspace columns. */
export {
  resolveWorkspaceFileSurfaceKind,
  workspaceColumnIndexOf,
  workspaceFileSurfaceKind,
  workspaceFileSurfaceSupportsColumn,
  workspaceSurfaceCapabilities,
  workspaceSurfaceContentPresentation,
  workspaceSurfaceAppearance,
  workspaceSurfaceRegistry,
  workspaceSurfaceSupportsColumn,
} from '../surface-registry';
export type {
  WorkspaceFileSurfaceKind,
  WorkspaceSurfaceCapability,
  WorkspaceColumnId,
  WorkspaceColumnIndex,
  WorkspaceSurfaceKind,
} from '../surface-registry';

export type * from '../model/surface-contract';
export type * from '../model/surface-target';
export type { ContentIdentity, WorkspaceSurfaceIdentity } from '../model/surface-identity';
export { contentIdentityKey, workspaceSurfaceIdentityKey } from '../model/surface-identity';

export { workspaceSurfaceUsesCollectionFrame } from '../surface-registry';
