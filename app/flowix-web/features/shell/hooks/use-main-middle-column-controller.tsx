import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { useMemoListHoverPreview } from '@features/memo/public/shell-api';
import { createLogger } from '@/lib/logger';

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

function AgentConversationListReadySignal({
  onReady,
  isActive,
}: {
  onReady(): void;
  isActive: boolean;
}) {
  useLayoutEffect(() => onReady(), [onReady]);
  return <AgentConversationList isActive={isActive} />;
}

export interface MainMiddleColumnController {
  agentConversationListReady: boolean;
  shouldRenderAgentConversationList: boolean;
  showMemoListSurface: boolean;
  showAgentConversationSurface: boolean;
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
  isMemoListHidden,
}: {
  isAgentConversationView: boolean;
  isMemoListHidden: boolean;
}): MainMiddleColumnController {
  const [agentConversationListMounted, setAgentConversationListMounted] = useState(
    () => isAgentConversationView,
  );
  const [agentConversationListReady, setAgentConversationListReady] = useState(false);
  const handleAgentConversationListReady = useCallback(() => {
    setAgentConversationListReady(true);
  }, []);

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
    agentConversationListReady,
    shouldRenderAgentConversationList,
    showMemoListSurface: !isAgentConversationView || !agentConversationListReady,
    showAgentConversationSurface: isAgentConversationView && agentConversationListReady,
    memoListPreviewVisible,
    memoListPreviewPhase: preview.phase,
    handleMemoListPreviewTriggerEnter: preview.handleTriggerEnter,
    handleMemoListPreviewTriggerLeave: preview.handleTriggerLeave,
    handleMemoListPreviewEnter: preview.handlePreviewEnter,
    handleMemoListPreviewLeave: preview.handlePreviewLeave,
    agentConversationListNode: (
      <Suspense fallback={null}>
        <AgentConversationListReadySignal
          onReady={handleAgentConversationListReady}
          isActive={agentConversationListActive}
        />
      </Suspense>
    ),
  };
}
