'use client';

import { displayTitleFromFilename } from '../../lib/utils';
import {
  BookOpen,
  Calendar,
  Check,
  FilePlus,
  FolderPlus,
  Hash,
  ListChecks,
  Settings,
  Star,
  FileText,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../../components/ui/command';
import {
  useMemoStore,
  type Notebook,
} from '../../lib/store/memo-store';
import type { MemoItem } from '../../types/memo-item';
import { useDocumentStore } from '../../lib/store/document-store';
import {
  memos,
  tags,
  windows,
  type MemoSearchHit,
} from '../../lib/tauri/client';
import { openMemoSession } from './memo-pane/open-memo-session';
import { ShortcutKbd } from '../../components/ui/shortcut-kbd';

interface GlobalSearchCommandProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoSearchHit[]>([]);
  const [indexReady, setIndexReady] = useState(true);
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
          placeholder="搜索备忘录、笔记本、操作…"
          value={query}
          onValueChange={setQuery}
          // 弹窗打开时自动 focus 到 input ── cmdk 在 cmdk-root 上监听 ArrowUp/Down,
          // 事件从 input 冒泡上来; input 没 focus 时键盘事件到不了, ↑↓ 跨组跳格失效.
          autoFocus
        />
        <CommandList>
          {showResults ? (
            <SearchResultsGroup
              hits={hits}
              indexReady={indexReady}
              memosInStore={memosInStore}
              onPick={(memo) => {
                // store 里没这条 (例如旧 notebook 残留) 就只关弹窗,
                // 不强行 setSelectedMemo(null) 把当前选中也清掉.
                if (memo) {
                  openMemoSession(memo, selectedNotebook);
                }
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

interface SearchResultsGroupProps {
  hits: MemoSearchHit[];
  indexReady: boolean;
  memosInStore: MemoItem[];
  onPick: (memo: MemoItem | null) => void;
}

function SearchResultsGroup({ hits, indexReady, memosInStore, onPick }: SearchResultsGroupProps) {
  if (hits.length === 0) {
    return (
      <CommandEmpty>
        {!indexReady ? '索引构建中…稍后再试' : '没有匹配的结果'}
      </CommandEmpty>
    );
  }
  return (
    <CommandGroup heading="搜索结果">
      {hits.map((h) => {
        // 命中行需要回 MemoItem 才能 setSelectedMemo; store 里没这条
        // (e.g. 旧 notebook 结果) 就只关弹窗, 让用户去 memo 列表正常浏览.
        const memo = memosInStore.find((m) => m.id === h.id);
        return (
          <CommandItem
            key={h.id}
            value={h.id}
            onSelect={() => onPick(memo ?? null)}
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
            <CommandShortcut>
              {h.matchedIn === 'title' ? '标题' : h.matchedIn === 'tag' ? '标签' : '正文'}
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
  const clearDocument = useDocumentStore((s) => s.clearDocument);

  // 标签不在全局 store (只在 memo-list 局部 useState), 这里按需拉一次.
  // 切 notebook 不会让旧 tag 消失 — 后端 derived_tags() 返回跨 notebook 全集.
  const [tagList, setTagList] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    tags
      .getAll()
      .then((res) => {
        if (!cancelled) setTagList(res.tags);
      })
      .catch((err) => {
        if (!cancelled) console.warn('[GlobalSearchCommand] tags.getAll failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 切 filter (置顶/本周更新/待办) — 走 store action, 后端走 IPC 重查. */
  const handleFilter = async (filter: typeof activeFilter) => {
    setActiveFilter(filter);
    const state = useMemoStore.getState();
    await loadMemos({
      notebookId: state.selectedNotebook?.id,
      filter,
    });
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

  /** 选 tag — 走 filter=tagged + tagId. 已知: memo-list 局部的 selectedTagId 不会
   *  同步, 标签 pill UI 不会高亮选中, 但实际 filter 生效, 用户在 memo-list 切
   *  一次 filter 后会自然恢复. 完整修复需要把 selectedTagId 升到 store, 留作 follow-up. */
  const handleTagSelect = async (tagId: string) => {
    setActiveFilter('tagged');
    const state = useMemoStore.getState();
    await loadMemos({
      notebookId: state.selectedNotebook?.id,
      filter: 'tagged',
      tagId,
    });
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
      {/* 导航: filter 切换 */}
      <CommandGroup heading="导航">
        <CommandItem value="filter-favorited" onSelect={() => handleFilter('favorited')}>
          <Star />
          <span>置顶</span>
          <span className="ml-auto flex items-center gap-2">
            {activeFilter === 'favorited' && <Check className="text-[var(--primary)]" />}
          </span>
        </CommandItem>
        <CommandItem value="filter-this-week" onSelect={() => handleFilter('thisWeek')}>
          <Calendar />
          <span>本周更新</span>
          <span className="ml-auto flex items-center gap-2">
            {activeFilter === 'thisWeek' && <Check className="text-[var(--primary)]" />}
          </span>
        </CommandItem>
        <CommandItem value="filter-todos" onSelect={() => handleFilter('todos')}>
          <ListChecks />
          <span>待办事项</span>
          <span className="ml-auto flex items-center gap-2">
            {activeFilter === 'todos' && <Check className="text-[var(--primary)]" />}
          </span>
        </CommandItem>
      </CommandGroup>

{/* 笔记本: 真实列表 */}
      <CommandGroup heading="笔记本">
        {notebooks.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
            暂无笔记本
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
                <BookOpen />
                <span className={`flex-1 truncate ${isCurrent ? 'font-medium text-[var(--primary)]' : ''}`}>
                  {nb.name}
                </span>
                {nb.isDefault && (
                  <span className="rounded-lg px-1.5 py-[0px] text-[10px] bg-[var(--accent)] text-[var(--primary)]">
                    默认
                  </span>
                )}
                {isCurrent && <Check className="text-[var(--primary)]" />}
              </CommandItem>
            );
          })
        )}
      </CommandGroup>

{/* 标签: 命令面板内 fetch */}
      <CommandGroup heading="标签">
        {tagList.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
            暂无标签
          </div>
        ) : (
          tagList.map((tag) => (
            <CommandItem
              key={tag.id}
              value={tag.id}
              onSelect={() => handleTagSelect(tag.id)}
            >
              <Hash />
              <span>{tag.name}</span>
            </CommandItem>
          ))
        )}
      </CommandGroup>

{/* 操作: 快捷键段交给 ShortcutKbd, actionId 直接对到 actions.ts 注册表,
       改键 / 换平台会自动跟随 (无 binding 时 ShortcutKbd 内部返回 null,
       CommandShortcut 退化为空 span — CommandItem 布局不变)。 */}
      <CommandGroup heading="操作">
        <CommandItem value="action-new-memo" onSelect={handleNewMemo} disabled={!selectedNotebook}>
          <FilePlus />
          <span>新建笔记</span>
          <CommandShortcut>
            <ShortcutKbd actionId="memo.create" className="text-[var(--muted-foreground)]" />
          </CommandShortcut>
        </CommandItem>
        <CommandItem value="action-new-notebook" onSelect={handleNewNotebook}>
          <FolderPlus />
          <span>新建笔记本</span>
          <CommandShortcut />
        </CommandItem>
        <CommandItem value="action-open-preferences" onSelect={handleOpenPreferences}>
          <Settings />
          <span>打开偏好设置</span>
          <CommandShortcut>
            <ShortcutKbd actionId="menu.open" className="text-[var(--muted-foreground)]" />
          </CommandShortcut>
        </CommandItem>
      </CommandGroup>
    </>
  );
}
