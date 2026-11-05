import type { AgentWorkspaceSnapshot } from '@/lib/types/agent-workspace';
/**
 * Workspace 需要的 Agent **目录**查询。
 *
 * 这里的两个函数在渲染期同步执行（`resolveFileBrowserContext` 用它判断文件归属），
 * 所以只能静态依赖 agent-workspace-store —— 一个 20 文件 / 约 3.3k 行的轻量 store。
 * 会话级操作（需要 agent-session-store，约 220 文件 / 3.3 万行）已拆到
 * `workspace-session-api.ts`，走函数体内动态 import。不要把两者合并回来。
 */
import { useAgentWorkspaceStore } from '@features/agent/store/agent-workspace-store';
export { ensureAgentWorkspaceReady } from '@features/agent/store/agent-workspace-store';

export interface WorkspaceAgentRepository {
  path: string;
  name: string;
  missing: boolean;
}

/** Resolve resource roots without exposing Agent access configuration stores. */
export function getWorkspaceAgentResourceFolders(notebookId: string | null): string[] {
  if (!notebookId) return [];
  return useAgentWorkspaceStore.getState().workspace.byNotebookId[notebookId]
    ?.addDirs.filter((directory) => directory.enabled && !directory.missing)
    .map((directory) => directory.path) ?? [];
}

/** Resolve the same notebook-scoped repository list used by Agent access settings. */
export function getWorkspaceAgentRepositories(
  notebookId: string | null,
): WorkspaceAgentRepository[] {
  if (!notebookId) return [];
  const notebook = useAgentWorkspaceStore.getState().workspace.byNotebookId[notebookId];
  return (notebook?.addDirs ?? [])
    .filter((directory) => directory.enabled && !directory.missing)
    .map((directory) => ({
      path: directory.path,
      name: directory.label,
      missing: directory.missing,
    }));
}

export function attachNotebookFolder(notebookId: string, path: string) {
  return useAgentWorkspaceStore.getState().workspaceActions.attachFolderToNotebook(notebookId, path);
}

export function loadAgentWorkspace() {
  return useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
}

export function applyAgentWorkspaceSnapshot(snapshot: AgentWorkspaceSnapshot) {
  useAgentWorkspaceStore.getState().workspaceActions.applySnapshot(snapshot);
}
