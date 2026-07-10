'use client';

import { cn, displayTitleFromFilename } from '@/lib/utils';
import {
  Check,
  FileText,
  Filter,
  Plus,
  X,
} from 'lucide-react';
import {
  CalendarCheck,
  FadersHorizontalIcon,
  HashStraightIcon,
  ListChecks,
  NotebookIcon as NotebookPhosphorIcon,
  PencilSimpleLineIcon,
  PushPin,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@shared/ui/command';
import {
  useMemoStore,
  type Notebook,
} from '@features/memo/store/memo-store';
import { useTagStore } from '@features/memo/store/tag-store';
import { NotebookIcon } from '@features/memo/components/notebook-icon';
import type { MemoItem } from '@/types/memo-item';
import { useDocumentStore } from '@features/document/store/document-store';
import { openNoteByMemoId } from '@platform/open-target';
import {
  selectRunningAgentConversationInstances,
  useAgentConversationStore,
  type AgentConversationInstance,
} from '@features/agent/store/agent-conversation-store';
import { useChatStore } from '@features/agent/store/chat-store';
import { getAgentType } from '@/lib/agent-types';
import {
  memos,
  tags,
  windows,
  type MemoSearchHit,
  type MemoTemplate,
} from '@platform/tauri/client';
import { openMemoSession } from '@features/memo/use-cases/open-memo-session';
import { ShortcutKbd } from '@shared/ui/shortcut-kbd';
import { useI18n } from '@features/i18n';

interface GlobalSearchCommandProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PropertyFilterCondition {
  id: string;
  field: string;
  operator: 'equals' | 'notEquals' | 'contains' | 'empty';
  value: string;
}

const PROPERTY_FILTER_FIELDS = [
  'status',
  'priority',
  'type',
  'owner',
  'created',
  'updated',
  'tags',
];

const PROPERTY_FILTER_OPERATOR_KEYS: Record<PropertyFilterCondition['operator'], import("@features/i18n").I18nKey> = {
  equals: "shell.commandPalette.operator.equals",
  notEquals: "shell.commandPalette.operator.notEquals",
  contains: "shell.commandPalette.operator.contains",
  empty: "shell.commandPalette.operator.empty",
};

function getPropertyFilterOperatorLabel(
  operator: PropertyFilterCondition['operator'],
  t: (key: import("@features/i18n").I18nKey) => string,
): string {
  return t(PROPERTY_FILTER_OPERATOR_KEYS[operator]);
}

/**
 * 全局搜索 / 命令面板.
 *
 * 数据流:
 * - `query` 受控, 150ms 防抖后调后端 `search_memos` 拉 `hits`
 * - 切 notebook / 关闭弹窗都清掉 query + hits, 避免旧 notebook 结果污染
 * - `shouldFilter={false}` 关掉 cmdk 内置过滤 — 后端 score 决定排序
 * - snippet 由后端用 `\x01...\x02` 包裹命中区间, 前端切片渲染为 `<mark>`
 *
 * 空 query 时的 4 个分组:
 * - 导航: 切 filter (置顶/本周更新/待办事项)
 * - 笔记本: 真实列表, 点击切 selectedNotebook + loadMemos
 * - 标签: 命令面板里 fetch tags.getAll() (store 没有), 点击 filter=tagged + tagId
 * - 操作: 新建 memo、新建笔记本、打开偏好设置
 */
export function GlobalSearchCommand({ open, onOpenChange }: GlobalSearchCommandProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoSearchHit[]>([]);
  const [indexReady, setIndexReady] = useState(true);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [propertyFilters, setPropertyFilters] = useState<PropertyFilterCondition[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  const selectedNotebook = useMemoStore((s) => s.selectedNotebook);
  const memosInStore = useMemoStore((s) => s.memos);

  // 关闭弹窗时清空 query
  useEffect(() => {
    if (!open) {
      setQuery('');
      setHits([]);
      setIndexReady(true);
      setFilterPanelOpen(false);
      setPropertyFilters([]);
    }
  }, [open]);

  // 切 notebook 时清掉旧结果
  useEffect(() => {
    setQuery('');
    setHits([]);
  }, [selectedNotebook?.id]);

  // 防抖搜索: 150ms 后拉后端
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    const q = query.trim();
    if (!q) {
      setHits([]);
      setIndexReady(true);
      return;
    }
    const myReq = ++reqIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const nbId = selectedNotebook?.id ?? null;
        const res = await memos.search(nbId, q, 30);
        // 期间用户可能又改了 query / 切了 notebook, 旧请求直接丢弃
        if (myReq !== reqIdRef.current) return;
        setHits(res.hits);
        setIndexReady(res.indexReady);
      } catch (err) {
        console.error('[GlobalSearchCommand] search failed:', err);
        if (myReq !== reqIdRef.current) return;
        setHits([]);
      }
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, selectedNotebook?.id]);

  const showResults = query.trim().length > 0;
  const activePropertyFilterCount = propertyFilters.filter((filter) => (
    filter.operator === 'empty' || filter.value.trim().length > 0
  )).length;

  const addPropertyFilter = () => {
    setPropertyFilters((current) => [
      ...current,
      {
        id: `property-filter-${Date.now()}-${current.length}`,
        field: PROPERTY_FILTER_FIELDS[0],
        operator: 'equals',
        value: '',
      },
    ]);
  };

  const updatePropertyFilter = (
    id: string,
    patch: Partial<Omit<PropertyFilterCondition, 'id'>>,
  ) => {
    setPropertyFilters((current) => current.map((filter) => (
      filter.id === id ? { ...filter, ...patch } : filter
    )));
  };

  const removePropertyFilter = (id: string) => {
    setPropertyFilters((current) => current.filter((filter) => filter.id !== id));
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} showOverlay={false}>
      <Command
        shouldFilter={false}
        // cmdk 默认 pointermove 接管选区: 鼠标移到 item 上就选中, 跟 ↑↓ / click
        // 一致. 历史上关过 (`disablePointerSelection`) 是因为视口边界 / 滚动条
        // 半可见 item 触发 onPointerMove 节奏紊乱, 偶发把 selection 跳回首条;
        // 1.1.1 的 commit 修了 race, 这里放开, 配合 Tab/Shift+Tab 等键盘走法.
        // 已知取舍: 搜索结果分组随 debounce 重建, 当前 hover 的 item 命中段被
        // 剪掉时会触发 W() 重置到首条 — 用户正在打字, 重置是预期行为, 不算 bug.
      >
        <CommandInput
          placeholder={t('shell.commandPalette.placeholder')}
          value={query}
          onValueChange={setQuery}
          // 弹窗打开时自动 focus 到 input ── cmdk 在 cmdk-root 上监听 ArrowUp/Down,
          // 事件从 input 冒泡上来; input 没 focus 时键盘事件到不了, ↑↓ 跨组跳格失效.
          autoFocus
          rightElement={(
            <button
              type="button"
              onClick={() => setFilterPanelOpen((current) => !current)}
              className={cn(
                'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors',
                'hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                filterPanelOpen && 'bg-[var(--muted)] text-[var(--foreground)]',
                activePropertyFilterCount > 0 && 'text-[var(--primary)]'
              )}
              aria-label={t('shell.commandPalette.filter')}
              aria-pressed={filterPanelOpen}
            >
              <Filter className="h-4 w-4" />
              {activePropertyFilterCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[10px] font-medium leading-none text-[var(--primary-foreground)]">
                  {activePropertyFilterCount}
                </span>
              )}
            </button>
          )}
        />
        {filterPanelOpen && (
          <div className="border-b border-[var(--border)] bg-[color-mix(in_oklch,var(--muted)_28%,transparent)] px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-[var(--foreground)]">{t('shell.commandPalette.propertyFilter.heading')}</div>
                <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                  {t('shell.commandPalette.propertyFilter.description')}
                </div>
              </div>
              <button
                type="button"
                onClick={addPropertyFilter}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] hover:bg-[var(--muted)]"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('shell.commandPalette.propertyFilter.addCondition')}
              </button>
            </div>

            {propertyFilters.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {propertyFilters.map((filter) => (
                  <div
                    key={filter.id}
                    className="grid grid-cols-[minmax(92px,1fr)_88px_minmax(96px,1.3fr)_24px] items-center gap-1.5"
                  >
                    <select
                      value={filter.field}
                      onChange={(event) => updatePropertyFilter(filter.id, { field: event.target.value })}
                      className="h-7 min-w-0 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                      aria-label={t('shell.commandPalette.propertyField')}
                    >
                      {PROPERTY_FILTER_FIELDS.map((field) => (
                        <option key={field} value={field}>{field}</option>
                      ))}
                    </select>
                    <select
                      value={filter.operator}
                      onChange={(event) => updatePropertyFilter(filter.id, {
                        operator: event.target.value as PropertyFilterCondition['operator'],
                      })}
                      className="h-7 min-w-0 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                      aria-label={t('shell.commandPalette.filterRelation')}
                    >
                      {(['equals', 'notEquals', 'contains', 'empty'] as PropertyFilterCondition['operator'][]).map((value) => (
                        <option key={value} value={value}>{getPropertyFilterOperatorLabel(value, t)}</option>
                      ))}
                    </select>
                    <input
                      value={filter.value}
                      disabled={filter.operator === 'empty'}
                      onChange={(event) => updatePropertyFilter(filter.id, { value: event.target.value })}
                      placeholder={filter.operator === 'empty' ? t('shell.commandPalette.noValueNeeded') : t('shell.commandPalette.inputValue')}
                      className="h-7 min-w-0 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={t('shell.commandPalette.filterValue')}
                    />
                    <button
                      type="button"
                      onClick={() => removePropertyFilter(filter.id)}
                      className="flex h-7 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
                      aria-label={t('shell.commandPalette.removeFilter')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <CommandList>
          <RunningAgentConversationsGroup onClose={() => onOpenChange(false)} />
          {showResults ? (
            <SearchResultsGroup
              hits={hits}
              indexReady={indexReady}
              memosInStore={memosInStore}
              onPick={(memo) => {
                openMemoSession(memo, selectedNotebook);
                onOpenChange(false);
              }}
            />
          ) : (
            <StaticGroups onClose={() => onOpenChange(false)} />
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

// ============================================================
// 搜索结果分组
// ============================================================

interface RunningAgentConversationsGroupProps {
  onClose: () => void;
}

function RunningAgentConversationsGroup({ onClose }: RunningAgentConversationsGroupProps) {
  const { t } = useI18n();
  const runningInstances = useAgentConversationStore(
    useShallow((s) => selectRunningAgentConversationInstances(s)),
  );

  if (runningInstances.length === 0) return null;

  const openRunningInstance = async (instance: AgentConversationInstance) => {
    const threadId = instance.threadId;
    if (threadId) {
      useChatStore.getState().setActiveAgentThread(instance.agentType, threadId);
    }

    const source = instance.source;
    if (source.memoId) {
      await openNoteByMemoId(source.memoId);
      onClose();
      return;
    }

    if (source.documentPath) {
      await useDocumentStore.getState().openExternalDocument(source.documentPath);
      onClose();
    }
  };

  return (
    <CommandGroup heading="Agent Conversation">
      {runningInstances.map((instance) => {
        const agent = getAgentType(instance.agentType);
        const canOpen = Boolean(instance.source.memoId || instance.source.documentPath);
        return (
          <CommandItem
            key={instance.run?.runId ?? instance.instanceId}
            value={`agent-running-${instance.run?.runId ?? instance.instanceId}`}
            disabled={!canOpen}
            onSelect={() => {
              if (canOpen) void openRunningInstance(instance);
            }}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-transparent bg-[var(--background)] p-0.5 agent-runtime-submenu__icon--running">
              <img
                src={agent.icon}
                alt=""
                className="h-full w-full object-contain"
                draggable={false}
              />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{instance.title?.trim() || t('common.untitled')}</span>
              <span className="truncate text-xs text-[var(--muted-foreground)]">
                {agent.name}
                {instance.run?.currentTool ? ` - ${instance.run.currentTool}` : ''}
              </span>
            </div>
            <CommandShortcut className="shrink-0 text-[var(--primary)]">
              {t('status.agent.running')}
            </CommandShortcut>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

interface SearchResultsGroupProps {
  hits: MemoSearchHit[];
  indexReady: boolean;
  memosInStore: MemoItem[];
  onPick: (memo: MemoItem) => void;
}

function memoFromSearchHit(hit: MemoSearchHit): MemoItem {
  return {
    id: hit.id,
    filename: hit.filename,
    preview: hit.snippet,
    tags: [],
    todos: [],
    agents: [],
    createdAt: hit.updatedAt,
    updatedAt: hit.updatedAt,
    favorited: false,
    icon: null,
    colors: [],
    properties: {},
  };
}

function SearchResultsGroup({ hits, indexReady, memosInStore, onPick }: SearchResultsGroupProps) {
  const { t } = useI18n();
  if (hits.length === 0) {
    return (
      <CommandEmpty>
        {!indexReady ? t('shell.commandPalette.empty.indexBuilding') : t('shell.commandPalette.empty.noMatches')}
      </CommandEmpty>
    );
  }
  return (
    <CommandGroup heading={t('shell.commandPalette.searchResults')}>
      {hits.map((h) => {
        // tag/filter 会让 store 里只保留当前列表子集; search hit 仍可来自
        // 当前 notebook 的其它 memo。找不到完整 MemoItem 时用 hit 合成最小
        // 可打开对象, openMemoSession 实际依赖 id + filename + notebook。
        const memo = memosInStore.find((m) => m.id === h.id) ?? memoFromSearchHit(h);
        return (
          <CommandItem
            key={h.id}
            value={h.id}
            onSelect={() => onPick(memo)}
          >
            <FileText />
            <div className="flex min-w-0 flex-col">
              <span className="truncate">{displayTitleFromFilename(h.filename)}</span>
              {h.snippet && (
                <span className="truncate text-xs text-[var(--muted-foreground)]">
                  {renderSnippet(h.snippet)}
                </span>
              )}
            </div>
            <CommandShortcut className="w-8 shrink-0 text-right">
              {h.matchedIn === 'title' ? t('shell.commandPalette.matchedIn.title') : h.matchedIn === 'tag' ? t('shell.commandPalette.matchedIn.tag') : t('shell.commandPalette.matchedIn.body')}
            </CommandShortcut>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

/**
 * 把后端 snippet (用 \x01...\x02 包裹命中) 切分成 <span>…<mark>…</mark>…</span>.
 * 控制字符 \x01 / \x02 不会出现在 memo 正文里, 是安全的边界标记.
 */
function renderSnippet(snippet: string) {
  const parts: React.ReactNode[] = [];
  const START = '\x01';
  const END = '\x02';
  let buf = '';
  let keyCounter = 0;
  for (let i = 0; i < snippet.length; i++) {
    const ch = snippet[i];
    if (ch === START) {
      if (buf) {
        parts.push(<span key={keyCounter++}>{buf}</span>);
        buf = '';
      }
    } else if (ch === END) {
      if (buf) {
        parts.push(
          <mark
            key={keyCounter++}
            className="rounded bg-yellow-300/60 px-0.5 text-inherit dark:bg-yellow-500/40"
          >
            {buf}
          </mark>,
        );
        buf = '';
      }
    } else {
      buf += ch;
    }
  }
  // 尾部: START 出现但没配对 END 时, 剩余的当普通文本
  if (buf) {
    parts.push(<span key={keyCounter++}>{buf}</span>);
  }
  return <>{parts}</>;
}

// ============================================================
// 空 query 时显示的 4 个分组 (导航 / 笔记本 / 标签 / 操作)
// ============================================================

interface StaticGroupsProps {
  /** 任一 item 处理完后由父组件调, 关掉弹窗 */
  onClose: () => void;
}

function StaticGroups({ onClose }: StaticGroupsProps) {
  const { t } = useI18n();
  // 全部状态 / 动作从全局 store 拿 — StaticGroups 自身不持数据, 关闭后下次
  // 打开会随 store 当前值自然反映最新状态.
  const notebooks = useMemoStore((s) => s.notebooks);
  const selectedNotebook = useMemoStore((s) => s.selectedNotebook);
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const setActiveFilter = useMemoStore((s) => s.setActiveFilter);
  const setSelectedNotebook = useMemoStore((s) => s.setSelectedNotebook);
  const setSelectedMemo = useMemoStore((s) => s.setSelectedMemo);
  const loadMemos = useMemoStore((s) => s.loadMemos);
  const createMemo = useMemoStore((s) => s.createMemo);
  const handleMemoCreated = useMemoStore((s) => s.handleMemoCreated);
  const setSelectedTagId = useTagStore((s) => s.setSelectedTagId);
  const clearDocument = useDocumentStore((s) => s.clearDocument);

  // 标签不在全局 store (只在 memo-list 局部 useState), 这里按需拉一次.
  // 切 notebook 不会让旧 tag 消失 — 后端 derived_tags() 返回跨 notebook 全集.
  const [tagList, setTagList] = useState<Array<{ id: string; name: string }>>([]);
  const [templateList, setTemplateList] = useState<MemoTemplate[]>([]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      tags
        .getAll(selectedNotebook?.id)
        .then((res) => {
          if (!cancelled) setTagList(res.tags);
        })
        .catch((err) => {
          if (!cancelled) console.warn('[GlobalSearchCommand] tags.getAll failed:', err);
        }),
      memos
        .listTemplates()
        .then((templates) => {
          if (!cancelled) setTemplateList(templates);
        })
        .catch((err) => {
          if (!cancelled) console.warn('[GlobalSearchCommand] listTemplates failed:', err);
        }),
    ]);
    return () => {
      cancelled = true;
    };
  }, [selectedNotebook?.id]);

  /** 切 filter (置顶/本周更新/待办) — 走 store action, 后端走 IPC 重查. */
  const handleFilter = async (filter: typeof activeFilter) => {
    if (filter !== 'tagged') {
      setSelectedTagId(null);
    }
    setActiveFilter(filter);
    onClose();
  };

  /** 切 notebook — 触发 search_memos 索引 rebuild (走 switch_notebook_and_rebuild). */
  const handleNotebookSelect = async (notebook: Notebook) => {
    if (notebook.id === selectedNotebook?.id) {
      onClose();
      return;
    }
    setSelectedNotebook(notebook);
    setSelectedMemo(null);
    clearDocument();
    const state = useMemoStore.getState();
    await loadMemos({
      notebookId: notebook.id,
      filter: state.activeFilter,
    });
    onClose();
  };

  /** Select a tag through the shared tag store, then load the tagged memo subset. */
  const handleTagSelect = async (tagId: string) => {
    setSelectedTagId(tagId);
    setActiveFilter('tagged');
    onClose();
  };

  /** 新建 memo — store createMemo 已把新 memo 加到 memos[], 这里再选上,
   *  这里需要显式打开文档会话，避免依赖列表选中态副作用。 */
  const handleNewMemo = async () => {
    const state = useMemoStore.getState();
    if (!state.selectedNotebook) return;
    try {
      const memo = await createMemo(undefined, state.selectedNotebook.id);
      openMemoSession({ ...memo, isOpen: true }, state.selectedNotebook);
    } catch (err) {
      console.error('[GlobalSearchCommand] createMemo failed:', err);
    }
    onClose();
  };

  /** 新建笔记本 — memo-list 监听了 flowix:open-create-notebook 事件, 会打开
   *  现有 Dialog 走选路径 + 命名流程. 直接 dispatch 复用. */
  const handleCreateFromTemplate = async (template: MemoTemplate) => {
    const state = useMemoStore.getState();
    if (!state.selectedNotebook) return;
    try {
      const memo = await memos.createFromTemplate(template.id, state.selectedNotebook.id);
      handleMemoCreated(memo, { select: true });
      openMemoSession({ ...memo, isOpen: true }, state.selectedNotebook);
    } catch (err) {
      console.error('[GlobalSearchCommand] createFromTemplate failed:', err);
    }
    onClose();
  };

  const handleNewNotebook = () => {
    window.dispatchEvent(new CustomEvent('flowix:open-create-notebook'));
    onClose();
  };

  const handleOpenPreferences = async () => {
    try {
      await windows.openPreferences();
    } catch (err) {
      console.error('[GlobalSearchCommand] openPreferences failed:', err);
    }
    onClose();
  };

  return (
    <>
{/* 标签: 命令面板内 fetch */}
      <CommandGroup heading={t('shell.commandPalette.tagsGroup')}>
        {tagList.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
            {t('shell.commandPalette.emptyTags')}
          </div>
        ) : (
          tagList.map((tag) => (
            <CommandItem
              key={tag.id}
              value={tag.id}
              onSelect={() => handleTagSelect(tag.id)}
            >
              <HashStraightIcon />
              <span>{tag.name}</span>
            </CommandItem>
          ))
        )}
      </CommandGroup>

      {/* 筛选: filter 切换 */}
      <CommandGroup heading={t('shell.commandPalette.filterGroup')}>
        <CommandItem value="filter-favorited" onSelect={() => handleFilter('favorited')}>
          <PushPin />
          <span>{t('shell.commandPalette.filter.favorited')}</span>
          <span className="ml-auto flex items-center gap-2">
            {activeFilter === 'favorited' && <Check className="text-[var(--primary)]" />}
          </span>
        </CommandItem>
        <CommandItem value="filter-this-week" onSelect={() => handleFilter('thisWeek')}>
          <CalendarCheck />
          <span>{t('shell.commandPalette.filter.thisWeek')}</span>
          <span className="ml-auto flex items-center gap-2">
            {activeFilter === 'thisWeek' && <Check className="text-[var(--primary)]" />}
          </span>
        </CommandItem>
        <CommandItem value="filter-todos" onSelect={() => handleFilter('todos')}>
          <ListChecks />
          <span>{t('shell.commandPalette.filter.todos')}</span>
          <span className="ml-auto flex items-center gap-2">
            {activeFilter === 'todos' && <Check className="text-[var(--primary)]" />}
          </span>
        </CommandItem>
      </CommandGroup>

{/* 笔记本: 真实列表 */}
      <CommandGroup heading={t('shell.commandPalette.notebooksGroup')}>
        {notebooks.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
            {t('shell.commandPalette.emptyNotebooks')}
          </div>
        ) : (
          notebooks.map((nb) => {
            const isCurrent = nb.id === selectedNotebook?.id;
            return (
              <CommandItem
                key={nb.id}
                value={nb.id}
                onSelect={() => handleNotebookSelect(nb)}
              >
                <NotebookIcon
                  icon={nb.icon}
                  name={nb.name}
                  className="h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
                />
                <span className="flex-1 truncate">
                  {nb.name}
                </span>
                {isCurrent && (
                  <span className="rounded-lg px-1.5 py-[0px] text-[10px] bg-[var(--accent)] text-[var(--primary)]">
                    {t('shell.commandPalette.notebook.current')}
                  </span>
                )}
              </CommandItem>
            );
          })
        )}
      </CommandGroup>

{/* 操作: 快捷键段交给 ShortcutKbd, actionId 直接对到 actions.ts 注册表,
       改键 / 换平台会自动跟随 (无 binding 时 ShortcutKbd 内部返回 null,
      CommandShortcut 退化为空 span — CommandItem 布局不变)。 */}
      <CommandGroup heading={t('shell.commandPalette.actionsGroup')}>
        <CommandItem value="action-new-memo" onSelect={handleNewMemo} disabled={!selectedNotebook}>
          <PencilSimpleLineIcon />
          <span>{t('shell.commandPalette.action.newMemo')}</span>
          <CommandShortcut>
            <ShortcutKbd actionId="memo.create" className="text-[var(--muted-foreground)]" />
          </CommandShortcut>
        </CommandItem>
        {templateList.map((template) => (
          <CommandItem
            key={template.id}
            value={`action-template-${template.id}`}
            onSelect={() => handleCreateFromTemplate(template)}
            disabled={!selectedNotebook}
          >
            <PencilSimpleLineIcon />
            <span className="truncate">{t('shell.commandPalette.templatePrefix')}{template.name}</span>
          </CommandItem>
        ))}
        <CommandItem value="action-new-notebook" onSelect={handleNewNotebook}>
          <NotebookPhosphorIcon />
          <span>{t('shell.commandPalette.action.newNotebook')}</span>
          <CommandShortcut>
            <ShortcutKbd actionId="notebook.create" className="text-[var(--muted-foreground)]" />
          </CommandShortcut>
        </CommandItem>
        <CommandItem value="action-open-preferences" onSelect={handleOpenPreferences}>
          <FadersHorizontalIcon />
          <span>{t('shell.commandPalette.action.openPreferences')}</span>
          <CommandShortcut>
            <ShortcutKbd actionId="menu.open" className="text-[var(--muted-foreground)]" />
          </CommandShortcut>
        </CommandItem>
      </CommandGroup>
    </>
  );
}
