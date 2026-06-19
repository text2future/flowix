'use client';

import { displayTitleFromFilename } from '../../../lib/utils';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useShortcutScope, pushHandler } from '../../../lib/shortcuts';
import { SquarePen, Search, ChevronDown, Check, Loader2, Hash, ChevronRight } from 'lucide-react';
import {
  useMemoStore,
  useDocumentStore,
  type MemoItem,
} from '../../../lib/store';
import type { Notebook } from '../../../lib/store';
import { useTauriRpc } from '../../../lib/hooks/useTauriRpc';
import { useMemoInsertAnimation } from '../../../lib/hooks/useMemoInsertAnimation';
import { toast } from '../../../lib/toast';
import { cn } from '../../../lib/utils';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { MemoCard } from './memo-card1';
import { MemoCardTodo, type MemoTodoListEntry } from './memo-card-todo';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '../../../components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../../components/ui/dialog';
import { Kbd } from '../../../components/ui/kbd';
import { Popover, PopoverTrigger } from '../../../components/ui/popover';
import { LazyGlobalSearchCommand } from './lazy-global-search-command';
import { openMemoSession } from './open-memo-session';
import { TagOverflowPopoverContent } from './tag-overflow-popover-content';
import { memoRepository, notebookRepository } from '../../../lib/services/memo-repository';
import {
  loadMemoLibraryMetadata,
  loadTodoMetadata,
  persistHiddenTags,
  persistTagOrder,
} from '../../../lib/services/memo-list-metadata-service';

const LazyNotebookDialogs = lazy(() =>
  import('./notebook-dialogs').then((module) => ({
    default: module.NotebookDialogs,
  })),
);

const HEADER_ICON_BTN_CLASS =
  'h-8 w-8 justify-center rounded-full p-0 border border-[var(--border)] ' +
  'hover:bg-[var(--muted)] hover:text-[var(--primary)] text-[var(--foreground)]';

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function BlockingLoadingOverlay({ text }: { text: string }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_82%,transparent)] backdrop-blur-[1px]">
      <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] shadow-lg">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" />
        <span>{text}</span>
      </div>
    </div>
  );
}

/**
 * 删除确认弹窗的快捷键桥接。
 *
 * - 仅在 deleteMemo 非空时挂载 — useShortcutScope('dialog') 随之 push,
 *   pushHandler 注册的 cancel / confirm 也在栈顶, 弹窗关闭时整个子组件
 *   卸载, scope 与 handler 自动 pop, 不影响后续弹窗。
 * - 渲染 null — 这是一个逻辑组件, 没有任何 UI。
 */
function DeleteDialogShortcuts({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useShortcutScope('dialog');
  useEffect(() => {
    const popCancel = pushHandler('dialog.cancel', onCancel);
    const popConfirm = pushHandler('dialog.confirm', () => {
      // 防御: 焦点在可编辑元素时, 不应替用户做"确认"决定 (原 memo-list.tsx:251
      // 的 defensive 逻辑)。返回 false 让 Provider 跳过 preventDefault, 用户
      // 的 Enter 会落到浏览器默认 (textarea 换行 / input 提交)。
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return false;
      }
      onConfirm();
    });
    return () => {
      popCancel();
      popConfirm();
    };
  }, [onCancel, onConfirm]);
  return null;
}

function getTodoSelectionKey(todo: MemoTodoListEntry, index: number): string {
  return [
    todo.memoId,
    todo.createdAt ?? '',
    todo.updatedAt ?? '',
    todo.content,
    index,
  ].join(':');
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--muted-foreground)]">
      <span className="text-sm">未找到笔记</span>
    </div>
  );
}

export function MemoList() {
  const { request } = useTauriRpc();
  const { registerCard, prepareForInsert, onListRendered } =
    useMemoInsertAnimation();
  // 滚动容器 ── 普通文档流, 内部 flex-col 让 row 高度由内容撑开。
  // 之前由 useMemoInsertAnimation 提供, 现在它的 hook 不再需要这个 ref,
  // 由 consumer 自己管。
  const listContainerRef = useRef<HTMLDivElement>(null);
  // 切片订阅: 替代原来的 `useMemoStore()` 全量订阅。每个 useStore 只取用到的字段,
  // 切到 selector 后, 列表里 5k 笔记的任何 set 都不会让本组件不必要地重渲 ──
  // memos 是大头, 但要 memoize (Array equality) 才能跳过 5k 项深比; 不然
  // store 里 setNotebooks 之类也会触发 memos selector 重跑。Zustand v5 默认
  // 用 Object.is 比对, 同一个 memos 引用相等就跳过, 不需要 useMemo。
  const memos = useMemoStore((s) => s.memos);
  const selectedMemo = useMemoStore((s) => s.selectedMemo);
  const selectedNotebook = useMemoStore((s) => s.selectedNotebook);
  const refreshTrigger = useMemoStore((s) => s.refreshTrigger);
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const activeSort = useMemoStore((s) => s.activeSort);
  const {
    setSelectedMemo,
    setSelectedNotebook,
    triggerRefresh,
    setNotebooks,
    setActiveFilter,
    setActiveSort,
    loadMemos,
    handleMemoCreated,
  } = useMemoStore(
    useShallow((s) => ({
      setSelectedMemo: s.setSelectedMemo,
      setSelectedNotebook: s.setSelectedNotebook,
      triggerRefresh: s.triggerRefresh,
      setNotebooks: s.setNotebooks,
      setActiveFilter: s.setActiveFilter,
      setActiveSort: s.setActiveSort,
      loadMemos: s.loadMemos,
      handleMemoCreated: s.handleMemoCreated,
    })),
  );
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [deleteMemo, setDeleteMemo] = useState<MemoItem | null>(null);
  const [createNotebookOpen, setCreateNotebookOpen] = useState(false);
  const [notebookDropdownOpen, setNotebookDropdownOpen] = useState(false);
  const [searchCommandOpen, setSearchCommandOpen] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState('');
  const [newNotebookPath, setNewNotebookPath] = useState('');
  const [editNotebookOpen, setEditNotebookOpen] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null>(null);
  const [editNotebookName, setEditNotebookName] = useState('');
  const [tagMap, setTagMap] = useState<Record<string, string>>({});
  const [tagOptions, setTagOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [todoEntries, setTodoEntries] = useState<MemoTodoListEntry[]>([]);
  const [selectedTodoKey, setSelectedTodoKey] = useState<string | null>(null);
  const [tagOrder, setTagOrder] = useState<string[]>([]);
  const [hiddenTagIds, setHiddenTagIds] = useState<string[]>([]);
  const [draggingTagId, setDraggingTagId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const [libraryBlockingLoadingText, setLibraryBlockingLoadingText] = useState<string | null>(null);
  const [todoBlockingLoadingText, setTodoBlockingLoadingText] = useState<string | null>(null);
  const blockingLoadingText = libraryBlockingLoadingText ?? todoBlockingLoadingText;
  const [dragGhost, setDragGhost] = useState<{
    id: string;
    rect: DOMRect;
    currentY: number;
    offsetY: number;
  } | null>(null);
  const libraryParseTaskSeqRef = useRef(0);
  const todoParseTaskSeqRef = useRef(0);
  const dragPointerRef = useRef<{
    sourceId: string;
    pointerId: number;
    startY: number;
    startX: number;
    offsetY: number;
    rect: DOMRect | null;
    isDragging: boolean;
  } | null>(null);
  const popoverRowRefs = useRef(new Map<string, HTMLDivElement>());
  const tagScrollRef = useRef<HTMLDivElement>(null);
  const tagButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeDocumentMemoId = useDocumentStore((store) => store.activeMemoSession?.memoId ?? null);
  const currentDocumentSource = useDocumentStore((store) => store.currentDocumentSource);

  useEffect(() => {
    const { currentDocumentSource, clearDocument } = useDocumentStore.getState();
    if (!selectedMemo && currentDocumentSource !== 'external') {
      clearDocument();
    }
  }, [selectedMemo]);

  // 挂载期同步: selectedMemo 由 zustand/persist 从 localStorage 恢复,
  // activeMemoSession 没被持久化、重启后永远是 null, 列表选中态与文档区会脱钩。
  // 主动开一次 session, 解决"列表有选中但文档区空"。
  useEffect(() => {
    if (!selectedMemo) return;
    if (currentDocumentSource === 'external') return;
    if (activeDocumentMemoId === selectedMemo.id) return;
    openMemoSession(selectedMemo, useMemoStore.getState().selectedNotebook);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for cross-component triggers (e.g. status bar "New Notebook" button)
  // to open the create-notebook dialog.
  useEffect(() => {
    const handleOpen = () => {
      setNewNotebookName('');
      setNewNotebookPath('');
      setCreateNotebookOpen(true);
    };
    window.addEventListener('flowix:open-create-notebook', handleOpen);
    return () => window.removeEventListener('flowix:open-create-notebook', handleOpen);
  }, []);

  // Listen for cross-component triggers to open the edit-notebook dialog
  // (carries the target notebook in event.detail).
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const ce = event as CustomEvent<Notebook>;
      const notebook = ce.detail;
      if (!notebook) return;
      setEditingNotebook(notebook);
      setEditNotebookName(notebook.name);
      setEditNotebookOpen(true);
    };
    window.addEventListener('flowix:open-edit-notebook', handleOpen as EventListener);
    return () => window.removeEventListener('flowix:open-edit-notebook', handleOpen as EventListener);
  }, []);

  // Listen for cross-component triggers to open the delete-memo confirmation
  // dialog (e.g. from the document titlebar's "more" menu). Carries the
  // target memo in event.detail.
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const ce = event as CustomEvent<MemoItem>;
      const memo = ce.detail;
      if (!memo) return;
      setDeleteMemo(memo);
    };
    window.addEventListener('flowix:request-delete-memo', handleOpen as EventListener);
    return () => window.removeEventListener('flowix:request-delete-memo', handleOpen as EventListener);
  }, []);

  // 监听全局搜索/命令面板的打开请求 (来自 lib/shortcuts/actions.ts 的
  // paletteSearchAction 二次触发即关闭。状态仍留在 memo-list 内部, 不 lift
  // 到 MainLayout — 跟 flowix:open-create-notebook / flowix:request-delete-memo
  // 同模式, 跨组件解耦。
  useEffect(() => {
    const handleToggle = () => setSearchCommandOpen(prev => !prev);
    window.addEventListener('flowix:toggle-palette', handleToggle);
    return () => window.removeEventListener('flowix:toggle-palette', handleToggle);
  }, []);

  // Shared delete path for both the dialog button and Enter shortcut.
  const handleDeleteConfirm = useCallback(() => {
    if (!deleteMemo) return;
    const memo = deleteMemo;
    setDeleteMemo(null);
    void memoRepository.delete(memo.id).then(() => {
      if (selectedMemo?.id === memo.id) {
        setSelectedMemo(null);
        useDocumentStore.getState().clearDocument();
      }
      triggerRefresh();
    });
  }, [deleteMemo, selectedMemo, setSelectedMemo, triggerRefresh]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteMemo(null);
  }, []);

  const loadData = useCallback(async () => {
    const parseTaskSeq = ++libraryParseTaskSeqRef.current;
    const state = useMemoStore.getState();
    let currentNotebook = state.selectedNotebook;

    try {
      const notebooksResult = await notebookRepository.list();
      if (!notebooksResult || notebooksResult.length === 0) {
        return;
      }
      setNotebooks(notebooksResult);

      if (currentNotebook) {
        const currentId = currentNotebook.id;
        const exists = notebooksResult.some((n: Notebook) => n.id === currentId);
        if (exists) {
          currentNotebook = notebooksResult.find((n: Notebook) => n.id === currentId) || null;
        } else {
          // Persisted notebook no longer exists, find default
          const defaultNb = notebooksResult.find((n: Notebook) => n.isDefault) || notebooksResult[0];
          setSelectedNotebook(defaultNb);
          currentNotebook = defaultNb;
        }
      } else {
        // No persisted notebook, find default
        const defaultNb = notebooksResult.find((n: Notebook) => n.isDefault) || notebooksResult[0];
        setSelectedNotebook(defaultNb);
        currentNotebook = defaultNb;
      }

      if (!currentNotebook) {
        return;
      }

      // 闭包 (`then`) 内访问 `currentNotebook.path` 会丢失 TS narrowing ──
      // 把 path 提前捕获到本地 const, 闭包内只读 const, 类型收窄到 string。
      const libraryMetadata = await loadMemoLibraryMetadata({
        notebook: currentNotebook,
        selectedTagId,
        beforeLargeParse: async () => {
          setLibraryBlockingLoadingText('正在解析文档库');
          await waitForNextPaint();
          return parseTaskSeq === libraryParseTaskSeqRef.current;
        },
      });
      if (!libraryMetadata) return;

      setTagMap(libraryMetadata.tagMap);
      setTagOrder(libraryMetadata.tagOrder);
      setTagOptions(libraryMetadata.tagOptions);
      setHiddenTagIds(libraryMetadata.hiddenTagIds);

      const nextSelectedTagId = libraryMetadata.selectedTagId;
      if (selectedTagId !== nextSelectedTagId) {
        setSelectedTagId(nextSelectedTagId);
      }

      // Load memos via store (which uses IPC with backend filtering)
      await loadMemos({
        notebookId: currentNotebook.id,
        filter: activeFilter,
        sort: activeSort,
        tagId: activeFilter === 'tagged' ? nextSelectedTagId ?? undefined : undefined,
      });

      if (!useMemoStore.getState().selectedMemo && useDocumentStore.getState().currentDocumentSource !== 'external') {
        useDocumentStore.getState().clearDocument();
      }
    } finally {
      if (parseTaskSeq === libraryParseTaskSeqRef.current) {
        setLibraryBlockingLoadingText(null);
      }
    }

  }, [setNotebooks, setSelectedNotebook, loadMemos, activeFilter, activeSort, selectedTagId]);

  useEffect(() => {
    void loadData().catch((error) => {
      console.warn('[MemoList] Failed to load memo list data:', error);
      toast.error('加载笔记列表失败');
    });
  }, [loadData, refreshTrigger]);

  useEffect(() => {
    let cancelled = false;
    const parseTaskSeq = ++todoParseTaskSeqRef.current;

    async function loadTodoEntries() {
      if (activeFilter !== 'todos' || !selectedNotebook?.path) {
        setTodoEntries([]);
        if (parseTaskSeq === todoParseTaskSeqRef.current) {
          setTodoBlockingLoadingText(null);
        }
        return;
      }

      try {
        const sortedTodos = await loadTodoMetadata({
          notebookPath: selectedNotebook.path,
          sort: activeSort,
          beforeLargeParse: async () => {
            setTodoBlockingLoadingText('正在解析待办');
            await waitForNextPaint();
            return !cancelled && parseTaskSeq === todoParseTaskSeqRef.current;
          },
        });
        if (cancelled || !sortedTodos) return;
        setTodoEntries(sortedTodos);
      } catch (error) {
        if (!cancelled) {
          console.warn('[MemoList] Failed to read memo metadata todos:', error);
          setTodoEntries([]);
        }
      } finally {
        if (!cancelled && parseTaskSeq === todoParseTaskSeqRef.current) {
          setTodoBlockingLoadingText(null);
        }
      }
    }

    loadTodoEntries();

    return () => {
      cancelled = true;
    };
  }, [activeFilter, activeSort, refreshTrigger, selectedNotebook?.path, memos.length]);

  const isTodosView = activeFilter === 'todos';
  // 不再使用虚拟列表 ── @tanstack/react-virtual 在行高变化 + 入场动画叠加的
  // 场景下频繁出现 row 之间错位/重叠 (estimateSize 与 measureElement 实测
  // 高度在动画期间/重渲期间的瞬时不一致, 加上 GSAP 与 translateY(start)
  // 互相踩 transform 的历史遗留问题)。改为普通 flex 列渲染, 5k+ 笔记的
  // 性能可在后续用 windowing / start 切片再优化, 但正确性优先。
  // 列表自然高度由内容撑开, listContainer 自身的 overflow-y-auto 仍负责滚动。

  // ─── row ref 缓存 ──────────────────────────────────────────────
  // 同一 memo.id 跨 render 拿到**稳定**的 ref 回调, 避免 React 在重渲时
  // 反复调 null/node (虽然没了 virtualizer, 但 useMemoInsertAnimation 仍
  // 通过 cardRefs 拿节点做入场动画, 稳定 ref 让它能稳定命中)。
  const rowRefCacheRef = useRef<
    Map<string, (el: HTMLDivElement | null) => void>
  >(new Map());
  const registerCardRef = useRef(registerCard);
  registerCardRef.current = registerCard;
  const getMemoRowRef = (id: string) => {
    const cached = rowRefCacheRef.current.get(id);
    if (cached) return cached;
    const cb = (el: HTMLDivElement | null) => {
      registerCardRef.current(id)(el);
      if (!el) rowRefCacheRef.current.delete(id);
    };
    rowRefCacheRef.current.set(id, cb);
    return cb;
  };
  const memoById = useMemo(
    () => new Map(memos.map((memo) => [memo.id, memo])),
    [memos]
  );
  const displayTodoEntries = useMemo(
    () => isTodosView
      ? todoEntries.filter((todo) => memoById.has(todo.memoId))
      : [],
    [isTodosView, memoById, todoEntries]
  );
  const hiddenTagIdSet = useMemo(() => new Set(hiddenTagIds), [hiddenTagIds]);
  const visibleTagOptions = useMemo(
    () => tagOptions.filter((t) => !hiddenTagIdSet.has(t.id)),
    [tagOptions, hiddenTagIdSet]
  );

  useEffect(() => {
    if (activeFilter !== 'tagged') {
      setTagPopoverOpen(false);
    }
  }, [activeFilter]);

  useEffect(() => {
    if (!selectedTagId || activeFilter !== 'tagged') return;

    const container = tagScrollRef.current;
    const selectedButton = tagButtonRefs.current.get(selectedTagId);
    if (!container || !selectedButton) return;

    const containerRect = container.getBoundingClientRect();
    const buttonRect = selectedButton.getBoundingClientRect();
    const isFullyVisible = buttonRect.left >= containerRect.left && buttonRect.right <= containerRect.right;
    if (isFullyVisible) return;

    const nextLeft = container.scrollLeft
      + buttonRect.left
      - containerRect.left
      - (containerRect.width - buttonRect.width) / 2;

    container.scrollTo({
      left: Math.max(0, nextLeft),
      behavior: 'smooth',
    });
  }, [activeFilter, selectedTagId, tagOptions]);

  const handleSelectMemo = useCallback((memo: MemoItem) => {
    setSelectedTodoKey(null);
    openMemoSession(memo, useMemoStore.getState().selectedNotebook);
  }, []);

  const handleSelectTodo = useCallback((memo: MemoItem, todoKey: string) => {
    setSelectedTodoKey(todoKey);
    openMemoSession(memo, useMemoStore.getState().selectedNotebook);
  }, []);

  const handleFavoriteToggle = useCallback(async (memo: MemoItem) => {
    await (memo.favorited
      ? memoRepository.unfavorite(memo.id)
      : memoRepository.favorite(memo.id));
    triggerRefresh();
  }, [triggerRefresh]);

  const handleFilterChange = async (filter: typeof activeFilter) => {
    if (filter !== 'todos') {
      setSelectedTodoKey(null);
    }
    const nextTagId = filter === 'tagged' ? selectedTagId : null;
    if (filter !== 'tagged') {
      setSelectedTagId(null);
    }
    setActiveFilter(filter);
    const state = useMemoStore.getState();
    await loadMemos({
      notebookId: state.selectedNotebook?.id,
      filter,
      sort: state.activeSort,
      tagId: nextTagId ?? undefined,
    });
  };

  const handleSortChange = async (sort: typeof activeSort) => {
    setActiveSort(sort);
    const state = useMemoStore.getState();
    await loadMemos({
      notebookId: state.selectedNotebook?.id,
      filter: state.activeFilter,
      sort,
      tagId: state.activeFilter === 'tagged' ? selectedTagId ?? undefined : undefined,
    });
  };

  const handleTagSelect = async (tagId: string) => {
    const nextTagId = selectedTagId === tagId ? null : tagId;
    const nextFilter = nextTagId ? 'tagged' : 'all';
    setSelectedTagId(nextTagId);
    setSelectedTodoKey(null);
    setTagPopoverOpen(false);
    setActiveFilter(nextFilter);
    const state = useMemoStore.getState();
    await loadMemos({
      notebookId: state.selectedNotebook?.id,
      filter: nextFilter,
      sort: state.activeSort,
      tagId: nextFilter === 'tagged' ? nextTagId ?? undefined : undefined,
    });
  };

  const applyTagReorder = useCallback(
    (sourceId: string, targetId: string, position: 'before' | 'after') => {
      if (sourceId === targetId) return;
      const current = tagOrder.length > 0 ? tagOrder : tagOptions.map((t) => t.id);
      const fromIndex = current.indexOf(sourceId);
      const toIndex = current.indexOf(targetId);
      if (fromIndex < 0 || toIndex < 0) return;

      const next = current.slice();
      next.splice(fromIndex, 1);
      const insertIndex = position === 'before' ? next.indexOf(targetId) : next.indexOf(targetId) + 1;
      next.splice(insertIndex, 0, sourceId);

      setTagOrder(next);
      const byId = new Map(tagOptions.map((t) => [t.id, t]));
      setTagOptions(
        next
          .map((id) => byId.get(id))
          .filter((t): t is { id: string; name: string } => Boolean(t))
      );
      const notebookId = useMemoStore.getState().selectedNotebook?.id;
      void persistTagOrder(next, notebookId).catch((error) => {
        console.warn('[MemoList] Failed to persist tag order:', error);
      });
    },
    [tagOptions, tagOrder]
  );

  const handleToggleTagHidden = useCallback(
    (tagId: string) => {
      const notebookId = useMemoStore.getState().selectedNotebook?.id;
      const nextHidden = hiddenTagIds.includes(tagId)
        ? hiddenTagIds.filter((id) => id !== tagId)
        : [...hiddenTagIds, tagId];
      setHiddenTagIds(nextHidden);
      void persistHiddenTags(nextHidden, notebookId).catch((error) => {
        console.warn('[MemoList] Failed to persist hidden tags:', error);
      });
    },
    [hiddenTagIds]
  );

  const handlePinTagToTop = useCallback(
    (tagId: string) => {
      const current = tagOrder.length > 0 ? tagOrder : tagOptions.map((t) => t.id);
      const firstOther = current.find((id) => id !== tagId);
      if (!firstOther) return;
      applyTagReorder(tagId, firstOther, 'before');
    },
    [applyTagReorder, tagOptions, tagOrder]
  );

  const findPopoverDropTarget = useCallback(
    (y: number, sourceId: string): { id: string; position: 'before' | 'after' } | null => {
      for (const tag of tagOptions) {
        if (tag.id === sourceId) continue;
        const row = popoverRowRefs.current.get(tag.id);
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const position: 'before' | 'after' = y < rect.top + rect.height / 2 ? 'before' : 'after';
          return { id: tag.id, position };
        }
      }
      return null;
    },
    [tagOptions]
  );

  const handlePopoverRowPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, tagId: string) => {
      if (e.button !== 0) return;
      // Prevent text selection while interacting with the row.
      e.preventDefault();
      const row = e.currentTarget;
      try {
        row.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      const rect = row.getBoundingClientRect();
      dragPointerRef.current = {
        sourceId: tagId,
        pointerId: e.pointerId,
        startY: e.clientY,
        startX: e.clientX,
        offsetY: e.clientY - rect.top,
        rect,
        isDragging: false,
      };
    },
    []
  );

  useEffect(() => {
    const DRAG_THRESHOLD = 4;

    const handleMove = (e: PointerEvent) => {
      const state = dragPointerRef.current;
      if (!state || state.pointerId !== e.pointerId) return;

      if (!state.isDragging) {
        const dy = Math.abs(e.clientY - state.startY);
        const dx = Math.abs(e.clientX - state.startX);
        if (dy < DRAG_THRESHOLD && dx < DRAG_THRESHOLD) return;
        state.isDragging = true;
        setDraggingTagId(state.sourceId);
        if (state.rect) {
          setDragGhost({
            id: state.sourceId,
            rect: state.rect,
            currentY: e.clientY,
            offsetY: state.offsetY,
          });
        }
      } else {
        setDragGhost((prev) => (prev ? { ...prev, currentY: e.clientY } : null));
      }

      setDropTarget(findPopoverDropTarget(e.clientY, state.sourceId));
    };

    const handleUp = (e: PointerEvent) => {
      const state = dragPointerRef.current;
      if (!state || state.pointerId !== e.pointerId) return;

      if (state.isDragging) {
        const target = findPopoverDropTarget(e.clientY, state.sourceId);
        if (target) {
          applyTagReorder(state.sourceId, target.id, target.position);
        }
      } else {
        // Treat as a click: select the tag.
        handleTagSelect(state.sourceId);
      }

      dragPointerRef.current = null;
      setDraggingTagId(null);
      setDragGhost(null);
      setDropTarget(null);
    };

    const handleCancel = (e: PointerEvent) => handleUp(e);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
  }, [applyTagReorder, findPopoverDropTarget, handleTagSelect]);

  const handleCreateMemo = useCallback(async () => {
    if (!selectedNotebook) return;
    const previousSelectedMemo = useMemoStore.getState().selectedMemo;
    setSelectedTodoKey(null);
    setSelectedMemo(null);

    let result: any;
    try {
      result = await memoRepository.create(undefined, selectedNotebook.id);
    } catch (error) {
      setSelectedMemo(previousSelectedMemo);
      throw error;
    }

    if (!result) {
      setSelectedMemo(previousSelectedMemo);
      return;
    }

    const newMemo = result as MemoItem;
    const shouldSelectNewMemo =
      activeFilter === 'all' ||
      activeFilter === 'thisWeek' ||
      activeFilter === 'thisMonth';

    // Synchronously capture pre-render positions BEFORE the store update that
    // adds the new memo. The animation itself runs in the useLayoutEffect below,
    // after React commits the new list but before the browser paints it.
    // 现在没有虚拟列表, 新 memo 永远渲染在列表最前 ── 入场动画交给
    // useMemoInsertAnimation.onListRendered 在 layout 阶段跑一次。
    prepareForInsert(newMemo.id);
    handleMemoCreated(newMemo, { select: shouldSelectNewMemo });

    if (shouldSelectNewMemo) {
      openMemoSession({ ...newMemo, isOpen: true }, selectedNotebook);
    }
  }, [
    activeFilter,
    handleMemoCreated,
    prepareForInsert,
    selectedNotebook,
    setSelectedMemo,
  ]);

  useEffect(() => {
    const handleRequest = () => {
      void handleCreateMemo();
    };
    window.addEventListener('flowix:create-memo', handleRequest);
    return () => window.removeEventListener('flowix:create-memo', handleRequest);
  }, [handleCreateMemo]);

  // 入场动画入口: 每次 memos 变化时 (含新建/更新/删除) 在 layout 阶段同步
  // 询问 useMemoInsertAnimation 是否有 pending 新 card, 有就跑一次入场
  // 动画; 无就是 no-op。 在 paint 之前跑, 避免首帧闪烁。
  useLayoutEffect(() => {
    onListRendered();
  }, [memos, onListRendered]);

  const handleConfirmCreateNotebook = async () => {
    if (!newNotebookName.trim() || !newNotebookPath.trim()) return;
    const notebookName = newNotebookName.trim();
    const notebookPath = newNotebookPath.trim();

    setCreateNotebookOpen(false);
    setLibraryBlockingLoadingText('正在扫描文档库');
    await waitForNextPaint();

    try {
      const created = await notebookRepository.create(
        notebookName,
        notebookPath,
        '📓'
      ) as Notebook | null;

      if (!created) {
        toast.error('创建失败');
        return;
      }

      const notebooksResult = await notebookRepository.list();
      const nextNotebooks = notebooksResult?.length ? notebooksResult as Notebook[] : [created];
      const nextNotebook = nextNotebooks.find((notebook) => notebook.id === created.id) ?? created;

      setNotebooks(nextNotebooks);
      setSelectedNotebook(nextNotebook);
      setSelectedMemo(null);
      useDocumentStore.getState().clearDocument();
      setSelectedTagId(null);
      setTagOrder([]);
      setTagOptions([]);
      setHiddenTagIds([]);
      setTodoEntries([]);

      await loadMemos({
        notebookId: nextNotebook.id,
        filter: activeFilter,
        sort: activeSort,
      });

      setNewNotebookName('');
      setNewNotebookPath('');
      triggerRefresh();
    } catch (error) {
      console.warn('[MemoList] Failed to create notebook:', error);
      toast.error('创建失败');
    } finally {
      setLibraryBlockingLoadingText(null);
    }
  };

  const handleConfirmEditNotebook = async () => {
    if (!editingNotebook) return;
    const trimmed = editNotebookName.trim();
    if (!trimmed || trimmed === editingNotebook.name) {
      setEditNotebookOpen(false);
      setEditingNotebook(null);
      setEditNotebookName('');
      return;
    }
    try {
      const updated = await notebookRepository.update(editingNotebook.id, trimmed);
      if (updated) {
        toast.success('已更新');
        // 同步更新列表
        setNotebooks(
          useMemoStore.getState().notebooks.map((nb) => (nb.id === updated.id ? updated : nb))
        );
        // 同步更新当前选中项, 让顶部按钮立即反映新名称
        if (useMemoStore.getState().selectedNotebook?.id === updated.id) {
          setSelectedNotebook(updated);
        }
        setEditNotebookOpen(false);
        setEditingNotebook(null);
        setEditNotebookName('');
      } else {
        toast.error('更新失败');
      }
    } catch (error) {
      console.warn('[MemoList] Failed to update notebook:', error);
      toast.error('更新失败');
    }
  };

  return (
    <div className="flex flex-col h-full bg-[var(--card)] relative">
      {/* Memo Tab */}
      <div className="flex items-center justify-between pl-2 pr-4 py-2 gap-2">
        <div className="min-w-0 flex-1">
          <DropdownMenu open={notebookDropdownOpen} onOpenChange={setNotebookDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <button
                className="group flex max-w-full min-w-0 items-center gap-1 overflow-hidden px-2 py-0.5 rounded-md transition-colors"
              >
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--foreground)] transition-colors duration-150 group-hover:text-[color-mix(in_oklch,var(--foreground)_80%,white)]">{selectedNotebook?.name || '选择笔记本'}</span>
                <ChevronDown className="w-[14px] h-[14px] text-[var(--muted-foreground)] shrink-0" strokeWidth={2.5} />
              </button>
            </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" className="w-[200px] px-1 py-1.5 space-y-1">
            {/* Group 1: Filter Options */}
            <DropdownMenuLabel className="text-xs uppercase tracking-wider text-[var(--muted-foreground)] px-2 pb-1">筛选</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => handleFilterChange('all')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>全部</span>
              {activeFilter === 'all' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleFilterChange('thisWeek')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>只看本周</span>
              {activeFilter === 'thisWeek' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleFilterChange('thisMonth')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>只看本月</span>
              {activeFilter === 'thisMonth' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>

            {/* Group 2: Sort Options */}
            <DropdownMenuLabel className="text-xs uppercase tracking-wider text-[var(--muted-foreground)] px-2 pb-1">排序</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => handleSortChange('createdAt')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>创建时间</span>
              {activeSort === 'createdAt' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleSortChange('updatedAt')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>更新时间</span>
              {activeSort === 'updatedAt' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Tooltip content="全文搜索" shortcut="palette.search">
            <Button
              size="icon"
              variant="outline"
              className={cn(HEADER_ICON_BTN_CLASS, 'bg-[var(--card)]')}
              onClick={() => setSearchCommandOpen(true)}
              aria-label="搜索"
            >
              <Search className="w-4 h-4" />
            </Button>
          </Tooltip>
          <Tooltip content="新建笔记" shortcut="memo.create">
            <Button
              size="icon"
              className="h-8 w-8 justify-center bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 rounded-full p-0 border border-transparent"
              onClick={handleCreateMemo}
            >
              <SquarePen className="w-4 h-4 text-[var(--primary-foreground)]" />
            </Button>
          </Tooltip>
        </div>
      </div>

      {tagOptions.length > 0 && (activeFilter === 'all' || activeFilter === 'tagged') && (
        <div className="px-4 pb-2 pt-1">
          <div className="relative">
            <div ref={tagScrollRef} className="scrollbar-hide flex w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden pr-12">
            {visibleTagOptions.map((tag) => (
              <button
                key={tag.id}
                ref={(node) => {
                  if (node) {
                    tagButtonRefs.current.set(tag.id, node);
                  } else {
                    tagButtonRefs.current.delete(tag.id);
                  }
                }}
                type="button"
                onClick={() => handleTagSelect(tag.id)}
                className={cn(
                  "h-7 max-w-[140px] shrink-0 rounded-lg border px-1.5 text-xs font-medium leading-none transition-colors",
                  "bg-[color-mix(in_oklch,var(--card)_70%,transparent)] hover:border-[var(--primary)] hover:text-[var(--primary)]",
                  selectedTagId === tag.id
                    ? "border-[var(--primary)] bg-[var(--accent)] text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--foreground)]"
                )}
                title={tag.name}
              >
                <span className="flex min-w-0 items-center">
                  <Hash className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
                  <span className="min-w-0 truncate">{tag.name}</span>
                </span>
              </button>
            ))}
            </div>

            {tagOptions.length >= 5 && (
            <div className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-r from-transparent via-[var(--card)] to-[var(--card)] pl-6">
                <Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "pointer-events-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors",
                      tagPopoverOpen
                        ? "text-[var(--primary)]"
                        : "text-[var(--muted-foreground)] hover:text-[var(--primary)]"
                    )}
                    aria-label="更多标签"
                    aria-expanded={tagPopoverOpen}
                  >
                    <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
                  </button>
                </PopoverTrigger>
                {tagPopoverOpen && (
                  <TagOverflowPopoverContent
                    tagOptions={tagOptions}
                    selectedTagId={selectedTagId}
                    hiddenTagIdSet={hiddenTagIdSet}
                    draggingTagId={draggingTagId}
                    dropTarget={dropTarget}
                    dragGhost={dragGhost}
                    popoverRowRefs={popoverRowRefs}
                    onRowPointerDown={handlePopoverRowPointerDown}
                    onTagSelect={handleTagSelect}
                    onPinTagToTop={handlePinTagToTop}
                    onToggleTagHidden={handleToggleTagHidden}
                  />
                )}
                </Popover>
            </div>
            )}
          </div>
        </div>
      )}

      <div ref={listContainerRef} className="flex-1 overflow-y-auto px-2 py-2">
        {isTodosView ? (
          displayTodoEntries.length > 0 ? (
            <div className="flex flex-col">
              {displayTodoEntries.map((todo, index) => {
                const memo = memoById.get(todo.memoId);
                if (!memo) return null;
                const todoKey = getTodoSelectionKey(todo, index);
                return (
                  <div key={todoKey}>
                    <MemoCardTodo
                      memo={memo}
                      todo={todo}
                      todoKey={todoKey}
                      selectedTodoKey={selectedTodoKey}
                      onSelect={handleSelectTodo}
                    />
                    <hr className="mx-3 border-t border-[var(--border)] opacity-50" />
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState />
          )
        ) : memos.length > 0 ? (
          // 普通列渲染: 父容器是 flex-col, 每张卡在文档流里自然堆叠, 高度
          // 由内容撑开, 不再用 transform 定位。 GSAP 入场动画只作用在
          // 命中的 [data-insert-anim] 节点, 不影响周围 row 的流式布局 ──
          // 物理上消除了"上下 row 重叠"的可能性。
          <div className="flex flex-col">
            {memos.map((memo) => {
              // 用 closure 缓存让同一 memo 跨 render 拿到稳定 ref, 避免
              // React 在重渲时反复卸载/挂载 ref (虽然现在没了 virtualizer
              // 测量问题, 但保持稳定仍是好习惯, 也便于 useMemoInsertAnimation
              // 通过 cardRefs 拿到正确的 row 节点)。
              const cardRef = getMemoRowRef(memo.id);
              return (
                <div
                  key={memo.id}
                  ref={cardRef}
                >
                  <div data-insert-anim>
                    <MemoCard
                      memo={memo}
                      tagMap={tagMap}
                      selectedMemo={selectedMemo}
                      openDropdown={openDropdown}
                      onOpenDropdown={setOpenDropdown}
                      onSelect={handleSelectMemo}
                      onFavoriteToggle={handleFavoriteToggle}
                      onDelete={setDeleteMemo}
                    />
                    <hr className="mx-3 border-t border-[var(--border)] opacity-50" />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState />
        )}
      </div>

      {blockingLoadingText && <BlockingLoadingOverlay text={blockingLoadingText} />}

      {deleteMemo && (
        <DeleteDialogShortcuts
          onCancel={handleDeleteCancel}
          onConfirm={handleDeleteConfirm}
        />
      )}

      <Dialog open={!!deleteMemo} onOpenChange={(open) => !open && setDeleteMemo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认是否删除</DialogTitle>
            <DialogDescription>确定要删除 "{displayTitleFromFilename(deleteMemo?.filename)}" 吗？此操作无法撤销。</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setDeleteMemo(null)}
              className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleDeleteConfirm}
              className="relative h-8 pl-3 pr-7 text-sm rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
            >
              删除
              <Kbd className="!text-primary-foreground border-0">↵</Kbd>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 新建 Notebook 弹窗 */}
      {(createNotebookOpen || editNotebookOpen) && (
        <Suspense fallback={null}>
          <LazyNotebookDialogs
            createOpen={createNotebookOpen}
            onCreateOpenChange={setCreateNotebookOpen}
            newNotebookName={newNotebookName}
            onNewNotebookNameChange={setNewNotebookName}
            newNotebookPath={newNotebookPath}
            onNewNotebookPathChange={setNewNotebookPath}
            onSelectDirectory={async () => {
              const result = await request<string | null>('select_directory');
              if (result) setNewNotebookPath(result);
            }}
            onConfirmCreate={handleConfirmCreateNotebook}
            onCancelCreate={() => {
              setCreateNotebookOpen(false);
              setNewNotebookName('');
              setNewNotebookPath('');
            }}
            editOpen={editNotebookOpen}
            onEditOpenChange={(open) => {
              if (!open) {
                setEditingNotebook(null);
                setEditNotebookName('');
              }
              setEditNotebookOpen(open);
            }}
            editingNotebook={editingNotebook}
            editNotebookName={editNotebookName}
            onEditNotebookNameChange={setEditNotebookName}
            onConfirmEdit={handleConfirmEditNotebook}
            onCancelEdit={() => {
              setEditNotebookOpen(false);
              setEditingNotebook(null);
              setEditNotebookName('');
            }}
          />
        </Suspense>
      )}

      {/* 全局搜索 / 命令面板 */}
      <LazyGlobalSearchCommand open={searchCommandOpen} onOpenChange={setSearchCommandOpen} />
    </div>
  );
}
