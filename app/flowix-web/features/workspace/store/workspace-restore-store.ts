import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { STORAGE_KEYS } from '@/lib/constants';
import type { DocumentListTarget } from './work-column-target';

interface AgentConversationRestoreState {
  selectedInstanceId: string | null;
  detailOpen: boolean;
}

export type PersistedWorkspaceTarget =
  | DocumentListTarget
  | { kind: 'external'; path: string; scopePath: string | null }
  | { kind: 'table'; filePath: string; notebookPath: string | null; notebookId: string | null }
  | {
      kind: 'media';
      filePath: string;
      notebookId: string | null;
      notebookPath: string | null;
      resourceKind: 'image' | 'video';
    }
  | { kind: 'agent-conversation'; instanceId: string };

export type WorkspaceRestoreStatus = 'idle' | 'restoring' | 'restored' | 'unavailable';

interface WorkspaceRestoreStore {
  version: 6;
  agentConversation: AgentConversationRestoreState;
  desiredTarget: PersistedWorkspaceTarget | null;
  restoreStatus: WorkspaceRestoreStatus;
  selectAgentConversation: (instanceId: string, detailOpen?: boolean) => void;
  closeAgentConversationDetail: () => void;
  clearAgentConversation: (instanceId?: string) => void;
  setDesiredTarget: (target: PersistedWorkspaceTarget | null) => void;
  setRestoreStatus: (status: WorkspaceRestoreStatus) => void;
}

const EMPTY_AGENT_CONVERSATION_RESTORE: AgentConversationRestoreState = {
  selectedInstanceId: null,
  detailOpen: false,
};

export const useWorkspaceRestoreStore = create<WorkspaceRestoreStore>()(
  persist(
    (set) => ({
      version: 6,
      agentConversation: EMPTY_AGENT_CONVERSATION_RESTORE,
      desiredTarget: null,
      restoreStatus: 'idle',
      selectAgentConversation: (instanceId, detailOpen = true) => {
        const normalized = instanceId.trim();
        if (!normalized) return;
        set({
          agentConversation: {
            selectedInstanceId: normalized,
            detailOpen,
          },
        });
      },
      closeAgentConversationDetail: () => set((state) => ({
        agentConversation: {
          ...state.agentConversation,
          detailOpen: false,
        },
      })),
      clearAgentConversation: (instanceId) => set((state) => {
        if (
          instanceId
          && state.agentConversation.selectedInstanceId !== instanceId
        ) {
          return state;
        }
        const clearsDesiredTarget = state.desiredTarget?.kind === 'agent-conversation'
          && (!instanceId || state.desiredTarget.instanceId === instanceId);
        return {
          agentConversation: EMPTY_AGENT_CONVERSATION_RESTORE,
          ...(clearsDesiredTarget ? { desiredTarget: null } : {}),
        };
      }),
      setDesiredTarget: (desiredTarget) => set({ desiredTarget, restoreStatus: 'restored' }),
      setRestoreStatus: (restoreStatus) => set({ restoreStatus }),
    }),
    {
      name: STORAGE_KEYS.WORKSPACE_RESTORE,
      partialize: (state) => ({
        version: state.version,
        agentConversation: state.agentConversation,
        desiredTarget: state.desiredTarget,
      }),
      version: 6,
      migrate: (persisted) => {
        const state = persisted as Partial<WorkspaceRestoreStore> | undefined;
        const desiredTarget = state?.desiredTarget;
        return {
          ...state,
          version: 6 as const,
          agentConversation: state?.agentConversation ?? EMPTY_AGENT_CONVERSATION_RESTORE,
          desiredTarget: desiredTarget?.kind === 'external'
            || desiredTarget?.kind === 'table'
            || desiredTarget?.kind === 'media'
            || desiredTarget?.kind === 'agent-conversation'
            || desiredTarget?.kind === 'document-list'
              ? desiredTarget : null,
          restoreStatus: 'idle' as const,
        };
      },
    },
  ),
);
