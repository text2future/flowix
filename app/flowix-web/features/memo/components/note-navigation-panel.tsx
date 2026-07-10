'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { StarFourIcon, CheckSquareIcon, HashIcon, StackIcon } from '@phosphor-icons/react';
import { Pencil, Plus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { NoteNavigationPanelHeaderMac } from '@features/memo/components/note-navigation-panel-header-mac';
import { NoteNavigationPanelHeaderWin } from '@features/memo/components/note-navigation-panel-header-win';
import {
  NotebookIcon,
  useMemoLibraryMetadataStore,
  useMemoStore,
  useTagStore,
  type Notebook,
} from '@features/memo';
import {
  persistTagLayout,
  type MemoTagLayoutItem,
  type MemoTagTreeItem,
} from '@features/memo/services/memo-list-metadata-service';
import { useI18n } from '@features/i18n';
import { isWindowsPlatform } from '@features/shortcuts/platform';

interface TagDragGhost {
  id: string;
  rect: DOMRect;
  currentX: number;
  currentY: number;
}

type TagDropPosition = 'before' | 'after' | 'inside';

interface TagDropTarget {
  id: string;
  position: TagDropPosition;
}

interface NoteNavigationPanelProps {
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onTogglePanel: () => void;
}

// 笔记本列表区域高度 ── 持久化键 + 读 / 写助手。
// 选 localStorage 而非 user-settings-store: 这是纯 UI 维度, 单 number,
// 写读都是 O(1), 无需经 Tauri IPC; 现有 theme/apply.ts 也是同套模式。
// 取值范围与 NOTEBOOK_LIST_MIN/MAX_HEIGHT 同步约束, 越界视为无效。
const NOTEBOOK_LIST_HEIGHT_STORAGE_KEY = 'flowix:notebook-list-height';
const TAG_COLLAPSED_STORAGE_PREFIX = 'flowix:tag-collapsed:';

function readPersistedNotebookListHeight(
  min: number,
  max: number
): number | null {
  try {
    const raw = localStorage.getItem(NOTEBOOK_LIST_HEIGHT_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    if (parsed < min || parsed > max) return null;
    return Math.round(parsed);
  } catch {
    return null;
  }
}

function writePersistedNotebookListHeight(height: number | null): void {
  try {
    if (height === null) {
      localStorage.removeItem(NOTEBOOK_LIST_HEIGHT_STORAGE_KEY);
    } else {
      localStorage.setItem(NOTEBOOK_LIST_HEIGHT_STORAGE_KEY, String(height));
    }
  } catch {
    // localStorage 不可用 (隐私模式 / 配额满 / SSR) 时静默吞掉, 不影响 UI。
  }
}

function getCollapsedTagsStorageKey(notebookId: string): string {
  return `${TAG_COLLAPSED_STORAGE_PREFIX}${notebookId}`;
}

function readPersistedCollapsedTagIds(notebookId: string): string[] {
  try {
    const raw = localStorage.getItem(getCollapsedTagsStorageKey(notebookId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

function writePersistedCollapsedTagIds(notebookId: string, ids: string[]): void {
  try {
    localStorage.setItem(getCollapsedTagsStorageKey(notebookId), JSON.stringify(ids));
  } catch {
    // 折叠状态是纯 UI 偏好, localStorage 不可用时不影响标签树本身。
  }
}

export function NoteNavigationPanel({
  notebooks,
  selectedNotebook,
  onSelectNotebook,
  onEditNotebook,
  onTogglePanel,
}: NoteNavigationPanelProps) {
  const { t } = useI18n();
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const { setActiveFilter } = useMemoStore(
    useShallow((s) => ({
      setActiveFilter: s.setActiveFilter,
    })),
  );
  const selectedTagId = useTagStore((s) => s.selectedTagId);
  const setSelectedTagId = useTagStore((s) => s.setSelectedTagId);
  const tagMetadataRefreshVersion = useTagStore((s) => s.metadataRefreshVersion);
  const loadLibraryMetadata = useMemoLibraryMetadataStore((s) => s.loadMetadata);
  const clearLibraryMetadata = useMemoLibraryMetadataStore((s) => s.clearMetadata);
  const [tagOptions, setTagOptions] = useState<MemoTagTreeItem[]>([]);
  const [tagLayout, setTagLayout] = useState<MemoTagLayoutItem[]>([]);
  const [hiddenTagIds, setHiddenTagIds] = useState<string[]>([]);
  const [totalMemoCount, setTotalMemoCount] = useState(0);
  const [agentMemoCount, setAgentMemoCount] = useState(0);
  const [todoMemoCount, setTodoMemoCount] = useState(0);
  const [collapsedTagIds, setCollapsedTagIds] = useState<string[]>([]);
  const [draggingTagId, setDraggingTagId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TagDropTarget | null>(null);
  const [dragGhost, setDragGhost] = useState<TagDragGhost | null>(null);

  const dragPointerRef = useRef<{
    sourceId: string;
    pointerId: number;
    startY: number;
    startX: number;
    rect: DOMRect | null;
    isDragging: boolean;
  } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // 笔记本列表区域手动调节高度 ── 默认按内容自适应 (max-h 兜底),
  // 用户拖动分隔条后切到显式 height, 但仍受 MAX_NOTEBOOK_HEIGHT 限制。
  // 拖动结束会把最终高度写入 localStorage, 下次打开时 readPersistedNotebookListHeight 还原。
  const NOTEBOOK_LIST_MIN_HEIGHT = 80;
  const NOTEBOOK_LIST_MAX_HEIGHT = 320;
  const [notebookListHeight, setNotebookListHeight] = useState<number | null>(() =>
    readPersistedNotebookListHeight(NOTEBOOK_LIST_MIN_HEIGHT, NOTEBOOK_LIST_MAX_HEIGHT)
  );
  const notebookContainerRef = useRef<HTMLDivElement>(null);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  // window 事件回调里读取的 height 必须是「最新一次 setState 后的值」, 但事件 effect 是
  // 空依赖建立的, 闭包里拿到的是旧值 ── 用 ref 同步 state 解决。
  const latestNotebookListHeightRef = useRef<number | null>(notebookListHeight);
  useEffect(() => {
    latestNotebookListHeightRef.current = notebookListHeight;
  }, [notebookListHeight]);

  const hiddenTagIdSet = useMemo(() => new Set(hiddenTagIds), [hiddenTagIds]);
  const collapsedTagIdSet = useMemo(() => new Set(collapsedTagIds), [collapsedTagIds]);
  const childTagIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const tag of tagOptions) {
      if (tag.parentId) ids.add(tag.parentId);
    }
    return ids;
  }, [tagOptions]);
  const visibleTagOptions = useMemo(() => {
    let collapsedDepth: number | null = null;
    const visible: MemoTagTreeItem[] = [];

    for (const tag of tagOptions) {
      if (collapsedDepth !== null) {
        if (tag.depth > collapsedDepth) continue;
        collapsedDepth = null;
      }

      visible.push(tag);
      if (collapsedTagIdSet.has(tag.id)) {
        collapsedDepth = tag.depth;
      }
    }

    return visible;
  }, [collapsedTagIdSet, tagOptions]);

  useEffect(() => {
    let cancelled = false;

    const loadTags = async (notebook: Notebook) => {
      try {
        const metadata = await loadLibraryMetadata(
          notebook,
          useTagStore.getState().selectedTagId,
          tagMetadataRefreshVersion
        );
        if (!metadata || cancelled) return;
        setTagOptions(metadata.tagOptions);
        setTagLayout(metadata.tagLayout);
        setHiddenTagIds(metadata.hiddenTagIds);
        setTotalMemoCount(metadata.totalMemoCount);
        setAgentMemoCount(metadata.agentMemoCount);
        setTodoMemoCount(metadata.todoMemoCount);
        if (selectedNotebook) {
          const validTagIds = new Set(metadata.tagOptions.map((tag) => tag.id));
          const nextCollapsed = readPersistedCollapsedTagIds(selectedNotebook.id)
            .filter((id) => validTagIds.has(id));
          setCollapsedTagIds(nextCollapsed);
        }
        const currentSelectedTagId = useTagStore.getState().selectedTagId;
        if (metadata.selectedTagId !== currentSelectedTagId) {
          setSelectedTagId(metadata.selectedTagId);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('[NoteNavigationPanel] Failed to load tags:', error);
          setTagOptions([]);
          setTagLayout([]);
          setHiddenTagIds([]);
          setTotalMemoCount(0);
          setAgentMemoCount(0);
          setTodoMemoCount(0);
          setCollapsedTagIds([]);
        }
      }
    };

    if (!selectedNotebook) {
      setTagOptions([]);
      setTagLayout([]);
      setHiddenTagIds([]);
      setTotalMemoCount(0);
      setAgentMemoCount(0);
      setTodoMemoCount(0);
      setCollapsedTagIds([]);
      clearLibraryMetadata();
      return;
    }

    void loadTags(selectedNotebook);

    return () => {
      cancelled = true;
    };
  }, [clearLibraryMetadata, loadLibraryMetadata, tagMetadataRefreshVersion, selectedNotebook, setSelectedTagId]);

  const handleTagSelect = useCallback(
    (tagId: string) => {
      setSelectedTagId(tagId);
      setActiveFilter('tagged');
    },
    [
      setActiveFilter,
      setSelectedTagId,
    ],
  );

  const handleShowAllTags = useCallback(() => {
    setSelectedTagId(null);
    setActiveFilter('all');
  }, [setActiveFilter, setSelectedTagId]);

  const handleShowAgentMemos = useCallback(() => {
    setSelectedTagId(null);
    setActiveFilter('agents');
  }, [setActiveFilter, setSelectedTagId]);

  const handleShowTaskMemos = useCallback(() => {
    setSelectedTagId(null);
    setActiveFilter('todos');
  }, [setActiveFilter, setSelectedTagId]);

  const handleTagCollapseToggle = useCallback((tagId: string) => {
    const notebookId = useMemoStore.getState().selectedNotebook?.id;
    setCollapsedTagIds((current) => {
      const next = current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId];
      if (notebookId) {
        writePersistedCollapsedTagIds(notebookId, next);
      }
      return next;
    });
  }, []);

  // 笔记本行点击: 与 NotebookSwitcher 保持一致 ── 失效路径直接 toast 警告,
  // 不切换。有效路径走 onSelectNotebook 回调。
  const handleNotebookRowActivate = useCallback(
    (notebook: Notebook) => {
      if (notebook.missing) {
        toast.warning(t('status.invalidNotebookPath'));
        return;
      }
      onSelectNotebook(notebook);
    },
    [onSelectNotebook, t],
  );

  const handleCreateNotebookClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent('flowix:open-create-notebook'));
  }, []);

  // 笔记本 / 标签 分隔条拖动 ── 与现有 tag 行 pointer 拖动复用 window listener 套路:
  // pointerdown 在分隔条上记录起点 + 当前高度 + 锁选区; pointermove 累加 deltaY,
  // clamp 到 [MIN, MAX] 后写入 state; pointerup/pointercancel 释放锁并还原 userSelect。
  const handleResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const container = notebookContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      resizeStateRef.current = {
        startY: e.clientY,
        startHeight: notebookListHeight ?? rect.height,
      };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';
    },
    [notebookListHeight]
  );

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const state = resizeStateRef.current;
      if (!state) return;
      const delta = e.clientY - state.startY;
      const next = Math.max(
        NOTEBOOK_LIST_MIN_HEIGHT,
        Math.min(NOTEBOOK_LIST_MAX_HEIGHT, state.startHeight + delta)
      );
      setNotebookListHeight(next);
    };
    const handleUp = () => {
      if (!resizeStateRef.current) return;
      resizeStateRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // 拖动结束: 把最终高度持久化到 localStorage, 下次打开时由 useState 初始化读回。
      // 读 latestNotebookListHeightRef 而非直接闭包, 因为 effect 是空依赖建⽴的,
      // 闭包里的 notebookListHeight 始终是 effect 创建时的旧值。
      writePersistedNotebookListHeight(latestNotebookListHeightRef.current);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  const rebuildTagOptionsFromLayout = useCallback(
    (layout: MemoTagLayoutItem[]): MemoTagTreeItem[] => {
      // Step 3+ 本地版: 跟 [memo-list-metadata-service] 的 buildTagTreeOptions
      // 同源 ── 路径拆 segment、同 fullPath 合并、parent 由字面推导。
      // 输入 `layout` 是真实 tag fullPath 列表 (用户拖拽后产生的新顺序),
      // 输出是 segment 节点树, 用于立刻重渲染面板 (不重新触发 IPC)。
      const segmentByFullPath = new Map<
        string,
        { name: string; fullPath: string; depth: number; count: number }
      >();

      // 复用当前 tagOptions 的 count, 避免重算 prefix
      for (const seg of tagOptions) {
        segmentByFullPath.set(seg.fullPath, {
          name: seg.name,
          fullPath: seg.fullPath,
          depth: seg.depth,
          count: seg.count,
        });
      }

      const ensureSegment = (fullPath: string) => {
        if (segmentByFullPath.has(fullPath)) return;
        const lastSlash = fullPath.lastIndexOf('/');
        if (lastSlash > 0) {
          ensureSegment(fullPath.slice(0, lastSlash));
        }
        const name = lastSlash > 0 ? fullPath.slice(lastSlash + 1) : fullPath;
        const depthFromSlashes = (fullPath.match(/\//g) ?? []).length;
        segmentByFullPath.set(fullPath, {
          name,
          fullPath,
          depth: depthFromSlashes,
          count: 0,
        });
      };

      // 按 layout 顺序展开, 让新出现的 segment 节点排在已存在的之后。
      for (const item of layout) {
        ensureSegment(item.id);
      }

      const childrenByParent = new Map<string | null, string[]>();
      for (const fullPath of segmentByFullPath.keys()) {
        const lastSlash = fullPath.lastIndexOf('/');
        const parentFullPath = lastSlash > 0 ? fullPath.slice(0, lastSlash) : null;
        const arr = childrenByParent.get(parentFullPath) ?? [];
        arr.push(fullPath);
        childrenByParent.set(parentFullPath, arr);
      }

      const result: MemoTagTreeItem[] = [];
      const visit = (fullPath: string) => {
        const seg = segmentByFullPath.get(fullPath)!;
        const lastSlash = fullPath.lastIndexOf('/');
        const parentFullPath = lastSlash > 0 ? fullPath.slice(0, lastSlash) : null;
        result.push({
          id: fullPath,
          parentId: parentFullPath,
          name: seg.name,
          fullPath,
          depth: seg.depth,
          count: seg.count,
        });
        for (const child of childrenByParent.get(fullPath) ?? []) {
          visit(child);
        }
      };

      for (const root of childrenByParent.get(null) ?? []) {
        visit(root);
      }
      return result;
    },
    [tagOptions]
  );

  const getSubtreeIds = useCallback(
    (sourceId: string): string[] => {
      const sourceIndex = tagOptions.findIndex((tag) => tag.id === sourceId);
      if (sourceIndex < 0) return [];
      const sourceDepth = tagOptions[sourceIndex].depth;
      const ids = [sourceId];
      for (let index = sourceIndex + 1; index < tagOptions.length; index += 1) {
        if (tagOptions[index].depth <= sourceDepth) break;
        ids.push(tagOptions[index].id);
      }
      return ids;
    },
    [tagOptions]
  );

  // 拖动排序 / 层级逻辑:
  // 1. pointerdown 在行上设 setPointerCapture 并暂存起点;
  // 2. pointermove 越过 4px 阈值进入拖动态, 显示 ghost + drop 指示;
  // 3. pointerup 时若处于拖动态则提交 reorder, 否则回退为选中点击;
  // 4. before/after 调整同级顺序 (纯 UI 排序, 写 tagLayout 持久化);
  //    inside 走 Step 3 的 `move_memo_tag` IPC, 改写 source 整棵子树
  //    的 name + 批量改 body。
  const applyTagMove = useCallback(
    async (sourceId: string, targetId: string, position: TagDropPosition) => {
      if (sourceId === targetId) return;
      const sourceSubtreeIds = getSubtreeIds(sourceId);
      if (sourceSubtreeIds.length === 0 || sourceSubtreeIds.includes(targetId)) return;

      const target = tagOptions.find((tag) => tag.id === targetId);
      if (!target) return;

      const sourceTag = tagOptions.find((tag) => tag.id === sourceId);
      if (!sourceTag) return;

      const notebookId = useMemoStore.getState().selectedNotebook?.id;
      if (!notebookId) return;

      // **inside**: 真正的 reparent ── 通过 `move_memo_tag` IPC 把
      // source 整棵子树 (含 source.fullPath 自身 + 所有 source.fullPath/*
      // 子孙) 重命名为 `target.fullPath + '/' + source.name`。
      // 节点是 segment 节点, name 是末段, fullPath 是完整路径, 两
      // 者拼接成新 fullPath 给后端。后端会批量改写所有受影响 memo
      // 的 .md body, 同步 memo index。
      if (position === 'inside') {
        const newPath = `${target.fullPath}/${sourceTag.name}`;

        // 展开 target (让用户看到子树整体移动)
        setCollapsedTagIds((current) => {
          if (!current.includes(targetId)) return current;
          const next = current.filter((id) => id !== targetId);
          writePersistedCollapsedTagIds(notebookId, next);
          return next;
        });

        try {
          const report = await useTagStore
            .getState()
            .moveTag(notebookId, sourceTag.fullPath, newPath);
          if (report) {
            // 触发 metadata 刷新, 列表 / 标签面板 / 下拉缓存都重拉
            clearLibraryMetadata();
          }
        } catch (err) {
          // 失败: 给出可见错误提示, 不改变 UI 状态 (memo index 没动)
          console.warn(
            `[NoteNavigationPanel] move tag "${sourceTag.fullPath}" → "${newPath}" failed:`,
            err,
          );
          toast.error(
            err instanceof Error ? err.message : String(err),
          );
        }
        return;
      }

      // **before / after**: 纯 UI 排序, 持久化到 tagLayout。
      const currentLayout = tagLayout.length > 0
        ? tagLayout
        : tagOptions.map(({ id, parentId }) => ({ id, parentId }));
      const movingItems = currentLayout.filter((item) => sourceSubtreeIds.includes(item.id));
      const remaining = currentLayout.filter((item) => !sourceSubtreeIds.includes(item.id));
      const nextMovingItems = movingItems;

      let insertIndex = remaining.length;
      const targetIndex = remaining.findIndex((item) => item.id === targetId);
      if (targetIndex < 0) return;
      if (position === 'before') {
        insertIndex = targetIndex;
      } else {
        const targetSubtreeIds = getSubtreeIds(targetId).filter((id) => !sourceSubtreeIds.includes(id));
        const lastTargetSubtreeId = targetSubtreeIds[targetSubtreeIds.length - 1] ?? targetId;
        insertIndex = remaining.findIndex((item) => item.id === lastTargetSubtreeId) + 1;
      }

      const nextLayout = [
        ...remaining.slice(0, insertIndex),
        ...nextMovingItems,
        ...remaining.slice(insertIndex),
      ];

      setTagLayout(nextLayout);
      setTagOptions(rebuildTagOptionsFromLayout(nextLayout));
      void persistTagLayout(nextLayout, notebookId).catch((error) => {
        console.warn('[NoteNavigationPanel] Failed to persist tag layout:', error);
      });
      clearLibraryMetadata();
    },
    [clearLibraryMetadata, getSubtreeIds, rebuildTagOptionsFromLayout, tagLayout, tagOptions]
  );

  const findDropTarget = useCallback(
    (y: number, sourceId: string): TagDropTarget | null => {
      const sourceSubtreeIds = getSubtreeIds(sourceId);
      for (const tag of visibleTagOptions) {
        if (sourceSubtreeIds.includes(tag.id)) continue;
        const row = rowRefs.current.get(tag.id);
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const relativeY = y - rect.top;
          const position: TagDropPosition =
            relativeY < rect.height / 3
              ? 'before'
              : relativeY > (rect.height * 2) / 3
                ? 'after'
                : 'inside';
          return { id: tag.id, position };
        }
      }
      return null;
    },
    [getSubtreeIds, visibleTagOptions]
  );

  const handleRowPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, tagId: string) => {
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
            currentX: e.clientX,
            currentY: e.clientY,
          });
        }
      } else {
        setDragGhost((prev) => (prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null));
      }

      setDropTarget(findDropTarget(e.clientY, state.sourceId));
    };

    const handleUp = (e: PointerEvent) => {
      const state = dragPointerRef.current;
      if (!state || state.pointerId !== e.pointerId) return;

      if (state.isDragging) {
        const target = findDropTarget(e.clientY, state.sourceId);
        if (target) {
          applyTagMove(state.sourceId, target.id, target.position);
        }
      } else {
        // 没有位移, 视为普通点击 → 选中标签。
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
  }, [applyTagMove, findDropTarget, handleTagSelect]);

  return (
    <div className="flex h-full min-w-0 select-none flex-col bg-[var(--agent-bg)] text-[var(--agent-foreground)]">
      {/* 顶部 header ── Mac/Win 差分:
            - Mac: h-12 (与 OS 标题栏同高) + pl-[90px] 避开红绿灯 + rounded-xl 按钮
            - Win: h-9 (在 OS 标题栏下方, 仅做内部 UI) + rounded-lg 按钮
          两者都整块作为窗口拖动区 (data-tauri-drag-region)。 */}
      {isWindowsPlatform() ? (
        <NoteNavigationPanelHeaderWin onTogglePanel={onTogglePanel} />
      ) : (
        <NoteNavigationPanelHeaderMac onTogglePanel={onTogglePanel} />
      )}

      {/* 笔记本列表 ── 与 status-bar/notebook-switcher 下拉项的呈现保持一致:
          NotebookIcon + 名称 + 失效路径提示, hover 显形编辑/删除。
          高度默认按内容自适应 (max-h 兜底 320px); 用户拖过分隔条后切到显式 height,
          但仍受 320px 上限约束。下方标签区用 flex-1 填满剩余。 */}
      <div
        ref={notebookContainerRef}
        className="flex min-h-0 max-h-[320px] shrink-0 flex-col"
        style={notebookListHeight !== null ? { height: `${notebookListHeight}px` } : undefined}
      >
        <OverlayScrollbar
          className="min-h-0 flex-1"
          scrollerClassName="h-full overflow-y-auto px-2 pb-1"
        >
          <div className="space-y-0.5">
            {notebooks.length === 0 ? (
              <div className="px-2 py-2 text-sm text-[var(--muted-foreground)]">
                {t('status.noNotebooks')}
              </div>
            ) : (
              notebooks.map((notebook) => {
                const isActive = selectedNotebook?.id === notebook.id;
                const isMissing = Boolean(notebook.missing);
                return (
                  <div
                    key={notebook.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleNotebookRowActivate(notebook)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleNotebookRowActivate(notebook);
                      }
                    }}
                    className={cn(
                      'group relative flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-md pl-1.5 pr-2 text-left text-sm transition-colors',
                      isActive
                        ? 'bg-[var(--muted)] text-[var(--foreground)]'
                        : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
                      isMissing && 'opacity-70',
                    )}
                    title={notebook.name}
                    aria-pressed={isActive}
                  >
                    <NotebookIcon
                      icon={notebook.icon}
                      name={notebook.name}
                      className="h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
                      imageClassName="h-5 w-5"
                    />
                    <div className="flex-1 min-w-0 flex items-center gap-1.5">
                      <span className="min-w-0 truncate">
                        <span className={isMissing ? 'text-[var(--muted-foreground)]' : ''}>
                          {notebook.name}
                        </span>
                        {isMissing && (
                          <>
                            <span className="text-[var(--muted-foreground)]">{' '}</span>
                            <span className="text-[var(--muted-foreground)]">
                              {t('status.invalid')}
                            </span>
                          </>
                        )}
                      </span>
                    </div>
                    {/* 编辑 ── 与 NotebookSwitcher 行内操作保持一致,
                        absolute 定位 + group-hover 渐显。删除入口已迁到
                        编辑弹窗的「移除」按钮, 列表行不再提供。 */}
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditNotebook(notebook);
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
                        aria-label={t('status.editNotebook')}
                      >
                        <Pencil className="h-3 w-3" />
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {/* 「新建笔记本」按钮 ── 放在滚动列表内最下方, 与列表项一同滚动,
              取消外框与居中, 改为左侧对齐, 容器 / 图标 / 文本节奏与标签行一致。 */}
          <button
            type="button"
            onClick={handleCreateNotebookClick}
            className={cn(
              'group relative mt-0.5 flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-md pl-1.5 pr-2 text-left text-sm transition-colors',
              'text-[var(--muted-foreground)] hover:bg-[var(--muted)]',
            )}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">{t('status.new')}</span>
          </button>
        </OverlayScrollbar>
      </div>

      {/* 笔记本 / 标签 分隔条 ── 鼠标 hover 显形 + 可拖动, 调节上方笔记本列表高度。
          4px 命中区 (h-1) + 顶部 1px 视觉线 (border-t), 颜色取 --muted-foreground
          中灰 /50 保证清晰可见; group-hover/active 切到 primary 色反馈。 */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("memo.navigation.resizeNotebookList")}
        onPointerDown={handleResizeStart}
        className="group mx-2 h-1 shrink-0 cursor-row-resize border-t border-[var(--muted-foreground)]/50 hover:border-[var(--primary)]/70 active:border-[var(--primary)]"
      />

      {/* 标签列表 ── 填满笔记本区剩余的 64% 高度, 内部独立滚动。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <OverlayScrollbar
          className="min-h-0 flex-1"
          scrollerClassName="h-full overflow-y-auto px-2 pt-2 pb-3"
        >
          <div className="space-y-0.5">
            <div
              role="button"
              tabIndex={0}
              onClick={handleShowAllTags}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleShowAllTags();
                }
              }}
              className={cn(
                'group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors',
                activeFilter === 'all'
                  ? 'bg-[var(--muted)] text-[var(--foreground)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
              )}
              style={{ paddingLeft: 6 }}
              aria-pressed={activeFilter === 'all'}
            >
              <span className="mr-2 shrink-0 opacity-60">
                <StackIcon
                  className="h-3.5 w-3.5 text-[var(--muted-foreground)]"
                  weight="bold"
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{t("memo.list.filterAll")}</span>
              <span className="ml-2 shrink-0 tabular-nums text-xs text-[var(--muted-foreground)]">
                {totalMemoCount}
              </span>
            </div>
            <div
              role="button"
              tabIndex={0}
              onClick={handleShowAgentMemos}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleShowAgentMemos();
                }
              }}
              className={cn(
                'group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors',
                activeFilter === 'agents'
                  ? 'bg-[var(--muted)] text-[var(--foreground)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
              )}
              style={{ paddingLeft: 6 }}
              aria-pressed={activeFilter === 'agents'}
            >
              <span className="mr-2 shrink-0 opacity-60">
                <StarFourIcon
                  className="h-3.5 w-3.5 text-[var(--muted-foreground)]"
                  weight="bold"
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{t("memo.list.filterAgents")}</span>
              <span className="ml-2 shrink-0 tabular-nums text-xs text-[var(--muted-foreground)]">
                {agentMemoCount}
              </span>
            </div>
            <div
              role="button"
              tabIndex={0}
              onClick={handleShowTaskMemos}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleShowTaskMemos();
                }
              }}
              className={cn(
                'group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors',
                activeFilter === 'todos'
                  ? 'bg-[var(--muted)] text-[var(--foreground)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
              )}
              style={{ paddingLeft: 6 }}
              aria-pressed={activeFilter === 'todos'}
            >
              <span className="mr-2 shrink-0 opacity-60">
                <CheckSquareIcon
                  className="h-3.5 w-3.5 text-[var(--muted-foreground)]"
                  weight="bold"
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{t("memo.list.filterTasks")}</span>
              <span className="ml-2 shrink-0 tabular-nums text-xs text-[var(--muted-foreground)]">
                {todoMemoCount}
              </span>
            </div>
            {tagOptions.length > 0 && (
              <>
              {visibleTagOptions.map((tag) => {
                const isSelected = activeFilter === 'tagged' && selectedTagId === tag.id;
                const isHidden = hiddenTagIdSet.has(tag.id);
                const isDragging = draggingTagId === tag.id;
                const hasChildren = childTagIdSet.has(tag.id);
                const isDropBefore =
                  dropTarget?.id === tag.id && dropTarget.position === 'before' && !isDragging;
                const isDropAfter =
                  dropTarget?.id === tag.id && dropTarget.position === 'after' && !isDragging;
                const isDropInside =
                  dropTarget?.id === tag.id && dropTarget.position === 'inside' && !isDragging;

                return (
                  <div
                    key={tag.id}
                    ref={(node) => {
                      if (node) {
                        rowRefs.current.set(tag.id, node);
                      } else {
                        rowRefs.current.delete(tag.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    onPointerDown={(event) => handleRowPointerDown(event, tag.id)}
                    onDoubleClick={(event) => {
                      if (!hasChildren) return;
                      event.preventDefault();
                      handleTagCollapseToggle(tag.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleTagSelect(tag.id);
                      }
                    }}
                    className={cn(
                      'group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors',
                      isSelected
                        ? 'bg-[var(--muted)] text-[var(--foreground)]'
                        : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
                      isDragging && 'opacity-50',
                      isDropInside && 'tag-drop-target-inside',
                      isHidden && !isSelected && 'opacity-70',
                    )}
                    style={{ paddingLeft: `${6 + tag.depth * 14}px` }}
                    title={tag.fullPath}
                    aria-pressed={isSelected}
                  >
                    <span
                      data-tag-icon=""
                      className={cn(
                        'relative mr-2 shrink-0 opacity-60',
                        hasChildren && 'cursor-pointer',
                      )}
                      // `#` 图标当作独立控件: 单击展开/折叠, 不触发行
                      // 选中也不进入拖拽。键盘 Enter/Space 同样可用。
                      // hover/focus 时 [data-tag-icon]:hover 规则加深展开三角
                      // ── 视觉提示该图标可点击。
                      role={hasChildren ? 'button' : undefined}
                      tabIndex={hasChildren ? 0 : undefined}
                      aria-label={
                        hasChildren
                          ? collapsedTagIdSet.has(tag.id)
                            ? t('memo.tag.expand')
                            : t('memo.tag.collapse')
                          : undefined
                      }
                      onPointerDown={(event) => {
                        // 阻止事件冒泡到行 ── 避免在图标上按下也启动 drag
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        if (!hasChildren) return;
                        event.stopPropagation();
                        event.preventDefault();
                        handleTagCollapseToggle(tag.id);
                      }}
                      onKeyDown={(event) => {
                        if (!hasChildren) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.stopPropagation();
                          event.preventDefault();
                          handleTagCollapseToggle(tag.id);
                        }
                      }}
                    >
                      <HashIcon
                        className="h-3.5 w-3.5 text-[var(--muted-foreground)]"
                        weight="bold"
                      />
                      {hasChildren && (
                        <span
                          aria-hidden
                          className="tag-expand-indicator pointer-events-none absolute -bottom-px -right-px h-0 w-0 border-b-[5px] border-l-[5px] border-l-transparent"
                        />
                      )}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        isHidden && !isSelected && 'text-[var(--muted-foreground)]',
                      )}
                    >
                      {tag.name}
                    </span>
                    <span
                      className={cn(
                        'ml-2 shrink-0 tabular-nums text-xs text-[var(--muted-foreground)]',
                        isSelected && 'text-[var(--foreground)]/70',
                      )}
                    >
                      {tag.count}
                    </span>
                    {isDropBefore && (
                      <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-[var(--brand)]" />
                    )}
                    {isDropAfter && (
                      <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-[var(--brand)]" />
                    )}
                  </div>
                );
              })}
              </>
            )}
          </div>
        </OverlayScrollbar>
      </div>

      {dragGhost && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[1100] flex items-center gap-2 rounded-md border border-[var(--primary)] bg-[var(--card)] px-2 text-sm opacity-50 shadow-lg"
          style={{
            left: dragGhost.currentX + 12,
            top: dragGhost.currentY + 12,
            width: dragGhost.rect.width,
            height: dragGhost.rect.height,
          }}
        >
          <HashIcon
            className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]"
            weight="bold"
          />
          <span className="min-w-0 flex-1 truncate">
            {tagOptions.find((tag) => tag.id === dragGhost.id)?.name ?? ''}
          </span>
        </div>
      )}
    </div>
  );
}
