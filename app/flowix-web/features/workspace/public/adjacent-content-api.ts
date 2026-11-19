import { useWorkspaceSessionStore } from '@features/workspace/store/workspace-session-store';
import type { SessionSurfaceTarget } from '@features/workspace/model/session-target';

export interface AdjacentContent { path: string; kind: string }

/** Describe the visible surface, not a previously selected document. */
export function describeAdjacentTarget(target?: SessionSurfaceTarget): AdjacentContent | undefined {
  if (!target) return undefined;
  let path: string | null | undefined;
  let kind: string = target.kind;
  switch (target.kind) {
    case 'external': path = target.path; kind = '文件'; break;
    case 'file-browser':
      path = target.activeFilePath || target.folderPath;
      kind = target.collectionDisplay ? '集合' : target.activeFilePath ? '文件' : '文件夹';
      break;
    case 'folder-collection': path = target.folderPath; kind = '文件夹集合'; break;
    case 'collection': case 'table': case 'media-library': path = target.filePath; kind = '集合'; break;
    case 'media': path = target.filePath; kind = target.resourceKind === 'image' ? '图片' : '视频'; break;
    default: return undefined;
  }
  const normalized = path?.trim();
  return normalized ? { path: normalized, kind } : undefined;
}

/** Resolve only the visible surface opposite this particular conversation. */
export function getAdjacentContent(instanceId?: string): AdjacentContent | undefined {
  if (!instanceId) return undefined;
  const { browserLayout, sessions } = useWorkspaceSessionStore.getState();
  if (!browserLayout.visible) return undefined;
  const ids = ['column-1', 'column-2'] as const;
  const matching = ids.filter((id) => {
    const target = sessions[id].navigation.current?.target;
    return target?.kind === 'agent-conversation' && target.instanceId === instanceId;
  });
  if (matching.length !== 1) return undefined;
  const other = matching[0] === 'column-1' ? 'column-2' : 'column-1';
  const navigation = sessions[other].navigation;
  if (navigation.transaction.phase === 'preparing' || navigation.transaction.phase === 'loading') return undefined;
  return describeAdjacentTarget(navigation.current?.target);
}

