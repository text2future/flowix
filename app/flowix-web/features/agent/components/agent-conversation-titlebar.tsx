'use client';

import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import {
  ArchiveIcon,
  FileTextIcon,
  LinkBreakIcon,
  TrashSimpleIcon,
} from '@phosphor-icons/react';

import { useI18n } from '@/lib/i18n';
import { isWindowsPlatform } from '@features/shortcuts';
import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import {
  DOCUMENT_TITLEBAR_ICON_BUTTON_MAC,
  DOCUMENT_TITLEBAR_ICON_BUTTON_WIN,
} from '@features/document/components/document-titlebar-shared';
import { DEFAULT_AGENT_TYPE_KEY, getAgentType } from '@/lib/agent-types';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { openNoteByMemoId } from '@features/memo/use-cases/open-by-target';
import { openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';
import { getAgentConversationPresentation } from '@features/agent/conversation-presentation';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { BadgeHoverCard } from '@features/agent/thread-card/badge-hover-card';
import { computeAgentThreadCardBadgeData } from '@features/agent/thread-card/runtime/run-status-presenter';
import { getResolvedExternalSessionId } from '@features/agent/services/external-agent-runtime-service';
import { createRuntimeInfoRequester } from '@features/agent/thread-card/runtime/runtime-info-requester';
import { toast } from '@/lib/toast';
import { WorkColumnTitlebarShell } from '@features/shell/components/work-column-titlebar-shell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';

function AgentConversationHeader({ instanceId }: { instanceId: string }) {
  const { t } = useI18n();
  const isWindows = isWindowsPlatform();
  const instance = useAgentSessionStore((state) => state.getInstance(instanceId));
  const projection = useAgentSessionStore((state) => {
    const threadId = state.getInstance(instanceId)?.threadId;
    return threadId ? state.threadProjections[threadId] : undefined;
  });
  const codexModel = useAgentSessionStore((state) => state.sessionMeta.settings.agentCodexModel);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // archive/delete 由 store 端到端完成 (含 closeAgentConversation), instance
  // 消失时父级会立刻 unmount 这个组件; 不再渲染兜底空态、不再做"instance 缺
  // 失时" 的 hooks 防御。
  const presentation = instance
    ? getAgentConversationPresentation(instance, t('common.untitled'))
    : null;
  const agent = getAgentType(instance?.agentType ?? DEFAULT_AGENT_TYPE_KEY);
  const productThreadId = instance?.threadId ?? '';
  const externalThreadId = productThreadId
    ? getResolvedExternalSessionId(productThreadId) ?? productThreadId
    : '';
  const providerSessionId = instance?.sessionId ?? (
    productThreadId ? getResolvedExternalSessionId(productThreadId) : null
  );
  const canArchive =
    (agent.capabilities.supportsThreadArchive ?? false) && externalThreadId !== '';

  const badgeData = useMemo(() => computeAgentThreadCardBadgeData({
    threadState: projection ? {
      lastRun: projection.runs.lastRun,
      activeRunId: projection.runs.activeRunId,
      runs: projection.runs.runs,
    } : undefined,
    codexModel,
    typeKey: instance?.agentType ?? DEFAULT_AGENT_TYPE_KEY,
  }), [codexModel, instance?.agentType, projection]);

  const onArchive = useCallback(async () => {
    if (!productThreadId) return;
    try {
      await useAgentSessionStore.getState().archiveThread(
        productThreadId,
        () => toast.success(t('status.agent.archiveSuccess')),
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('status.agent.archiveFailed'),
      );
    }
  }, [productThreadId, t]);

  const onDelete = useCallback(async () => {
    if (!productThreadId) return;
    if (!window.confirm(t('document.agent.deleteConfirm'))) return;
    try {
      await useAgentSessionStore.getState().deleteThread(
        productThreadId,
        () => toast.success(t('status.agent.deleteSuccess')),
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('status.agent.deleteFailed'),
      );
    }
  }, [productThreadId, t]);

  const onOpenSourceDocument = useCallback(() => {
    if (!instance || !presentation?.hasSourceDocument) return;
    const { source } = presentation;
    const open = source?.memoId
      ? openNoteByMemoId(source.memoId)
      : source?.documentPath
        ? openExternalTarget(source.documentPath)
        : Promise.resolve();
    void open.catch(() => toast.error(t('status.agent.originUnavailable')));
  }, [instance, presentation, t]);

  const commitTitle = useCallback(() => {
    const title = titleDraft.trim();
    if (title && instance) {
      void useAgentSessionStore.getState().renameAgentConversation({
        instanceId: instance.instanceId,
        threadId: instance.threadId,
        title,
        typeKey: instance.agentType,
      });
    }
    setIsEditingTitle(false);
  }, [instance, titleDraft]);

  if (!instance || !presentation) return null;
  const { hasSourceDocument, runtimeCwd } = presentation;
  const actionButtonClass = isWindows
    ? DOCUMENT_TITLEBAR_ICON_BUTTON_WIN
    : DOCUMENT_TITLEBAR_ICON_BUTTON_MAC;

  return (
    <div
      data-tauri-drag-region
      className="relative flex h-full min-w-0 flex-1 items-center gap-2 pl-3"
    >
      <span className="agent-thread-card__badge-hover-wrapper shrink-0 [-webkit-app-region:no-drag]">
        <BadgeHoverCard
          threadId={productThreadId || undefined}
          sessionId={providerSessionId ?? undefined}
          model={badgeData.model}
          usage={badgeData.usage}
          onRequestRuntimeInfo={createRuntimeInfoRequester(
            instance.agentType,
            () => useAgentSessionStore.getState().getInstance(instanceId)?.threadId,
            () => {
              const current = useAgentSessionStore.getState().getInstance(instanceId);
              return current?.sessionId ?? (
                current?.threadId
                  ? getResolvedExternalSessionId(current.threadId)
                  : null
              );
            },
          )}
          codex={instance.agentType === 'codex'}
          cwd={runtimeCwd}
        />
        <span className="agent-type-badge" aria-hidden="true" title={agent.desc}>
          <AgentIcon typeKey={agent.key} alt="" className="agent-type-badge__icon" />
        </span>
      </span>
      {isEditingTitle ? (
        <div className="min-w-0 flex-[0_1_auto] truncate rounded px-0.5 py-1 text-sm font-semibold leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] focus-within:bg-[var(--muted)] [-webkit-app-region:no-drag]">
          <input autoFocus value={titleDraft}
            className="agent-thread-card__title-input h-auto max-w-full min-w-0 border-0 bg-transparent p-0 font-inherit leading-none text-[var(--foreground)] shadow-none outline-none ring-0 focus:border-0 focus:bg-transparent focus:outline-none focus:ring-0 [-webkit-app-region:no-drag]"
            onChange={(event) => setTitleDraft(event.target.value)} onBlur={commitTitle}
            onKeyDown={(event) => {
              // Enter is also emitted while an IME is confirming its current
              // candidate. Let the composition finish before allowing the
              // title editor to commit and blur.
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) return;
              if (event.key === 'Enter') { event.preventDefault(); commitTitle(); }
              if (event.key === 'Escape') setIsEditingTitle(false);
            }} />
        </div>
      ) : (
        <div className="min-w-0 flex-[0_1_auto] truncate rounded px-0.5 py-1 text-sm font-semibold leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]" onDoubleClick={() => {
          setTitleDraft(instance.title?.trim() || '');
          setIsEditingTitle(true);
        }}>{presentation.title}</div>
      )}
      <div className={`ml-auto flex shrink-0 items-center ${isWindows ? 'gap-2 pr-3' : 'gap-3 pr-3'}`}>
        {hasSourceDocument ? <>
            <button type="button" onClick={onOpenSourceDocument} aria-label={t('document.agent.viewInNote')}
              title={t('document.agent.viewInNote')} className={`${actionButtonClass} [-webkit-app-region:no-drag]`}>
              <FileTextIcon className="h-4 w-4" />
            </button>
          </> : (
            <span
              className="agent-thread-card__no-source"
              role="img"
              aria-label={t('document.agent.noSourceNote')}
              title={t('document.agent.noSourceNote')}
            >
              <LinkBreakIcon className="agent-thread-card__fullscreen-icon" aria-hidden="true" />
            </span>
          )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={t('document.agent.moreActions')} title={t('document.agent.moreActions')}
              className={`${actionButtonClass} [-webkit-app-region:no-drag]`}>
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[162px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            {canArchive ? (
              <DropdownMenuItem onClick={onArchive}
                className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-[var(--foreground)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
                <ArchiveIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t('document.agent.archiveConversation')}</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={onDelete}
              className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-[var(--destructive)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
              <TrashSimpleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('document.agent.deleteConversation')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function AgentConversationTitlebar({
  reserveWindowsControls = true,
  instanceId,
  isMiddleColumnCollapsed,
  isSidebarVisible,
  onExpandSidebar,
  onSidebarPreviewEnter,
  onSidebarPreviewLeave,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
}: {
  instanceId: string;
  reserveWindowsControls?: boolean;
  isMiddleColumnCollapsed: boolean;
  isSidebarVisible: boolean;
  onExpandSidebar: () => void;
  onSidebarPreviewEnter?: () => void;
  onSidebarPreviewLeave?: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
}) {
  const { t } = useI18n();
  const isWindows = isWindowsPlatform();

  const navigationButtonClass =
    'flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35';

  return (
    <WorkColumnTitlebarShell
      isWindows={isWindows}
      reserveWindowsControls={reserveWindowsControls}
      showTrafficLightSpacer={isMiddleColumnCollapsed && !isSidebarVisible}
      className="agent-conversation-titlebar"
    >
      <div className="flex shrink-0 items-center gap-1">
        {isMiddleColumnCollapsed && (
          <>
            <button
              type="button"
              onClick={onExpandSidebar}
              onMouseEnter={onSidebarPreviewEnter}
              onMouseLeave={onSidebarPreviewLeave}
              aria-label={t('document.titlebar.showSidebar')}
              title={t('document.titlebar.showSidebarTooltip')}
              className={`flex h-5 w-5 shrink-0 items-center justify-center text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] [-webkit-app-region:no-drag] ${
                isWindows ? 'rounded-lg' : 'rounded-xl'
              }`}
            >
              <SidebarToggleIcon
                className={isWindows ? 'h-4 w-4' : 'h-5 w-5'}
                variant="collapsed"
              />
            </button>
          </>
        )}
        <Tooltip content={t('document.titlebar.backTooltip')} shortcut="history.back">
          <button
            type="button"
            onClick={onNavigateBack}
            disabled={!canNavigateBack}
            aria-label={t('document.titlebar.back')}
            className={`${navigationButtonClass} [-webkit-app-region:no-drag]`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('document.titlebar.forwardTooltip')} shortcut="history.forward">
          <button
            type="button"
            onClick={onNavigateForward}
            disabled={!canNavigateForward}
            aria-label={t('document.titlebar.forward')}
            className={`${navigationButtonClass} [-webkit-app-region:no-drag]`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch">
        <AgentConversationHeader instanceId={instanceId} />
      </div>
    </WorkColumnTitlebarShell>
  );
}
