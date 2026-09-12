'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArchiveIcon, PencilSimpleIcon, PlusIcon, StarIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { Loader2 } from 'lucide-react';
import { MoreHorizontal } from 'lucide-react';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { normalizeBackendInstance } from '@features/agent/store/conversation-slice';
import { buildInitialInstanceRuntimeConfig } from '@features/agent/store/initial-runtime-config';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
import { selectAndOpenAgentConversation } from '@features/workspace/use-cases/agent-conversation-navigation';
import { useMemoStore } from '@features/memo';
import { agentClient } from '@features/agent/store/agent-client';
import {
  isAgentConversationRunning,
} from '@features/agent/store/conversation-run-index';
import { AGENT_TYPES, getAgentType, isAgentTypeSelectable } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import type { AgentConversationCursor } from '@platform/tauri/client/agent';
import { formatTimeAgo } from '@/lib/format-time-ago';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { MemoListViewTabs } from '@features/memo/components/memo-list-view-tabs';
import { Input } from '@shared/ui/input';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useFixedVirtualList, type FixedVirtualListItem } from './use-fixed-virtual-list';
import {
  EMPTY_CONVERSATION_PAGE_STATE,
  mergeConversationPage,
  mergeLiveConversation,
  sortFavoriteConversations,
  updateConversationTitle,
  type ConversationPageState,
} from './conversation-list-pagination';

/**
 * The "Conversations" navigation view. It deliberately lists conversation
 * instances rather than notes: one note may contain more than one agent thread.
 * A row opens the dedicated right-panel conversation surface directly; the
 * source note is retained only as conversation metadata/context, not navigated.
 */
type ConversationGroupKey = 'today' | 'yesterday' | 'last7Days' | 'earlier';
type ConversationSectionKey = ConversationGroupKey | 'favorites';

type ConversationListItem = FixedVirtualListItem & (
  | {
      kind: 'heading';
      sectionKey: ConversationSectionKey;
    }
  | {
      kind: 'conversation';
      instance: AgentConversationInstance;
    }
  | {
      kind: 'loading';
    }
);

// 日期分组标题文案 key ── 用 as const 让每个 value 都是字面量 I18nKey, 直接喂 t()
// 无需 cast。分组顺序固定: 今天 → 昨天 → 最近 7 天 → 更早。
const CONVERSATION_GROUP_LABEL_KEY = {
  today: 'document.agent.group.today',
  yesterday: 'document.agent.group.yesterday',
  last7Days: 'document.agent.group.last7Days',
  earlier: 'document.agent.group.earlier',
} as const;
const logger = createLogger('agent-conversation-list');
const CONVERSATION_PAGE_SIZE = 30;

interface AgentConversationListProps {
  /** Keep durable list state while closing transient UI when hidden. */
  isActive?: boolean;
}

/** OpenCode history listing previously materialized provider-only sessions as
 * `legacy-ses_...` instances. They have no Flowix-owned conversation and must
 * not be shown alongside real conversation cards. */
function isSyntheticOpenCodeHistoryInstance(instance: AgentConversationInstance): boolean {
  return instance.agentType === 'opencode'
    && !!instance.threadId
    && instance.instanceId === `legacy-${instance.threadId}`
    && instance.threadId.startsWith('ses_');
}

export function AgentConversationList({ isActive = true }: AgentConversationListProps) {
  const { t } = useI18n();
  const instances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const threadTombstones = useAgentSessionStore((state) => state.threadTombstones);
  const lifecycleVersion = useAgentSessionStore((state) => state.lifecycleVersion);
  // This map changes only when lifecycle fields change, not for text chunks.
  // Rows can therefore read their running state in O(1) without rebuilding an
  // index by scanning every loaded conversation.
  const conversationRunIndex = useAgentSessionStore((state) => state.threadRunSignatures);
  const currentNotebookId = useMemoStore((state) => state.selectedNotebook?.id ?? null);
  const middleColumnView = useMemoStore((state) => state.middleColumnView);
  const setActiveFilter = useMemoStore((state) => state.setActiveFilter);
  const selectedInstanceId = useWorkspaceRestoreStore(
    (state) => state.agentConversation.selectedInstanceId,
  );
  const conversationDetailOpen = useWorkspaceRestoreStore(
    (state) => state.agentConversation.detailOpen,
  );
  const [conversationPage, setConversationPage] = useState<ConversationPageState>(
    EMPTY_CONVERSATION_PAGE_STATE,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [agentTypeCounts, setAgentTypeCounts] = useState<Readonly<Record<string, number>>>({});
  const nextCursorRef = useRef<AgentConversationCursor | null>(null);
  const listQueryKeyRef = useRef('');
  const loadingMoreRef = useRef(false);
  const [filterType, setFilterType] = useState<AgentTypeKey | null>(null);
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  // 对话刚结束但用户还没点进去看过的 instanceId 集合 ── 用本地 Set 记录,
  // 是会话级瞬态状态, 刷新即丢失 (需求里"前端状态"对应)。
  // 灰色小圆点显示条件: !running && justEndedIds.has(instanceId)。
  const [justEndedIds, setJustEndedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const stored = JSON.parse(window.localStorage.getItem('flowix:favorite-conversations') ?? '[]');
      return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [newConversationMenuOpen, setNewConversationMenuOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AgentConversationInstance | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);

  useLayoutEffect(() => {
    if (isActive) return;
    // Keep list data, filters, and scroll position alive, but never leave a
    // portal-backed menu or dialog visible after this surface is hidden.
    setOpenMenuId(null);
    setNewConversationMenuOpen(false);
    setRenameTarget(null);
    setRenameDraft('');
    setRenameSaving(false);
    setShowScrollTopHint(false);
    setJustEndedIds((current) => (current.size === 0 ? current : new Set()));
  }, [isActive]);

  useEffect(() => {
    const handleOpenCreateMenu = () => setNewConversationMenuOpen(true);
    window.addEventListener('flowix:open-agent-create-menu', handleOpenCreateMenu);
    return () => window.removeEventListener('flowix:open-agent-create-menu', handleOpenCreateMenu);
  }, []);

  const toggleFavorite = useCallback((instanceId: string) => {
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (next.has(instanceId)) next.delete(instanceId);
      else next.add(instanceId);
      try { window.localStorage.setItem('flowix:favorite-conversations', JSON.stringify([...next])); } catch { /* storage is optional */ }
      return next;
    });
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
      setConversationPage((current) => updateConversationTitle(
        current,
        target.instanceId,
        nextTitle,
        Math.max(Date.now(), target.updatedAt + 1),
      ));
      setRenameTarget(null);
      setRenameSaving(false);
      await renamePromise;
    } catch {
      setConversationPage((current) => updateConversationTitle(
        current,
        target.instanceId,
        target.title,
        target.updatedAt,
      ));
      toast.error(t('agent.chat.conversation.renameFailed'));
    } finally {
      setRenameSaving(false);
    }
  }, [renameDraft, renameTarget, t]);

  const removeConversation = useCallback(async (instance: AgentConversationInstance, action: 'archive' | 'delete') => {
    const message = action === 'delete' ? t('agent.chat.conversation.deleteConfirm') : undefined;
    if (message && !window.confirm(message)) return;
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

  // The list owns a durable paged snapshot from the backend. Zustand is only
  // merged for live rows created or mounted in this window; history is never
  // hydrated wholesale just to render the sidebar.
  useEffect(() => {
    let active = true;
    const queryKey = `${currentNotebookId ?? ''}\u001f${filterType ?? ''}`;
    const query = { notebookId: currentNotebookId, agentType: filterType, cursor: null } as const;
    listQueryKeyRef.current = queryKey;
    nextCursorRef.current = null;
    setConversationPage(EMPTY_CONVERSATION_PAGE_STATE);
    setHasMore(true);
    // Lifecycle changes can trigger a fresh first page after the view is
    // mounted, keeping deletion/archive state aligned with the backend.
    setIsLoading(true);
    void agentClient.listConversationInstancesPage(query, CONVERSATION_PAGE_SIZE)
      .then(({ items, hasMore: nextHasMore, nextCursor }) => {
        if (!active) return;
        nextCursorRef.current = nextCursor;
        setHasMore(nextHasMore);
        setConversationPage(mergeConversationPage(
          EMPTY_CONVERSATION_PAGE_STATE,
          items.map(normalizeBackendInstance),
        ));
      })
      .catch((error) => {
        logger.error('failed to load conversations', { error });
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentNotebookId, filterType, lifecycleVersion]);

  // Facets stay small even when the conversation history is large. This lets
  // the agent filter describe the complete notebook while the conversation
  // rows themselves remain cursor-paginated.
  useEffect(() => {
    let active = true;
    void agentClient.listConversationTypeCountsByNotebook(currentNotebookId)
      .then((counts) => {
        if (!active) return;
        setAgentTypeCounts(Object.fromEntries(
          counts.map(({ agentType, count }) => [agentType, count]),
        ));
      })
      .catch((error) => {
        logger.error('failed to load conversation type counts', { error });
      });
    return () => {
      active = false;
    };
  }, [currentNotebookId, lifecycleVersion]);

  const loadMoreConversations = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    const queryKey = `${currentNotebookId ?? ''}\u001f${filterType ?? ''}`;
    try {
      const query = { notebookId: currentNotebookId, agentType: filterType, cursor: nextCursorRef.current };
      const { items, hasMore: nextHasMore, nextCursor } = await agentClient.listConversationInstancesPage(
        query,
        CONVERSATION_PAGE_SIZE,
      );
      if (listQueryKeyRef.current !== queryKey) return;
      nextCursorRef.current = nextCursor;
      setHasMore(nextHasMore);
      setConversationPage((current) => mergeConversationPage(
        current,
        items.map(normalizeBackendInstance),
      ));
    } catch (error) {
      logger.error('failed to load more conversations', { error });
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [currentNotebookId, filterType, hasMore]);

  const conversations = useMemo(() => {
    // The backend snapshot is the durable source of truth. An editor card is
    // intentionally not mounted in every document/webview, so using the
    // in-memory registry as an allow-list makes valid conversations disappear
    // whenever a card is temporarily unmounted or hydration is still pending.
    let merged = conversationPage;
    for (const instance of Object.values(instances)) {
      if (filterType && instance.agentType !== filterType) continue;
      const notebookId = instance.source?.notebookId;
      if (currentNotebookId && notebookId !== currentNotebookId) continue;
      merged = mergeLiveConversation(merged, instance);
    }
    return merged.orderedIdentities
      .map((identity) => merged.itemsByIdentity[identity])
      .filter((instance): instance is AgentConversationInstance => !!instance)
      .filter((instance) => !isSyntheticOpenCodeHistoryInstance(instance))
      .filter((instance) => !instance.threadId || !threadTombstones[instance.threadId]);
  }, [conversationPage, currentNotebookId, filterType, instances, threadTombstones]);

  // 跟踪每个 instanceId 上一帧的 running 状态 ── 用 ref 而不是 state, 避免
  // 把上一帧值注入到 React 渲染链路后引发额外渲染。effect 在 commit 之后跑,
  // 读 ref 不会破坏当前帧。
  const previousRunningRef = useRef<ReadonlyMap<string, boolean>>(new Map());

  // 监听 running 跳变: true → false 时把 instanceId 加进 justEndedIds;
  // 但当前正在查看的对话不属于“待查看”。再次进入 running 时主动从 set
  // 移除 (用户重启 agent, 不应该残留灰色 dot)。
  useEffect(() => {
    const previous = previousRunningRef.current;
    const currentIds = new Set<string>();
    const nextJustEnded = new Set(justEndedIds);
    let changed = false;
    for (const instance of conversations) {
      currentIds.add(instance.instanceId);
      const isRunning = isAgentConversationRunning(instance, conversationRunIndex);
      const wasRunning = previous.get(instance.instanceId) ?? false;
      if (wasRunning && !isRunning) {
        const isBeingViewed = conversationDetailOpen
          && selectedInstanceId === instance.instanceId;
        // 运行结束时如果详情页正打开，用户已经在看，不应产生待查看提示。
        if (isBeingViewed) {
          if (nextJustEnded.delete(instance.instanceId)) changed = true;
        } else if (!nextJustEnded.has(instance.instanceId)) {
          // 刚结束且未查看: 加入集合 (如果尚未存在)。
          nextJustEnded.add(instance.instanceId);
          changed = true;
        }
      } else if (!wasRunning && isRunning) {
        // 重新运行: 清掉可能残留的灰色标记。
        if (nextJustEnded.has(instance.instanceId)) {
          nextJustEnded.delete(instance.instanceId);
          changed = true;
        }
      }
    }
    // 整个列表已经见不到的 instanceId 不再保留其 justEnded 标记 ── 避免 set 无限增长。
    for (const id of nextJustEnded) {
      if (!currentIds.has(id)) {
        nextJustEnded.delete(id);
        changed = true;
      }
    }
    if (changed) setJustEndedIds(nextJustEnded);
    // 同步快照以备下一帧比较。
    const snapshot = new Map<string, boolean>();
    for (const instance of conversations) {
      snapshot.set(instance.instanceId, isAgentConversationRunning(instance, conversationRunIndex));
    }
    previousRunningRef.current = snapshot;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, conversationDetailOpen, conversationRunIndex, selectedInstanceId]);

  // 按当前笔记本严格圈定对话列表 —— 只有归属当前笔记本的会话可见。
  // 未归属笔记本的历史数据不应出现在任何笔记本列表中；未选中笔记本时退化为全量。
  const scopedConversations = useMemo(() => {
    if (!currentNotebookId) return conversations;
    return conversations.filter((instance) => {
      const notebookId = instance.source?.notebookId;
      return notebookId === currentNotebookId;
    });
  }, [conversations, currentNotebookId]);

  // 筛选条只展示"已激活"的 agent 类型 ── 即当前对话列表里真实存在 (count > 0)
  // 且可选用 (非 coming-soon) 的 agent。按 AGENT_TYPES 定义顺序排列，保证图标
  // 顺序稳定。少于 2 种时不渲染筛选条：单一类型没有可筛选的空间，一个按下后
  // 毫无视觉变化的按钮只会让用户困惑。
  const activeAgentTypes = useMemo(() => {
    const counts = new Map<AgentTypeKey, number>();
    if (Object.keys(agentTypeCounts).length > 0) {
      for (const type of AGENT_TYPES) {
        const count = agentTypeCounts[type.key];
        if (count && isAgentTypeSelectable(type.key)) counts.set(type.key, count);
      }
    } else {
      for (const instance of scopedConversations) {
        if (!isAgentTypeSelectable(instance.agentType)) continue;
        counts.set(instance.agentType, (counts.get(instance.agentType) ?? 0) + 1);
      }
    }
    return AGENT_TYPES
      .filter((type) => counts.has(type.key))
      .map((type) => ({ type, count: counts.get(type.key) ?? 0 }));
  }, [agentTypeCounts, scopedConversations]);

  // 对话可能在筛选期间变成空集 (例如全部删除) ── 若当前筛选的类型已不再激活，
  // 自动回退到"全部"，避免列表卡在空状态。
  const effectiveFilter: AgentTypeKey | null =
    filterType && activeAgentTypes.some((entry) => entry.type.key === filterType)
      ? filterType
      : null;

  const visibleConversations = effectiveFilter
    ? scopedConversations.filter((instance) => instance.agentType === effectiveFilter)
    : scopedConversations;

  const favoriteConversations = useMemo(
    () => sortFavoriteConversations(
      visibleConversations.filter((instance) => favoriteIds.has(instance.instanceId)),
    ),
    [visibleConversations, favoriteIds],
  );
  const nonFavoriteConversations = useMemo(
    () => visibleConversations.filter((instance) => !favoriteIds.has(instance.instanceId)),
    [visibleConversations, favoriteIds],
  );

  // 按日期分桶 (基于 updatedAt)。visibleConversations 已按 updatedAt DESC 排好,
  // 逐条归入桶即保持桶内顺序; 只渲染非空桶, 桶间用 mt-3 分隔。
  const conversationGroups = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfYesterday = startOfToday - dayMs;
    const startOf7Days = startOfToday - 7 * dayMs;
    const buckets: Record<ConversationGroupKey, AgentConversationInstance[]> = {
      today: [],
      yesterday: [],
      last7Days: [],
      earlier: [],
    };
    for (const instance of nonFavoriteConversations) {
      const ts = instance.updatedAt;
      if (ts >= startOfToday) buckets.today.push(instance);
      else if (ts >= startOfYesterday) buckets.yesterday.push(instance);
      else if (ts >= startOf7Days) buckets.last7Days.push(instance);
      else buckets.earlier.push(instance);
    }
    return (['today', 'yesterday', 'last7Days', 'earlier'] as ConversationGroupKey[])
      .map((key) => ({ key, items: buckets[key] }))
      .filter((group) => group.items.length > 0);
  }, [nonFavoriteConversations]);

  const conversationSections = favoriteConversations.length > 0
    ? [{ key: 'favorites' as const, items: favoriteConversations }, ...conversationGroups]
    : conversationGroups;

  const conversationListItems = useMemo<ConversationListItem[]>(() => {
    const items: ConversationListItem[] = [];
    conversationSections.forEach((group, groupIndex) => {
      items.push({
        kind: 'heading',
        key: `heading:${group.key}`,
        sectionKey: group.key,
        // The heading uses a 24px line height. Keep the 12px section margin
        // and 4px outer flex gap in the virtual item.
        size: 24 + (groupIndex > 0 ? 16 : 0),
      });
      group.items.forEach((instance, itemIndex) => {
        items.push({
          kind: 'conversation',
          key: `conversation:${instance.instanceId}`,
          instance,
          // h-9 row plus the existing gap-0.5 between rows.
          size: 36 + (itemIndex < group.items.length - 1 ? 2 : 0),
        });
      });
    });
    if (isLoadingMore) {
      items.push({ kind: 'loading', key: 'loading-more', size: 36 });
    }
    return items;
  }, [conversationSections, isLoadingMore]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const {
    totalSize,
    virtualItems,
    onScroll: onVirtualListScroll,
  } = useFixedVirtualList(conversationListItems, scrollerRef, { overscan: 8 });

  const displayName = (type: (typeof AGENT_TYPES)[number]): string =>
    type.nameKey ? t(type.nameKey as Parameters<typeof t>[0]) : type.name;

  const revealConversation = useCallback(async (instance: AgentConversationInstance) => {
    // 第一次访问: 立即清掉该对话的"刚结束"灰色 dot, 做到"看见一次就消失"。
    if (justEndedIds.has(instance.instanceId)) {
      const next = new Set(justEndedIds);
      next.delete(instance.instanceId);
      setJustEndedIds(next);
    }

    // The durable list snapshot may arrive before the Zustand session store
    // hydrates. Install this exact persisted instance without rewriting it so
    // the right panel can immediately resolve its runtime configuration.
    useAgentSessionStore.getState().setConversationRegistry((registry) => ({
      ...registry,
      instances: {
        ...registry.instances,
        [instance.instanceId]: instance,
      },
    }));

    if (instance.threadId) {
      useAgentSessionStore.getState().setSessionMeta((meta) => ({
        ...meta,
        activeThreadIds: {
          ...meta.activeThreadIds,
          [instance.agentType]: instance.threadId!,
        },
        activeAgentTypeKey: instance.agentType,
      }));
    }

    await selectAndOpenAgentConversation(instance.instanceId);
  }, [justEndedIds]);

  // 独立对话: 无文档 (memoId / documentPath 均为 null), 但归属当前选中的
  // notebook。notebook 未选中时不可新建 (cwd 无法解析到笔记本路径)。
  const createConversation = useCallback(
    (typeKey: AgentTypeKey) => {
      if (!currentNotebookId) return;
      const instance = useAgentSessionStore.getState().createInstance({
        agentType: typeKey,
        title: '',
        threadId: null,
        source: {
          kind: 'dedicated',
          notebookId: currentNotebookId,
          memoId: null,
          documentPath: null,
        },
        role: undefined,
        runtimeConfig: buildInitialInstanceRuntimeConfig(typeKey),
      });
      void selectAndOpenAgentConversation(instance.instanceId);
    },
    [currentNotebookId],
  );

  return (
    <section className="relative flex h-full min-h-0 flex-1 flex-col bg-[var(--card)]" aria-label={t('memo.navigation.conversations')}>
      {/* 标题行 ── 与 MemoList / FolderFileTree 共用同一套中间列头部结构:
          左侧标题占据剩余空间, 右侧保留本列表自己的筛选控件。 */}
      <div className="flex items-center justify-between px-3 pb-2 gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <MemoListViewTabs
              activeTab={middleColumnView === 'conversations' ? 'conversations' : 'notes'}
              onChange={(tab) => setActiveFilter(tab === 'conversations' ? 'agents' : 'all')}
            />
            <span className="min-w-0 truncate text-[15px] font-medium text-[var(--foreground)]">
              {t('memo.navigation.conversations')}
            </span>
            {activeAgentTypes.length >= 2 && (
              <div
                className="flex shrink-0 items-center gap-1"
                role="group"
                aria-label={t('document.agent.filterByAgent')}
              >
                {activeAgentTypes.map(({ type, count }) => {
                  const active = effectiveFilter === type.key;
                  const label = t('document.agent.filterByAgentCount', {
                    name: displayName(type),
                    count,
                  });
                  return (
                    <button
                      key={type.key}
                      type="button"
                      aria-pressed={active}
                      title={label}
                      aria-label={label}
                      onClick={() => setFilterType((prev) => (prev === type.key ? null : type.key))}
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                        active
                          ? 'border-transparent bg-[var(--muted)]'
                          : 'border-[var(--border)] opacity-20 hover:opacity-100',
                      )}
                    >
                      <AgentIcon typeKey={type.key} alt="" className="h-full w-full object-contain" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <DropdownMenu
              open={newConversationMenuOpen}
              onOpenChange={setNewConversationMenuOpen}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={!currentNotebookId}
                  aria-label={t('agent.chat.newThread')}
                  title={currentNotebookId ? t('agent.chat.newThread') : t('memo.list.selectNotebook')}
                  className="group flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-transparent bg-[var(--primary)] p-0 text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <PlusIcon
                    className="h-4 w-4 transition-[filter] duration-150 group-hover:brightness-105"
                    weight="bold"
                    aria-hidden="true"
                  />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <DropdownMenuLabel className="flex items-center gap-1.5 px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
                  {t('agent.chat.newThread')}
                </DropdownMenuLabel>
                {AGENT_TYPES.filter((type) => isAgentTypeSelectable(type.key)).map((type) => (
                  <DropdownMenuItem
                    key={type.key}
                    disabled={!currentNotebookId}
                    onClick={() => createConversation(type.key)}
                    className="agent-conversation-new-agent-item group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                  >
                    <AgentIcon typeKey={type.key} alt="" className="h-4 w-4 shrink-0 object-contain" />
                    <span className="min-w-0 flex-1 truncate">{displayName(type)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <OverlayScrollbar
          className="h-full"
          scrollerRef={scrollerRef}
          scrollerClassName="h-full overflow-y-auto px-1 py-2"
          onScroll={(event) => {
            const target = event.currentTarget;
            onVirtualListScroll(event);
            setShowScrollTopHint(target.scrollTop > 0);
            if (hasMore && target.scrollTop + target.clientHeight >= target.scrollHeight - 80) {
              void loadMoreConversations();
            }
          }}
        >
          {isLoading ? (
            <div
              className="flex h-full min-h-0 w-full items-center justify-center gap-2 px-4 text-center text-sm text-[var(--muted-foreground)]"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" aria-hidden="true" />
              <span>{t('status.agent.loadingConversations')}</span>
            </div>
          ) : scopedConversations.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-[var(--muted-foreground)]">
              {t('status.agent.noConversations')}
            </div>
          ) : (
            <div className="relative min-h-full" style={{ height: totalSize }}>
              {virtualItems.map(({ item, start, size }) => {
                if (item.kind === 'heading') {
                  return (
                    <div
                      key={item.key}
                      className="absolute inset-x-0 top-0 flex flex-col justify-end gap-0.5"
                      style={{ height: size, transform: `translateY(${start}px)` }}
                    >
                      <h3 className="px-2 text-xs leading-6 font-medium text-[var(--muted-foreground)]">
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
                      className="absolute inset-x-0 top-0 pt-3 pb-2 text-center text-xs text-[var(--muted-foreground)]"
                      style={{ height: size, transform: `translateY(${start}px)` }}
                      aria-live="polite"
                    >
                      {t('memo.list.loadingLibrary')}
                    </div>
                  );
                }

                const instance = item.instance;
                const agent = getAgentType(instance.agentType);
                const selected = instance.instanceId === selectedInstanceId;
                const running = isAgentConversationRunning(instance, conversationRunIndex);
                return (
                  <div
                    key={item.key}
                    className="absolute inset-x-0 top-0"
                    style={{ height: size, transform: `translateY(${start}px)` }}
                  >
                    <div
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setOpenMenuId(instance.instanceId);
                      }}
                      className={cn(
                        'group relative flex h-9 w-full items-center rounded-lg px-2 text-left transition-colors',
                        selected ? 'bg-[var(--muted)]' : 'hover:bg-[var(--muted)]',
                      )}
                      >
                        <button
                          type="button"
                          onClick={() => void revealConversation(instance)}
                          title={t('status.agent.openConversation')}
                          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-[var(--foreground)]"
                        >
                        <span className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                          running && 'agent-conversation-list__icon--running',
                        )}>
                          <AgentIcon typeKey={agent.key} alt="" className="h-3.5 w-3.5 object-contain" />
                        </span>
                        {running ? (
                          // 绿色: agent 正在运行
                          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />
                        ) : justEndedIds.has(instance.instanceId)
                          && !(conversationDetailOpen && selectedInstanceId === instance.instanceId) ? (
                          // 灰色: 刚跑完、本次会话内用户还没点进去过
                          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--muted-foreground)]" />
                        ) : null}
                        <span className="agent-conversation-list__title min-w-0 flex-1 select-none text-sm font-normal">
                          {instance.title?.trim() || t('common.untitled')}
                        </span>
                        <time className="shrink-0 text-xs text-[var(--muted-foreground)] group-hover:hidden" dateTime={new Date(instance.updatedAt).toISOString()}>
                          {formatTimeAgo(instance.updatedAt, t, { compact: true })}
                        </time>
                        </button>
                        <>
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
                                className={cn(
                                  'rounded bg-[var(--muted)] p-1 text-[var(--muted-foreground)] transition-[opacity,color] hover:text-[var(--foreground)] focus-visible:opacity-100',
                                )}
                              >
                                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                              <DropdownMenuItem onClick={() => toggleFavorite(instance.instanceId)} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
                                <StarIcon className="h-4 w-4" weight={favoriteIds.has(instance.instanceId) ? 'fill' : 'regular'} />
                                {favoriteIds.has(instance.instanceId) ? t('agent.chat.conversation.unfavorite') : t('agent.chat.conversation.favorite')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => renameConversation(instance)} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
                                <PencilSimpleIcon className="h-4 w-4" /> {t('agent.chat.conversation.rename')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void removeConversation(instance, 'archive')} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
                                <ArchiveIcon className="h-4 w-4" /> {t('document.agent.archiveConversation')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void removeConversation(instance, 'delete')} className="group h-7 items-center gap-2 rounded-lg px-2 py-0 text-[var(--destructive)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]">
                                <TrashSimpleIcon className="h-4 w-4" /> {t('document.agent.deleteConversation')}
                              </DropdownMenuItem>
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
                        </>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </OverlayScrollbar>
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-3 bg-gradient-to-b from-[color-mix(in_oklch,var(--foreground)_3%,transparent)] to-transparent transition-opacity duration-200',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && !renameSaving && setRenameTarget(null)}>
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader>
            <DialogTitle>{t('agent.chat.conversation.rename')}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
            className="space-y-4"
          >
            <Input
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              placeholder={t('agent.chat.conversation.renamePrompt')}
              disabled={renameSaving}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)} disabled={renameSaving}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={renameSaving || !renameDraft.trim()}>
                {t('document.version.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
