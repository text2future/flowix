'use client';

import { DialogFooter } from '@shared/ui/dialog-footer';
import { useStartedLiveThreads } from './use-started-live-threads';

import { removeAgentConversation } from '@features/agent/use-cases/remove-conversation';
import { prepareConversationForOpen } from '@features/agent/use-cases/prepare-conversation-open';
import { ConversationActionItems } from './conversation-action-items';
import { AgentConversationHoverCard } from '@features/agent/components/agent-conversation-hover-card';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import {
  StarIcon,
} from '@phosphor-icons/react';
import { ChevronLeft, Plus, MoreHorizontal } from 'lucide-react';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import {
  createAndOpenAgentConversation,
  requestNewConversationAgentSelection,
} from '@features/agent/use-cases/new-conversation';
import { useActiveAgentConversationInstanceId } from '@features/workspace/public/active-conversation-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useNoteStore } from '@features/memo/store/note-store';
import { isAgentConversationRunning } from '@features/agent/store/conversation-run-index';
import { useNewConversationAgentSelection } from '@features/agent/hooks/use-new-conversation-agent-selection';
import { AgentConversationTypeMenuItems } from '@features/agent/components/agent-conversation-type-menu-items';
import { getAgentType } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { formatTimeAgo } from '@/lib/format-time-ago';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  readFavoriteConversationIds,
  subscribeToFavoriteConversationChanges,
  toggleFavoriteConversation,
} from '@features/agent/conversation-favorites';
import { useI18n } from '@/lib/i18n';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import {
  ListSurfaceLoadingState,
  ListSurfaceSpinner,
  ListSurfaceViewport,
} from '@shared/ui/list-surface';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { Input } from '@shared/ui/input';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@shared/ui/context-menu';
import { useFixedVirtualList } from './use-fixed-virtual-list';
import { useConversationListData } from './use-conversation-list-data';
import { buildConversationListItems, selectVisibleConversations } from './conversation-list-model';

// 日期分组标题文案 key ── 用 as const 让每个 value 都是字面量 I18nKey, 直接喂 t()
// 无需 cast。分组顺序固定: 今天 → 昨天 → 最近 7 天 → 更早。
const CONVERSATION_GROUP_LABEL_KEY = {
  today: 'document.agent.group.today',
  yesterday: 'document.agent.group.yesterday',
  last7Days: 'document.agent.group.last7Days',
  earlier: 'document.agent.group.earlier',
} as const;
const logger = createLogger('agent-conversation-list');
const CONVERSATION_LOAD_MORE_THRESHOLD_PX = 80;

interface AgentConversationListProps {
  /** Keep durable list state while closing transient UI when hidden. */
  isActive?: boolean;
  onBack: () => void;
}

/**
 * The "Conversations" navigation view. It deliberately lists conversation
 * instances rather than notes: one note may contain more than one agent thread.
 * A row opens the conversation in the Work column, matching the 对话 section
 * in the file tree; the Browser column stays reachable from the row menu. The
 * source note is retained only as conversation metadata/context, not navigated.
 */
export function AgentConversationList({ isActive = true, onBack }: AgentConversationListProps) {
  const { t } = useI18n();
  const instances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const startedLiveThreads = useStartedLiveThreads();
  const threadTombstones = useAgentSessionStore((state) => state.threadTombstones);
  const lifecycleVersion = useAgentSessionStore((state) => state.lifecycleVersion);
  // This map changes only when lifecycle fields change, not for text chunks.
  // Rows can therefore read their running state in O(1) without rebuilding an
  // index by scanning every loaded conversation.
  const conversationRunIndex = useAgentSessionStore((state) => state.threadRunSignatures);
  const currentNotebookId = useNoteStore((state) => state.selectedNotebook?.id ?? null);
  // Highlight follows whatever surface is showing the conversation (Browser or
  // Work), not just the restored Work-column selection.
  const activeConversationInstanceId = useActiveAgentConversationInstanceId();
  const {
    conversationPage,
    isLoading,
    loadError,
    isLoadingMore,
    loadMoreError,
    hasMore,
    loadMore: loadMoreConversations,
    retryFirstPage,
    updateTitle,
  } = useConversationListData({
    isActive,
    notebookId: currentNotebookId,
    agentType: null,
    lifecycleVersion,
  });
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const latestCompletedRunIds = useAgentSessionStore((state) => state.latestCompletedRunIds);
  const readThroughRunIds = useAgentSessionStore((state) => state.readThroughRunIds);
  const markThreadRead = useAgentSessionStore((state) => state.markThreadRead);
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(() => {
    return readFavoriteConversationIds();
  });
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [newConversationMenuOpen, setNewConversationMenuOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AgentConversationInstance | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);

  useEffect(() => subscribeToFavoriteConversationChanges(() => {
    setFavoriteIds(readFavoriteConversationIds());
  }), []);

  useLayoutEffect(() => {
    if (isActive) return;
    // Keep list data and scroll position alive, but never leave a
    // portal-backed menu or dialog visible after this surface is hidden.
    setOpenMenuId(null);
    setNewConversationMenuOpen(false);
    setRenameTarget(null);
    setRenameDraft('');
    setRenameSaving(false);
    setShowScrollTopHint(false);
  }, [isActive]);

  const toggleFavorite = useCallback((instanceId: string) => {
    setFavoriteIds(toggleFavoriteConversation(instanceId));
    setOpenMenuId(null);
  }, []);

  const renameConversation = useCallback((instance: AgentConversationInstance) => {
    setRenameTarget(instance);
    setRenameDraft(instance.title?.trim() || '');
    setOpenMenuId(null);
  }, []);

  const submitRename = useCallback(async () => {
    if (!renameTarget || !renameDraft.trim()) return;
    const nextTitle = renameDraft.trim();
    const target = renameTarget;
    try {
      setRenameSaving(true);
      const renamePromise = useAgentSessionStore.getState().renameAgentConversation({
        instanceId: target.instanceId,
        threadId: target.threadId,
        title: nextTitle,
        typeKey: target.agentType,
      });
      // The backend list is refreshed by renameThread, but that request can
      // briefly return the old snapshot. Update this list's durable snapshot
      // too so the renamed title is visible immediately and cannot be
      // overwritten by the merge on the next render.
      updateTitle(
        target.instanceId,
        nextTitle,
        Math.max(Date.now(), target.updatedAt + 1),
      );
      setRenameTarget(null);
      setRenameSaving(false);
      await renamePromise;
    } catch {
      updateTitle(
        target.instanceId,
        target.title,
        target.updatedAt,
      );
      toast.error(t('agent.chat.conversation.renameFailed'));
    } finally {
      setRenameSaving(false);
    }
  }, [renameDraft, renameTarget, t, updateTitle]);

  const removeConversation = useCallback(async (instance: AgentConversationInstance, action: 'archive' | 'delete') => {
    const message = action === 'delete' ? t('agent.chat.conversation.deleteConfirm') : undefined;
    if (message && !window.confirm(message)) return;
    try {
      await removeAgentConversation(instance, action);
      setOpenMenuId(null);
      toast.success(t(action === 'archive' ? 'status.agent.archiveSuccess' : 'status.agent.deleteSuccess'));
    } catch {
      toast.error(t(action === 'archive' ? 'status.agent.archiveFailed' : 'status.agent.deleteFailed'));
    }
  }, [t]);

  const conversations = useMemo(() => selectVisibleConversations(
    conversationPage, instances, currentNotebookId, threadTombstones, startedLiveThreads,
  ), [conversationPage, currentNotebookId, instances, threadTombstones, startedLiveThreads]);

  useEffect(() => {
    if (!activeConversationInstanceId) return;
    const active = conversations.find((instance) => instance.instanceId === activeConversationInstanceId);
    if (active?.threadId) markThreadRead(active.threadId);
  }, [activeConversationInstanceId, conversations, markThreadRead]);

  const conversationListItems = useMemo(() => buildConversationListItems(
    conversations, favoriteIds, { isLoadingMore, loadMoreError },
  ), [conversations, favoriteIds, isLoadingMore, loadMoreError]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const {
    totalSize,
    virtualItems,
    onScroll: onVirtualListScroll,
  } = useFixedVirtualList(conversationListItems, scrollerRef, { overscan: 8 });

  const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    onVirtualListScroll(event);
    setShowScrollTopHint(target.scrollTop > 0);
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (hasMore && !isLoading && !loadError && !loadMoreError
      && distanceToBottom <= CONVERSATION_LOAD_MORE_THRESHOLD_PX) {
      void loadMoreConversations();
    }
  };

  const newConversationSelection = useNewConversationAgentSelection();

  useEffect(() => {
    if (newConversationMenuOpen && newConversationSelection.kind !== 'choose') {
      setNewConversationMenuOpen(false);
    }
  }, [newConversationMenuOpen, newConversationSelection]);

  const prepareConversation = useCallback((instance: AgentConversationInstance) => {
    // The durable list snapshot may arrive before the Zustand session store
    // hydrates. Opening a row only completes missing facts on the registered
    // instance, so a stale page can never downgrade what a column is showing.
    prepareConversationForOpen(instance);
  }, []);

  /**
   * Rows mirror the file tree's 对话 section: a click opens the conversation in
   * the Work column. Browser stays reachable through the row menu.
   */
  const revealConversation = useCallback((instance: AgentConversationInstance) => {
    prepareConversation(instance);
    if (instance.threadId) markThreadRead(instance.threadId);
    void openWorkspaceSurface({ index: 0, target: { kind: 'agent-conversation', instanceId: instance.instanceId } }).catch((error) => {
      logger.error('Failed to open conversation in work column', { error });
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [markThreadRead, prepareConversation]);

  /** Menu escape hatch: open the conversation in the Browser column. */
  const openConversationInBrowserColumn = useCallback((instance: AgentConversationInstance) => {
    prepareConversation(instance);
    if (instance.threadId) markThreadRead(instance.threadId);
    void openWorkspaceSurface({ index: 1, target: { kind: 'agent-conversation', instanceId: instance.instanceId } }).catch((error) => {
      logger.error('Failed to open conversation in browser column', { error });
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [markThreadRead, prepareConversation]);

  // 独立对话没有文档来源，但归属当前选中的 notebook。
  const createConversation = useCallback(
    (typeKey: AgentTypeKey) => {
      if (!currentNotebookId) return;
      createAndOpenAgentConversation(typeKey, currentNotebookId);
    },
    [currentNotebookId],
  );

  const requestNewConversation = useCallback(() => {
    const selection = requestNewConversationAgentSelection();
    if (selection.kind === 'create') {
      createConversation(selection.agentType);
      setNewConversationMenuOpen(false);
      return;
    }
    setNewConversationMenuOpen(selection.kind === 'choose');
  }, [createConversation]);

  useEffect(() => {
    window.addEventListener('flowix:open-agent-create-menu', requestNewConversation);
    return () => window.removeEventListener('flowix:open-agent-create-menu', requestNewConversation);
  }, [requestNewConversation]);

  return (
    <section className="relative flex h-full min-h-0 flex-1 flex-col bg-[var(--list-bg)]" aria-label={t('memo.navigation.conversations')}>
      {/* Content-page header below the persistent sidebar navigation tabs. */}
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              data-conversation-list-back
              aria-label={t('memo.navigation.backToFileTree')}
              title={t('memo.navigation.backToFileTree')}
              onClick={onBack}
              className="group flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-transparent p-0 text-sm text-[var(--foreground)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
            >
              <ChevronLeft className="h-4 w-4 transition-[filter] duration-150 group-hover:brightness-125" aria-hidden="true" />
            </button>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <DropdownMenu
              open={newConversationMenuOpen}
              onOpenChange={(open) => {
                if (open) requestNewConversation();
                else setNewConversationMenuOpen(false);
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={!currentNotebookId || newConversationSelection.kind === 'none'}
                  aria-label={t('agent.chat.newThread')}
                  title={currentNotebookId ? t('agent.chat.newThread') : t('memo.list.selectNotebook')}
                  className="group flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--foreground)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus
                    className="h-3.5 w-3.5 transition-[filter] duration-150 group-hover:brightness-125"
                    aria-hidden="true"
                  />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <DropdownMenuLabel className="flex items-center gap-1.5 px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
                  {t('agent.chat.newThread')}
                </DropdownMenuLabel>
                <AgentConversationTypeMenuItems
                  options={newConversationSelection.options}
                  disabled={!currentNotebookId}
                  onSelect={createConversation}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
      </div>
      <ListSurfaceViewport>
        <OverlayScrollbar
          className="h-full"
          scrollerRef={scrollerRef}
          scrollerClassName="h-full overflow-y-auto px-1 py-2"
          onScroll={handleListScroll}
        >
          {isLoading && conversations.length === 0 ? (
            <ListSurfaceLoadingState ariaLabel={t('status.agent.loadingConversations')} />
          ) : loadError && conversations.length === 0 ? (
            <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-[var(--muted-foreground)]" role="alert">
              <span>{t('status.agent.loadConversationsFailed')}</span>
              <Button size="sm" className="rounded-lg" onClick={retryFirstPage}>{t('error.retry')}</Button>
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-[var(--muted-foreground)]">
              {t('status.agent.noConversations')}
            </div>
          ) : (
            <>
            {(loadError || isLoading) && (
              loadError ? (
                <div className="flex items-center justify-center gap-2 px-2 py-1 text-xs text-[var(--muted-foreground)]" role="alert">
                  <span>{t('status.agent.loadConversationsFailed')}</span>
                  <Button size="xs" variant="ghost" className="rounded-lg" onClick={retryFirstPage}>{t('error.retry')}</Button>
                </div>
              ) : (
                <div className="flex items-center justify-center px-2 py-1">
                  <ListSurfaceSpinner
                    className="h-3.5 w-3.5"
                    ariaLabel={t('status.agent.loadingConversations')}
                  />
                </div>
              )
            )}
            <div className="relative min-h-full" style={{ height: totalSize }}>
              {virtualItems.map(({ item, start, size }) => {
                if (item.kind === 'heading') {
                  return (
                    <div
                      key={item.key}
                      className="absolute inset-x-0 top-0 flex flex-col justify-end gap-0.5"
                      style={{ height: size, transform: `translateY(${start}px)` }}
                    >
                      <h3 className="px-2 text-sm leading-6 font-medium text-[var(--muted-foreground)]">
                        {item.sectionKey === 'favorites'
                          ? t('agent.chat.conversation.favorites')
                          : t(CONVERSATION_GROUP_LABEL_KEY[item.sectionKey])}
                      </h3>
                    </div>
                  );
                }

                if (item.kind === 'loading') {
                  return (
                    <div
                      key={item.key}
                      className="absolute inset-x-0 top-0 flex items-center justify-center"
                      style={{ height: size, transform: `translateY(${start}px)` }}
                    >
                      <ListSurfaceSpinner
                        className="h-3.5 w-3.5"
                        ariaLabel={t('status.agent.loadingMoreConversations')}
                      />
                    </div>
                  );
                }

                if (item.kind === 'more-error') {
                  return (
                    <div
                      key={item.key}
                      className="absolute inset-x-0 top-0 flex items-center justify-center gap-2 text-xs text-[var(--muted-foreground)]"
                      style={{ height: size, transform: `translateY(${start}px)` }}
                      role="alert"
                    >
                      <span>{t('status.agent.loadConversationsFailed')}</span>
                      <Button size="xs" variant="ghost" className="rounded-lg" onClick={() => void loadMoreConversations(true)}>{t('error.retry')}</Button>
                    </div>
                  );
                }

                const instance = item.instance;
                const agent = getAgentType(instance.agentType);
                const selected = instance.instanceId === activeConversationInstanceId;
                const running = isAgentConversationRunning(instance, conversationRunIndex);
                return (
                  <ContextMenu key={item.key}>
                    <ContextMenuTrigger asChild>
                      <div
                        className="absolute inset-x-0 top-0"
                        style={{ height: size, transform: `translateY(${start}px)` }}
                      >
                        <AgentConversationHoverCard instance={instance}>
                          <div
                            className={cn(
                              'group relative flex h-9 w-full items-center rounded-lg px-2 text-left transition-colors',
                              selected ? 'bg-[var(--muted)]' : 'hover:bg-[var(--muted)]',
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => revealConversation(instance)}
                              title={t('status.agent.openConversation')}
                              className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-[var(--foreground)]"
                            >
                              <span className={cn(
                                'relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                                running && 'agent-conversation-list__icon--running',
                              )}>
                                <AgentIcon typeKey={agent.id} alt="" className="h-4 w-4 object-contain" />
                                {(running || (!!instance.threadId
                                  && latestCompletedRunIds[instance.threadId] !== readThroughRunIds[instance.threadId]
                                  && activeConversationInstanceId !== instance.instanceId)) && (
                                  <span
                                    aria-hidden="true"
                                    className={cn(
                                      'absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full',
                                      running ? 'bg-[var(--success)]' : 'bg-[var(--muted-foreground)]',
                                    )}
                                  />
                                )}
                              </span>
                              <span className={cn('agent-conversation-list__title min-w-0 flex-1 select-none text-sm font-normal', selected ? 'opacity-100' : 'opacity-80')}>
                                {instance.title?.trim() || t('common.untitled')}
                              </span>
                              <time className="shrink-0 text-xs text-[var(--muted-foreground)] group-hover:hidden" dateTime={new Date(instance.updatedAt).toISOString()}>
                                {formatTimeAgo(instance.updatedAt, t, { compact: true })}
                              </time>
                            </button>
                            <DropdownMenu
                              open={openMenuId === instance.instanceId}
                              onOpenChange={(open) => setOpenMenuId(open ? instance.instanceId : null)}
                              className={cn(
                                'flex w-0 shrink-0 overflow-hidden opacity-0 transition-[width,opacity] duration-[37.5ms] group-focus-within:w-6 group-focus-within:opacity-100 group-hover:w-6 group-hover:opacity-100',
                                openMenuId === instance.instanceId && 'w-6 opacity-100',
                              )}
                            >
                              <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                                <button
                                  type="button"
                                  aria-label={t('agent.chat.conversation.more')}
                                  className="rounded bg-[var(--muted)] p-1 text-[var(--muted-foreground)] transition-[opacity,color] hover:text-[var(--foreground)] focus-visible:opacity-100"
                                >
                                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                                <ConversationActionItems
                                  favorite={favoriteIds.has(instance.instanceId)}
                                  openHost="column-2"
                                  onOpen={() => openConversationInBrowserColumn(instance)}
                                  onFavorite={() => toggleFavorite(instance.instanceId)}
                                  onRename={() => renameConversation(instance)}
                                  onArchive={() => void removeConversation(instance, 'archive')}
                                  onDelete={() => void removeConversation(instance, 'delete')}
                                />
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <button
                              type="button"
                              aria-label={favoriteIds.has(instance.instanceId) ? t('agent.chat.conversation.unfavorite') : t('agent.chat.conversation.favorite')}
                              aria-pressed={favoriteIds.has(instance.instanceId)}
                              title={favoriteIds.has(instance.instanceId) ? t('agent.chat.conversation.unfavorite') : t('agent.chat.conversation.favorite')}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleFavorite(instance.instanceId);
                              }}
                              className={cn(
                                'shrink-0 overflow-hidden rounded p-1 text-[var(--muted-foreground)] transition-[width,opacity,color] duration-[37.5ms] hover:text-[var(--foreground)] focus-visible:opacity-100',
                                favoriteIds.has(instance.instanceId)
                                  ? 'w-6 opacity-100'
                                  : 'w-0 opacity-0 group-focus-within:w-6 group-focus-within:opacity-100 group-hover:w-6 group-hover:opacity-100',
                              )}
                            >
                              <StarIcon className="h-4 w-4" weight={favoriteIds.has(instance.instanceId) ? 'fill' : 'regular'} aria-hidden="true" />
                            </button>
                          </div>
                        </AgentConversationHoverCard>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                      <ConversationActionItems
                        context
                        favorite={favoriteIds.has(instance.instanceId)}
                        openHost="column-2"
                        onOpen={() => openConversationInBrowserColumn(instance)}
                        onFavorite={() => toggleFavorite(instance.instanceId)}
                        onRename={() => renameConversation(instance)}
                        onArchive={() => void removeConversation(instance, 'archive')}
                        onDelete={() => void removeConversation(instance, 'delete')}
                      />
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
            </>
          )}
        </OverlayScrollbar>
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-6 bg-gradient-to-b from-[var(--list-bg)] to-transparent transition-opacity duration-200',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />
      </ListSurfaceViewport>
      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && !renameSaving && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('agent.chat.conversation.rename')}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <Input
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              placeholder={t('agent.chat.conversation.renamePrompt')}
              disabled={renameSaving}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)} disabled={renameSaving}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={renameSaving || !renameDraft.trim()}>
                {t('document.version.confirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
