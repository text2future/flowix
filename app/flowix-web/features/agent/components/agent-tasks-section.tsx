'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ArchiveIcon, PencilSimpleIcon, SquareSplitHorizontalIcon, StarIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { AGENT_TYPES, isAgentTypeSelectable, isAlwaysVisibleNewConversationAgent } from '@/lib/agent-types';
import { buildInitialInstanceRuntimeConfig } from '@features/agent/store/initial-runtime-config';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { isAgentRuntimeInstalledState, normalizeAgentRuntimeStatus } from '@features/agent/runtime/agent-runtime-status';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import {
  isSyntheticOpenCodeHistoryInstance,
  loadRecentAgentConversations,
} from '@features/agent/components/agent-tasks-recent';
import { agentClient } from '@features/agent/store/agent-client';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { isAgentConversationRunning } from '@features/agent/store/conversation-run-index';
import { selectAndOpenAgentConversation } from '@features/workspace/use-cases/agent-conversation-navigation';
import { openBrowserColumnAgentConversation } from '@features/workspace/use-cases/browser-column-navigation';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { showAgentConversationsView } from '@features/memo/public/shell-api';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { readFavoriteConversationIds, subscribeToFavoriteConversationChanges, toggleFavoriteConversation } from '@features/agent/conversation-favorites';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { Input } from '@shared/ui/input';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';

const logger = createLogger('agent-tasks-section');

export function AgentTasksSection({
  notebookId,
  edgeGutter = 6,
  order,
  onHeightChange,
  sectionActions,
}: {
  notebookId: string;
  edgeGutter?: number;
  order: number;
  onHeightChange: (height: number) => void;
  sectionActions?: ReactNode;
}) {
  const { t } = useI18n();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [storedConversations, setStoredConversations] = useState<AgentConversationInstance[]>([]);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(() => readFavoriteConversationIds());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<AgentConversationInstance | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const lifecycleVersion = useAgentSessionStore((state) => state.lifecycleVersion);
  const liveInstances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const conversationRunIndex = useAgentSessionStore((state) => state.threadRunSignatures);
  const latestCompletedRunIds = useAgentSessionStore((state) => state.latestCompletedRunIds);
  const readThroughRunIds = useAgentSessionStore((state) => state.readThroughRunIds);
  const agentRuntimeStatusByType = useAgentRuntimeStore((state) => state.statusByType);
  const agentRuntimeIsChecking = useAgentRuntimeStore((state) => state.isChecking);
  const refreshAgentRuntimeIfStale = useAgentRuntimeStore((state) => state.refreshIfStale);
  const activeConversationInstanceId = useWorkColumnStore((state) => (
    state.navigation.target.kind === 'agent-conversation'
      ? state.navigation.target.instanceId
      : null
  ));

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
      );
      if (active) setStoredConversations(recent);
    };
    setStoredConversations([]);
    void load();
    return () => { active = false; };
  }, [lifecycleVersion, notebookId]);

  const tasks = useMemo(() => {
    const merged = new Map<string, AgentConversationInstance>();
    for (const instance of storedConversations) {
      if (instance.source.notebookId === notebookId) merged.set(instance.instanceId, instance);
    }
    for (const instance of Object.values(liveInstances)) {
      if (instance.source.notebookId !== notebookId) continue;
      const existing = merged.get(instance.instanceId);
      if (!existing || instance.updatedAt >= existing.updatedAt) merged.set(instance.instanceId, instance);
    }
    const conversations = [...merged.values()]
      .filter((instance) => !isSyntheticOpenCodeHistoryInstance(instance))
      .sort((left, right) => {
        const favoriteOrder = Number(favoriteIds.has(right.instanceId)) - Number(favoriteIds.has(left.instanceId));
        return favoriteOrder || right.updatedAt - left.updatedAt;
      });
    return conversations;
  }, [favoriteIds, liveInstances, notebookId, storedConversations]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const reportHeight = () => onHeightChange(section.getBoundingClientRect().height);
    reportHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(section);
    return () => observer.disconnect();
  }, [onHeightChange, tasks.length]);

  const openConversation = useCallback(async (instance: AgentConversationInstance) => {
    useAgentSessionStore.getState().setConversationRegistry((registry) => ({
      ...registry,
      instances: { ...registry.instances, [instance.instanceId]: instance },
    }));
    if (instance.threadId) {
      useAgentSessionStore.getState().markThreadRead(instance.threadId);
      useAgentSessionStore.getState().setSessionMeta((meta) => ({
        ...meta,
        activeThreadIds: { ...meta.activeThreadIds, [instance.agentType]: instance.threadId! },
        activeAgentTypeKey: instance.agentType,
      }));
    }
    await selectAndOpenAgentConversation(instance.instanceId);
  }, []);

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

  const openConversationInBrowserColumn = useCallback((instance: AgentConversationInstance) => {
    prepareConversation(instance);
    void openBrowserColumnAgentConversation(instance.instanceId).catch((error) => {
      logger.error('Failed to open conversation in browser column', { error });
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
      const session = useAgentSessionStore.getState();
      if (instance.threadId) {
        await (action === 'archive' ? session.archiveThread(instance.threadId) : session.deleteThread(instance.threadId));
      } else {
        session.removeInstance(instance.instanceId);
      }
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

  const newConversationAgentTypes = useMemo(
    () => AGENT_TYPES.filter((type) => {
      if (!isAgentTypeSelectable(type.key)) return false;
      if (isAlwaysVisibleNewConversationAgent(type.key)) return true;
      return isAgentRuntimeInstalledState(normalizeAgentRuntimeStatus(
        agentRuntimeStatusByType[type.key],
        agentRuntimeIsChecking,
      ));
    }),
    [agentRuntimeIsChecking, agentRuntimeStatusByType],
  );

  const createConversation = useCallback((typeKey: AgentConversationInstance['agentType']) => {
    const instance = useAgentSessionStore.getState().createInstance({
      agentType: typeKey,
      title: '',
      threadId: null,
      source: { kind: 'dedicated', notebookId, documentPath: null },
      runtimeConfig: buildInitialInstanceRuntimeConfig(typeKey),
    });
    void selectAndOpenAgentConversation(instance.instanceId);
  }, [notebookId]);

  const width = `calc(100% - ${edgeGutter * 2}px)`;

  return (
    <section
      ref={sectionRef}
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
          <DropdownMenu
            open={createMenuOpen}
            onOpenChange={(open) => {
              setCreateMenuOpen(open);
              if (open) void refreshAgentRuntimeIfStale();
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
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
              {newConversationAgentTypes.map((type) => {
                const runtimeStatus = normalizeAgentRuntimeStatus(
                  agentRuntimeStatusByType[type.key],
                  agentRuntimeIsChecking,
                );
                const showNotInstalled = isAlwaysVisibleNewConversationAgent(type.key)
                  && runtimeStatus.state === 'not-installed';
                const name = type.nameKey ? t(type.nameKey as Parameters<typeof t>[0]) : type.name;
                return (
                  <DropdownMenuItem
                    key={type.key}
                    onClick={() => createConversation(type.key)}
                    className="agent-conversation-new-agent-item group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                  >
                    <AgentIcon typeKey={type.key} alt="" className="h-4 w-4 shrink-0 object-contain" />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {showNotInstalled && (
                      <span className="shrink-0 text-xs text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]">
                        {t('agent.status.notInstalled')}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {!collapsed && (tasks.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {tasks.slice(0, 5).map((instance) => {
            const running = isAgentConversationRunning(instance, conversationRunIndex);
            const unread = !!instance.threadId
              && latestCompletedRunIds[instance.threadId] !== readThroughRunIds[instance.threadId]
              && activeConversationInstanceId !== instance.instanceId;
            return (
              <div
                key={instance.instanceId}
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
                  onClick={() => { void openConversation(instance); }}
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
                    <DropdownMenuItem onClick={() => openConversationInBrowserColumn(instance)} className="group h-7 items-center justify-start rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><SquareSplitHorizontalIcon className="mr-2 h-4 w-4" />{t('workColumn.context.openInBrowserColumn')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => toggleFavorite(instance.instanceId)} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><StarIcon className="h-4 w-4" weight={favoriteIds.has(instance.instanceId) ? 'fill' : 'regular'} />{favoriteIds.has(instance.instanceId) ? t('agent.chat.conversation.unfavorite') : t('agent.chat.conversation.favorite')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => renameConversation(instance)} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><PencilSimpleIcon className="h-4 w-4" />{t('agent.chat.conversation.rename')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void removeConversation(instance, 'archive')} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"><ArchiveIcon className="h-4 w-4" />{t('document.agent.archiveConversation')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void removeConversation(instance, 'delete')} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-transparent hover:text-[var(--destructive)]"><TrashSimpleIcon className="h-4 w-4" />{t('document.agent.deleteConversation')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          className="flex h-7 items-center justify-center px-1.5 text-xs text-[var(--muted-foreground)] opacity-50"
          style={{ marginLeft: edgeGutter, width }}
        >
          {t('memo.fileTree.agentsEmpty')}
        </div>
      ))}
      {!collapsed && tasks.length > 5 && (
        <button
          type="button"
          onClick={showAgentConversationsView}
          className="flex h-7 items-center rounded-lg px-1.5 text-left text-xs text-[color-mix(in_oklch,var(--muted-foreground)_67%,var(--background))] transition-colors hover:text-[var(--foreground)]"
          style={{ marginLeft: edgeGutter, width }}
        >
          {t('memo.fileTree.moreAgents')}
        </button>
      )}
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
