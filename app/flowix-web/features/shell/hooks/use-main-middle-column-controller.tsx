import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  useMemoListHoverPreview,
} from '@features/memo/public/shell-api';
import { createLogger } from '@/lib/logger';
import { useI18n } from '@/lib/i18n';
import { ListSurfaceLoadingState } from '@shared/ui/list-surface';

const logger = createLogger('main-middle-column-controller');

function importAgentConversationList() {
  return import('@features/agent/public/shell-api').then((module) => ({
    default: module.AgentConversationList,
  }));
}

let agentConversationListModulePromise: ReturnType<typeof importAgentConversationList> | null = null;

function loadAgentConversationList() {
  agentConversationListModulePromise ??= importAgentConversationList();
  return agentConversationListModulePromise;
}

const AgentConversationList = lazy(loadAgentConversationList);

function AgentConversationListLoadingFallback() {
  const { t } = useI18n();
  return <ListSurfaceLoadingState ariaLabel={t('status.agent.loadingConversations')} />;
}

export interface MainMiddleColumnController {
  shouldRenderAgentConversationList: boolean;
  showMemoListSurface: boolean;
  memoListPreviewVisible: boolean;
  memoListPreviewPhase: 'closed' | 'opening' | 'open' | 'closing';
  handleMemoListPreviewTriggerEnter(): void;
  handleMemoListPreviewTriggerLeave(): void;
  handleMemoListPreviewEnter(): void;
  handleMemoListPreviewLeave(): void;
  agentConversationListNode: ReactNode;
}

export function useMainMiddleColumnController({
  isAgentConversationView,
  onConversationListBack,
  isMemoListHidden,
}: {
  isAgentConversationView: boolean;
  onConversationListBack: () => void;
  isMemoListHidden: boolean;
}): MainMiddleColumnController {
  const [agentConversationListMounted, setAgentConversationListMounted] = useState(
    () => isAgentConversationView,
  );

  useEffect(() => {
    if (isAgentConversationView) setAgentConversationListMounted(true);
  }, [isAgentConversationView]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAgentConversationList().catch((error) => {
        logger.warn('prefetch conversation list failed', { error });
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);

  const preview = useMemoListHoverPreview(isMemoListHidden);
  const memoListPreviewVisible = isMemoListHidden && preview.phase !== 'closed';
  // The conversation list remains mounted to preserve its paged snapshot, but
  // its transient portal-backed menus must be closed whenever neither the
  // sidebar nor its hover preview is currently visible.
  const agentConversationListActive = isAgentConversationView
    && (!isMemoListHidden || memoListPreviewVisible);
  const shouldRenderAgentConversationList = agentConversationListMounted || isAgentConversationView;

  return {
    shouldRenderAgentConversationList,
    // The selected surface follows the store immediately; a lazy chunk uses
    // its own Suspense fallback instead of keeping the previous notes visible.
    showMemoListSurface: !isAgentConversationView,
    memoListPreviewVisible,
    memoListPreviewPhase: preview.phase,
    handleMemoListPreviewTriggerEnter: preview.handleTriggerEnter,
    handleMemoListPreviewTriggerLeave: preview.handleTriggerLeave,
    handleMemoListPreviewEnter: preview.handlePreviewEnter,
    handleMemoListPreviewLeave: preview.handlePreviewLeave,
    agentConversationListNode: (
      <Suspense fallback={<AgentConversationListLoadingFallback />}>
        <AgentConversationList isActive={agentConversationListActive} onBack={onConversationListBack} />
      </Suspense>
    ),
  };
}
