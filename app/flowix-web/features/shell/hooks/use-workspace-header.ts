import { resolveWorkspaceHeaderModel, useWorkspaceHeaderFullscreen, useWorkspaceHeaderScrolled, type WorkspaceHeaderInput } from '@features/workspace/public/header-api';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

export function useWorkspaceHeader(host: WorkspaceColumnId, input: WorkspaceHeaderInput) {
  const fullscreen = useWorkspaceHeaderFullscreen(host);
  const collectionScrolled = useWorkspaceHeaderScrolled(host);
  return { fullscreen, model: resolveWorkspaceHeaderModel({ ...input, fullscreen: Boolean(fullscreen), collectionScrolled }) };
}
