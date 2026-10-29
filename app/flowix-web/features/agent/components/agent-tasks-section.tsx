'use client';

import { useStartedLiveThreads } from './use-started-live-threads';

import { removeAgentConversation } from '@features/agent/use-cases/remove-conversation';
import { ConversationActionItems } from './conversation-action-items';
import { AgentConversationHoverCard } from '@features/agent/components/agent-conversation-hover-card';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { StarIcon } from '@phosphor-icons/react';
import { ArrowRight, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { AgentConversationTypeMenuItems } from '@features/agent/components/agent-conversation-type-menu-items';
import { useNewConversationAgentSelection } from '@features/agent/hooks/use-new-conversation-agent-selection';
import {
  createAndOpenAgentConversation,
  requestNewConversationAgentSelection,
} from '@features/agent/use-cases/new-conversation';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import {
  loadFavoriteAgentConversations,
  loadRecentAgentConversations,
} from '@features/agent/components/agent-tasks-recent';
import { agentClient } from '@features/agent/store/agent-client';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { isAgentConversationRunning } from '@features/agent/store/conversation-run-index';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useActiveAgentConversationInstanceId } from '@features/workspace/public/active-conversation-api';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { readFavoriteConversationIds, subscribeToFavoriteConversationChanges, toggleFavoriteConversation } from '@features/agent/conversation-favorites';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { Input } from '@shared/ui/input';
import { Button } from '@shared/ui/button';
import { TreeSectionEmptyState } from '@shared/ui/tree-section-empty-state';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import {
  getRecentAgentConversationsLimit,
  setRecentAgentConversationsLimit,
  useRecentAgentConversationsLimit,
} from '@features/preferences/public/user-settings-api';

import { selectVisibleConversations } from './conversation-list-model';
import { EMPTY_CONVERSATION_PAGE_STATE, mergeConversationPage, sortFavoriteConversations } from './conversation-list-pagination';

const logger = createLogger('agent-tasks-section');

export function AgentTasksSection({
  notebookId,
  edgeGutter = 6,
  order,
  onHeightChange,
  onShowAllConversations,
  sectionActions,
  onHideSection,
}: {
  notebookId: string;
  edgeGutter?: number;
  order: number;
  onHeightChange: (height: number) => void;
  onShowAllConversations: () => void;
  sectionActions?: ReactNode;
  /** 空状态里的「隐藏模块」入口，由文件树注入。 */
  onHideSection?: () => void;
}) {
  const { t } = useI18n();
  const recentConversationLimit = useRecentAgentConversationsLimit();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [storedConversations, setStoredConversations] = useState<AgentConversationInstance[]>([]);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [storedFavorites, setStoredFavorites] = useState<AgentConversationInstance[]>([]);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(() => readFavoriteConversationIds());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<AgentConversationInstance | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [conversationLimitDialogOpen, setConversationLimitDialogOpen] = useState(false);
  const [conversationLimitDraft, setConversationLimitDraft] = useState(String(recentConversationLimit));
  const lifecycleVersion = useAgentSessionStore((state) => state.lifecycleVersion);
  const threadTombstones = useAgentSessionStore((state) => state.threadTombstones);
  const startedLiveThreads = useStartedLiveThreads();
  const liveInstances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const conversationRunIndex = useAgentSessionStore((state) => state.threadRunSignatures);
  const latestCompletedRunIds = useAgentSessionStore((state) => state.latestCompletedRunIds);
  const readThroughRunIds = useAgentSessionStore((state) => state.readThroughRunIds);
  const activeConversationInstanceId = useActiveAgentConversationInstanceId();

  useEffect(() => subscribeToFavoriteConversationChanges(() => {
    setFavoriteIds(readFavoriteConversationIds());
  }), []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const recent = await loadRecentAgentConversations(
        notebookId,
        agentClient.listConversationInstancesPage,
        () => active,
        (hasMore) => { if (active) setHasMoreConversations(hasMore); },
        recentConversationLimit,
      );
      if (active) setStoredConversations(recent);
    };
    setStoredConversations([]);
    setHasMoreConversations(false);
    void load();
    return () => { active = false; };
  }, [lifecycleVersion, notebookId, recentConversationLimit]);

  useEffect(() => {
    const openLimitDialog = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== notebookId) return;
      setConversationLimitDraft(String(getRecentAgentConversationsLimit()));
      setConversationLimitDialogOpen(true);
    };
    window.addEventListener('flowix:configure-agent-conversation-count', openLimitDialog);
    return () => window.removeEventListener('flowix:configure-agent-conversation-count', openLimitDialog);
  }, [notebookId]);

  const saveConversationLimit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = Number(conversationLimitDraft);
    if (!Number.isFinite(parsed)) return;
    const limit = Math.min(50, Math.max(1, Math.floor(parsed)));
    setConversationLimitDraft(String(limit));
    void setRecentAgentConversationsLimit(limit);
    setConversationLimitDialogOpen(false);
  }, [conversationLimitDraft]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const favorites = await loadFavoriteAgentConversations(
        notebookId,
        favoriteIds,
        agentClient.getConversationInstancesByIds,
      );
      if (active) setStoredFavorites(favorites);
    };
    void load().catch((error) => {
      if (active) logger.warn('Failed to refresh favorite conversations', { error });
    });
    return () => { active = false; };
  }, [favoriteIds, lifecycleVersion, notebookId]);

  const tasks = useMemo(() => {
    const page = mergeConversationPage(EMPTY_CONVERSATION_PAGE_STATE, [
      ...storedFavorites.filter((item) => favoriteIds.has(item.instanceId)),
      ...storedConversations,
    ]);
    const conversations = selectVisibleConversations(
      page, liveInstances, notebookId, threadTombstones, startedLiveThreads,
    );
    const favorites = sortFavoriteConversations(conversations.filter((instance) => favoriteIds.has(instance.instanceId)));
    const recent = conversations
      .filter((instance) => !favoriteIds.has(instance.instanceId))
      .slice(0, recentConversationLimit);
    const combined = [...favorites, ...recent];
    return {
      items: combined.slice(0, recentConversationLimit),
      hasMore: hasMoreConversations || combined.length > recentConversationLimit,
    };
  }, [favoriteIds, hasMoreConversations, liveInstances, notebookId, recentConversationLimit, storedConversations, storedFavorites, threadTombstones, startedLiveThreads]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const reportHeight = () => onHeightChange(section.getBoundingClientRect().height);
    reportHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(section);
    return () => observer.disconnect();
  }, [onHeightChange, tasks.items.length]);

  const prepareConversation = useCallback((instance: AgentConversationInstance) => {
    useAgentSessionStore.getState().setConversationRegistry((registry) => ({
      ...registry,
      instances: { ...registry.instances, [instance.instanceId]: instance },
    }));
    if (instance.threadId) {
      useAgentSessionStore.getState().setSessionMeta((meta) => ({
        ...meta,
        activeThreadIds: { ...meta.activeThreadIds, [instance.agentType]: instance.threadId! },
        activeAgentTypeKey: instance.agentType,
      }));
    }
  }, []);

  /**
   * A file-tree conversation row opens in the Browser column. Every other tree
   * row (note, folder, collection…) keeps opening in Work, so the split lives
   * here rather than in the shared navigation use-cases.
   */
  const openConversation = useCallback((instance: AgentConversationInstance) => {
    prepareConversation(instance);
    if (instance.threadId) useAgentSessionStore.getState().markThreadRead(instance.threadId);
    void openWorkspaceSurface({ host: 'browser-column', target: { kind: 'agent-conversation', instanceId: instance.instanceId } }).catch((error) => {
      logger.error('Failed to open conversation in browser column', { error });
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [prepareConversation]);

  /** Menu escape hatch: the row click no longer targets Work. */
  const openConversationInWorkColumn = useCallback((instance: AgentConversationInstance) => {
    prepareConversation(instance);
    if (instance.threadId) useAgentSessionStore.getState().markThreadRead(instance.threadId);
    void openWorkspaceSurface({ host: 'main-third', target: { kind: 'agent-conversation', instanceId: instance.instanceId } }).catch((error) => {
      logger.error('Failed to open conversation in work column', { error });
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [prepareConversation]);

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
    const target = renameTarget;
    try {
      setRenameSaving(true);
      await useAgentSessionStore.getState().renameAgentConversation({
        instanceId: target.instanceId,
        threadId: target.threadId,
        title: renameDraft.trim(),
        typeKey: target.agentType,
      });
      setRenameTarget(null);
    } catch {
      toast.error(t('agent.chat.conversation.renameFailed'));
    } finally {
      setRenameSaving(false);
    }
  }, [renameDraft, renameTarget, t]);

  const removeConversation = useCallback(async (instance: AgentConversationInstance, action: 'archive' | 'delete') => {
    if (action === 'delete' && !window.confirm(t('agent.chat.conversation.deleteConfirm'))) return;
    try {
      await removeAgentConversation(instance, action);
      setOpenMenuId(null);
      toast.success(t(action === 'archive' ? 'status.agent.archiveSuccess' : 'status.agent.deleteSuccess'));
    } catch {
      toast.error(t(action === 'archive' ? 'status.agent.archiveFailed' : 'status.agent.deleteFailed'));
    }
  }, [t]);

  const showConversationContextMenu = useCallback((event: MouseEvent<HTMLDivElement>, instanceId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenMenuId(instanceId);
  }, []);

  const newConversationSelection = useNewConversationAgentSelection();

  const createConversation = useCallback((typeKey: AgentConversationInstance['agentType']) => {
    createAndOpenAgentConversation(typeKey, notebookId);
  }, [notebookId]);

  const showNewConversationMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenMenuId(null);
    const selection = requestNewConversationAgentSelection();
    if (selection.kind === 'create') {
      createConversation(selection.agentType);
      setCreateMenuOpen(false);
      return;
    }
    setCreateMenuOpen(selection.kind === 'choose');
  }, [createConversation]);

  useEffect(() => {
    if (createMenuOpen && newConversationSelection.kind !== 'choose') {
      setCreateMenuOpen(false);
    }
  }, [createMenuOpen, newConversationSelection]);

  const width = `calc(100% - ${edgeGutter * 2}px)`;

  return (
    <section
      ref={sectionRef}
      onContextMenu={showNewConversationMenu}
      className="pb-3"
      aria-label={t('memo.fileTree.agentsSectionTitle')}
      data-notebook-agent-section="true"
      style={{ order }}
    >
      <div
        className="notebook-file-tree__section-header group mb-0.5 flex h-7 items-center rounded-lg px-1.5 transition-colors hover:bg-[var(--muted)]"
        style={{ marginLeft: edgeGutter, width }}
      >
        <button
          type="button"
          className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
          aria-label={t(collapsed ? 'memo.fileTree.expandAgents' : 'memo.fileTree.collapseAgents')}
          title={t(collapsed ? 'memo.fileTree.expandAgents' : 'memo.fileTree.collapseAgents')}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>{t('memo.fileTree.agentsSectionTitle')}</span>
          <ChevronRight className={`h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100 ${collapsed ? 'opacity-100' : 'rotate-90'}`} />
        </button>
        <div className="ml-auto flex items-center">
          {sectionActions}
          <button
            type="button"
            onClick={onShowAllConversations}
            aria-label={t('memo.fileTree.openAllConversations')}
            title={t('memo.fileTree.openAllConversations')}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          >
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <DropdownMenu
            open={createMenuOpen}
            onOpenChange={(open) => {
              if (!open) {
                setCreateMenuOpen(false);
                return;
              }
              const selection = requestNewConversationAgentSelection();
              if (selection.kind === 'create') {
                createConversation(selection.agentType);
                setCreateMenuOpen(false);
                return;
              }
              setCreateMenuOpen(selection.kind === 'choose');
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={newConversationSelection.kind === 'none'}
                aria-label={t('agent.chat.newThread')}
                title={t('agent.chat.newThread')}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <DropdownMenuLabel className="flex items-center gap-1.5 px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
                {t('agent.chat.newThread')}
              </DropdownMenuLabel>
              <AgentConversationTypeMenuItems
                options={newConversationSelection.options}
                onSelect={createConversation}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {!collapsed && (tasks.items.length > 0 ? (
        <div className="group/conversation-list relative flex flex-col gap-0.5">
          {tasks.items.map((instance) => {
            const running = isAgentConversationRunning(instance, conversationRunIndex);
            const unread = !!instance.threadId
              && latestCompletedRunIds[instance.threadId] !== readThroughRunIds[instance.threadId]
              && activeConversationInstanceId !== instance.instanceId;
            return (
              <AgentConversationHoverCard
                key={instance.instanceId}
                instance={instance}
              >
                <div
                  onContextMenu={(event) => showConversationContextMenu(event, instance.instanceId)}
                  className={cn(
                    'group flex h-8 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-sm transition-colors hover:bg-[var(--muted)]',
                    activeConversationInstanceId === instance.instanceId && 'bg-[var(--muted)]',
                  )}
                  style={{ marginLeft: edgeGutter, width }}
                >
                  <button
                    type="button"
                    title={instance.title?.trim() || t('common.untitled')}
                    onClick={() => openConversation(instance)}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                      <AgentIcon typeKey={instance.agentType} alt="" className="h-4 w-4 object-contain" />
                      {(running || unread) && (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full',
                            running ? 'bg-[var(--success)]' : 'bg-[var(--muted-foreground)]',
                          )}
                        />
                      )}
                    </span>
                    <span className={cn(
                      'min-w-0 flex-1 truncate text-[var(--foreground)]',
                      activeConversationInstanceId === instance.instanceId ? 'opacity-100' : 'opacity-[0.82]',
                    )}>
                      {instance.title?.trim() || t('common.untitled')}
                    </span>
                  </button>
                  <DropdownMenu
                    open={openMenuId === instance.instanceId}
                    onOpenChange={(open) => setOpenMenuId(open ? instance.instanceId : null)}
                    className={cn('flex w-0 shrink-0 overflow-hidden opacity-0 transition-[width,opacity] duration-[37.5ms] group-hover:w-6 group-hover:opacity-100', openMenuId === instance.instanceId && 'w-6 opacity-100')}
                  >
                    <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                      <button type="button" aria-label={t('agent.chat.conversation.more')} className="rounded bg-[var(--muted)] p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                      <ConversationActionItems
                        favorite={favoriteIds.has(instance.instanceId)}
                        openHost="main-third"
                        onOpen={() => openConversationInWorkColumn(instance)}
                        onFavorite={() => toggleFavorite(instance.instanceId)}
                        onRename={() => renameConversation(instance)}
                        onArchive={() => void removeConversation(instance, 'archive')}
                        onDelete={() => void removeConversation(instance, 'delete')}
                        archiveSeparator
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
            );
          })}
          {tasks.hasMore && (
            <button
              type="button"
              onClick={onShowAllConversations}
              aria-label={t('memo.fileTree.viewAllConversations')}
              className="absolute bottom-1 z-10 mr-1 inline-flex h-6 w-6 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--document-bg)] text-[var(--muted-foreground)] opacity-0 shadow-[0_1px_4px_rgb(0_0_0_/_4.5%)] transition-[color,opacity] group-hover/conversation-list:opacity-100 group-focus-within/conversation-list:opacity-100 hover:text-[var(--foreground)]"
              style={{ right: edgeGutter }}
            >
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      ) : (
        <TreeSectionEmptyState
          message={t('memo.fileTree.sectionEmpty')}
          hideLabel={t('memo.fileTree.sectionEmptyHide')}
          onHide={onHideSection}
          edgeGutter={edgeGutter}
        />
      ))}
      <Dialog open={conversationLimitDialogOpen} onOpenChange={setConversationLimitDialogOpen}>
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader><DialogTitle>{t('memo.fileTree.configureConversationCount')}</DialogTitle></DialogHeader>
          <form onSubmit={saveConversationLimit} className="space-y-4">
            <label className="block space-y-2 text-sm text-[var(--muted-foreground)]">
              <span>{t('memo.fileTree.conversationCountLabel')}</span>
              <Input
                autoFocus
                type="number"
                min={1}
                max={50}
                step={1}
                required
                value={conversationLimitDraft}
                onChange={(event) => setConversationLimitDraft(event.target.value)}
              />
              <span className="block text-xs">{t('memo.fileTree.conversationCountHint')}</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setConversationLimitDialogOpen(false)}>{t('common.cancel')}</Button>
              <Button type="submit">{t('document.version.confirm')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && !renameSaving && setRenameTarget(null)}>
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader><DialogTitle>{t('agent.chat.conversation.rename')}</DialogTitle></DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); void submitRename(); }} className="space-y-4">
            <Input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} placeholder={t('agent.chat.conversation.renamePrompt')} disabled={renameSaving} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)} disabled={renameSaving}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={renameSaving || !renameDraft.trim()}>{t('document.version.confirm')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
