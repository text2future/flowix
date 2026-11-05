import { createLogger } from '@/lib/logger';
import { agentWorkspace } from '@platform/tauri/client';
import type { AgentWorkspaceSnapshot, AgentWorkspaceResource } from '@/lib/types/agent-workspace';
import type { FilesConfig } from '@/types/agent';

const logger = createLogger('agent-workspace');
export type AgentAccessErrorCode = 'not-selected' | 'already-tracked' | 'save-failed';
export interface AgentWorkspaceNotebook {
  notebook: { id: string; name: string; path: string };
  addDirs: Array<{
    id: string;
    path: string;
    label: string;
    enabled: boolean;
    missing: boolean;
  }>;
}
export interface AgentWorkspaceState {
  /** In-memory projection of local.db; runtime authorization remains backend-owned. */
  resources: AgentWorkspaceResource[];
  byNotebookId: Record<string, AgentWorkspaceNotebook>;
  validatedAt?: number;
}
export interface AgentWorkspaceActions {
  applySnapshot: (snapshot: AgentWorkspaceSnapshot) => void;
  loadInitial: () => Promise<boolean>;
  getNotebookFiles: (notebookId: string | null | undefined) => FilesConfig | undefined;
  /** The picker and mount commit share one notebook-scoped backend operation. */
  addFolderFromPicker: (notebookId: string | null | undefined) => Promise<
    { ok: true } | { ok: false; code: AgentAccessErrorCode }>;
  attachFolderToNotebook: (notebookId: string | null | undefined, path: string) => Promise<'saved' | 'already-attached' | false>;
  detachFolderFromNotebook: (notebookId: string | null | undefined, path: string) => Promise<'saved' | 'not-attached' | false>;
}
export type AgentWorkspaceLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface AgentWorkspaceLoadState { status: AgentWorkspaceLoadStatus; error?: string }

export interface AgentWorkspaceSliceStoreState {
  workspace: AgentWorkspaceState;
  loadState: { workspace: AgentWorkspaceLoadState };
  workspaceActions: AgentWorkspaceActions;
}

export function createAgentWorkspaceSlice(
  getStore: () => AgentWorkspaceSliceStoreState,
  publishWorkspace: (snapshot: AgentWorkspaceSnapshot) => void,
  setLoadState: (state: AgentWorkspaceLoadState) => void,
): AgentWorkspaceActions {
  let generation = 0;
  let writeQueue: Promise<unknown> = Promise.resolve();
  async function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const request = writeQueue.catch(() => undefined).then(async () => {
      return operation();
    });
    writeQueue = request;
    return request;
  }
  const publish = (snapshot: AgentWorkspaceSnapshot) => {
    ++generation;
    publishWorkspace(snapshot);
    setLoadState({ status: 'ready' });
  };
  return {
    applySnapshot: publish,
    getNotebookFiles: (notebookId) => {
      if (!notebookId || getStore().loadState.workspace.status !== 'ready') return undefined;
      const notebook = getStore().workspace.byNotebookId[notebookId];
      if (!notebook) return undefined;
      return { workspace: null, folders: notebook.addDirs.filter(d => d.enabled && !d.missing).map(d => d.path), notebooks: [] };
    },
    loadInitial: async () => {
      const requestGeneration = ++generation;
      if (!getStore().workspace.validatedAt) setLoadState({ status: 'loading' });
      try {
        const snapshot = await agentWorkspace.get();
        if (requestGeneration !== generation) return false;
        publish(snapshot);
        return true;
      } catch (error) {
        if (requestGeneration === generation) setLoadState({ status: 'error', error: String(error) });
        logger.error('Workspace hydration failed', { error });
        return false;
      }
    },
    addFolderFromPicker: async (notebookId) => {
      if (!notebookId) return { ok: false, code: 'not-selected' };
      return mutate(async () => {
        try {
          const picked = await agentWorkspace.pickDirectory(notebookId);
          if (!picked) return { ok: false as const, code: 'not-selected' as const };
          publish(picked);
          return { ok: true as const };
        } catch (error) {
          logger.error('Directory picker failed', { error });
          await getStore().workspaceActions.loadInitial();
          return { ok: false as const, code: 'save-failed' as const };
        }
      });
    },
    attachFolderToNotebook: async (notebookId, path) => {
      if (!notebookId) return false;
      return mutate(async () => {
        try {
          publish(await agentWorkspace.attachDirectory(notebookId, path));
          return 'saved' as const;
        } catch (error) {
          logger.error('Directory attachment failed', { error });
          await getStore().workspaceActions.loadInitial();
          return false;
        }
      });
    },
    detachFolderFromNotebook: async (notebookId, path) => {
      if (!notebookId) return false;
      return mutate(async () => {
        try {
          publish(await agentWorkspace.detachDirectory(notebookId, path));
          return 'saved' as const;
        } catch (error) {
          logger.error('Directory removal failed', { error });
          await getStore().workspaceActions.loadInitial();
          return false;
        }
      });
    },
  };
}
