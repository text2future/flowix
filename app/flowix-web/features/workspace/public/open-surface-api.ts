/**
 * Canonical content-opening boundary. Every request names its destination;
 * neither focused host nor Agent runtime status selects that destination.
 * Work requests reserve the shared transaction revision before saves or
 * metadata reads, so clears, notebook switches and newer opens retire them.
 * Development navigation logs contain request IDs and outcomes, never paths.
 */
export { openWorkspaceSurface } from '../use-cases/host-surface-opening';
export type * from '../model/surface-opening';
export type {
  WorkspaceSurfaceOpenTarget, WorkWorkspaceSurfaceTarget, BrowserWorkspaceSurfaceTarget,
  CollectionReferenceSurfaceTarget,
} from '../model/surface-target';
