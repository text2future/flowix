'use client';

import { useCallback, useEffect, useMemo } from 'react';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import {
  getConversationRunSummary,
  type ConversationRunSummary,
} from '@features/agent/store/conversation-run-index';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { getAgentType } from '@/lib/agent-types';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { Tooltip } from '@shared/ui/tooltip';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { useNoteStore } from '@features/memo/store/note-store';

interface AgentConversationStatusEntry {
  instance: AgentConversationInstance;
  run: ConversationRunSummary;
}

function conversationStatusEntries(
  instances: Record<string, AgentConversationInstance>,
  runSignatures: Record<string, string>,
  unreadInstanceIds: ReadonlySet<string>,
  notebookId: string | null = null,
  threadTombstones: Readonly<Record<string, boolean>> = {},
): AgentConversationStatusEntry[] {
  return Object.values(instances)
    .filter((instance) => !notebookId || instance.source?.notebookId === notebookId)
    .filter((instance) => !instance.threadId || !threadTombstones[instance.threadId])
    .map((instance) => ({
      instance,
      run: getConversationRunSummary(runSignatures, instance.threadId),
    }))
    .filter(({ instance, run }) => (
      run.status === 'running' || unreadInstanceIds.has(instance.instanceId)
    ))
    .sort((a, b) => {
      // Keep active runs in their start order, followed by unread completed
      // conversations in their conversation update order.
      const aTime = a.run.status === 'running' ? a.run.startedAt : a.instance.updatedAt;
      const bTime = b.run.status === 'running' ? b.run.startedAt : b.instance.updatedAt;
      return aTime - bTime;
    });
}

/**
 * Compact status-bar entry for every running conversation and every
 * conversation that finished while it was not open. Unread state is owned by
 * the shared agent session store so this surface and the conversation list
 * stay synchronized; opening a conversation clears it immediately.
 */
export function AgentConversationStatusBar() {
  const { t } = useI18n();
  const instances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const runSignatures = useAgentSessionStore((state) => state.threadRunSignatures);
  const latestCompletedRunIds = useAgentSessionStore((state) => state.latestCompletedRunIds);
  const readThroughRunIds = useAgentSessionStore((state) => state.readThroughRunIds);
  const threadTombstones = useAgentSessionStore((state) => state.threadTombstones);
  const notebookId = useNoteStore((state) => state.selectedNotebook?.id ?? null);
  const markThreadRead = useAgentSessionStore((state) => state.markThreadRead);
  const selectedInstanceId = useWorkspaceRestoreStore(
    (state) => state.agentConversation.selectedInstanceId,
  );
  const detailOpen = useWorkspaceRestoreStore((state) => state.agentConversation.detailOpen);

  const lifecycleEntries = useMemo(() => (
    Object.values(instances).map((instance) => ({
      instance,
      run: getConversationRunSummary(runSignatures, instance.threadId),
    }))
  ), [instances, runSignatures]);

  useEffect(() => {
    const selectedIsOpen = (instanceId: string) =>
      detailOpen && selectedInstanceId === instanceId;

    for (const { instance } of lifecycleEntries) {
      if (selectedIsOpen(instance.instanceId) && instance.threadId) {
        markThreadRead(instance.threadId);
      }
    }
  }, [detailOpen, lifecycleEntries, markThreadRead, selectedInstanceId]);

  const openConversation = useCallback((instance: AgentConversationInstance) => {
    if (instance.threadId) markThreadRead(instance.threadId);
    void openWorkspaceSurface({ index: 0, target: { kind: 'agent-conversation', instanceId: instance.instanceId } }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t('status.agent.conversationNotFound'));
    });
  }, [markThreadRead, t]);

  const entries = useMemo(
    () => conversationStatusEntries(
      instances,
      runSignatures,
      new Set(Object.values(instances)
      .filter((instance) => instance.threadId
        && latestCompletedRunIds[instance.threadId] !== readThroughRunIds[instance.threadId])
        .map((instance) => instance.instanceId)),
      notebookId,
      threadTombstones,
    ),
    [instances, latestCompletedRunIds, notebookId, readThroughRunIds, runSignatures, threadTombstones],
  );

  if (entries.length === 0) return null;

  return (
    <div className="flex h-full shrink-0 items-center gap-0.5" aria-label={t('status.agent.running')}>
      {entries.map(({ instance, run }) => {
        const agent = getAgentType(instance.agentType);
        const title = instance.title?.trim() || t('common.untitled');
        const isRunning = run.status === 'running';
        const isUnread = !!instance.threadId
          && latestCompletedRunIds[instance.threadId] !== readThroughRunIds[instance.threadId];
        return (
          <Tooltip
            key={instance.instanceId}
            content={title}
            side="top"
            className="w-max max-w-[min(12em,calc(100vw-1rem))] justify-start text-left leading-4 [&>span]:min-w-0 [&>span]:whitespace-normal [&>span]:break-words"
          >
            <button
              type="button"
              onClick={() => openConversation(instance)}
              className="relative inline-flex h-full w-6 items-center justify-center px-1 hover:bg-[var(--muted)]"
              aria-label={title}
            >
              <AgentIcon
                typeKey={agent.id}
                alt=""
                className="h-3.5 w-3.5 object-contain"
              />
              {(isRunning || isUnread) && (
                <span
                  aria-hidden="true"
                  className={`absolute bottom-1 right-0.5 h-1.5 w-1.5 rounded-full ${
                    isRunning ? 'bg-[var(--success)]' : 'bg-[var(--muted-foreground)]'
                  }`}
                />
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

export { conversationStatusEntries };
