import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useI18n } from '@/lib/i18n';
import { getAgentType } from '@/lib/agent-types';
import { getAgentConversationPresentation } from '@features/agent/conversation-presentation';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { isInitialConversationHistoryLoading } from './agent-conversation-history-loading';
import type { SurfacePresentationUpdate, SurfaceState } from '@features/workspace/model/surface-contract';

/** Domain hydration and display data shared by both workspace hosts. */
export function useAgentConversationSurface(instanceId: string, reportPresentation?: (update: SurfacePresentationUpdate) => void) {
  const { t } = useI18n();
  // Shallow-compare the instance: another column registering an equal snapshot
  // must not re-render this surface's conversation tree.
  const instance = useAgentSessionStore(useShallow((state) => state.getInstance(instanceId)));
  const isInitialHistoryLoading = useAgentSessionStore((state) => {
    const projection = instance?.threadId ? state.threadProjections[instance.threadId] : undefined;
    return isInitialConversationHistoryLoading(
      instance?.threadId ?? null, projection?.messages.length ?? 0, projection?.pagination.initialStatus,
    );
  });
  const [loadState, setLoadState] = useState<{
    instanceId: string;
    status: 'loading' | 'not-found' | 'error';
  } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    if (instance) return;

    let cancelled = false;
    setLoadState({ instanceId, status: 'loading' });
    void useAgentSessionStore.getState().hydrateInstance(instanceId)
      .then((restored) => {
        if (!cancelled && !restored) setLoadState({ instanceId, status: 'not-found' });
      })
      .catch(() => {
        if (!cancelled) setLoadState({ instanceId, status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [instance, instanceId, retryCount]);

  const retry = useCallback(() => {
    setLoadState({ instanceId, status: 'loading' });
    setRetryCount((count) => count + 1);
  }, [instanceId]);
  const status = instance ? 'ready' : loadState?.instanceId === instanceId ? loadState.status : 'loading';
  const title = instance ? getAgentConversationPresentation(instance, t('common.untitled')).title : t('common.untitled');
  const icon = instance ? getAgentType(instance.agentType).icon : undefined;
  useEffect(() => {
    const actions = [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retry }];
    const state: SurfaceState = status === 'ready' && !isInitialHistoryLoading ? { status: 'ready' }
      : status === 'loading' || isInitialHistoryLoading
        ? { status: 'loading', loadingMode: 'blocking', retainContent: true }
        : status === 'not-found' ? { status: 'unavailable', reason: 'missing', message: { key: 'status.agent.conversationNotFound' }, actions }
          : { status: 'error', message: { key: 'status.agent.loadConversationsFailed' }, actions };
    reportPresentation?.({ title, icon, state });
  }, [icon, isInitialHistoryLoading, reportPresentation, retry, status, title]);

  return { instance, status, retry };
}
