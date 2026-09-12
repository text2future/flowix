'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { HashIcon, PlusIcon } from '@phosphor-icons/react';
import { SquareMinus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { isValidTagPath } from '@/lib/tag-path';
import { createLogger } from '@/lib/logger';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/ui/select';
import {
  useMemoLibraryMetadataStore,
  useMemoStore,
  useTagStore,
  type Notebook,
} from '@features/memo';
import {
  persistTagLayout,
  rebaseSelectedTagId,
  resolveSelectedTagId,
  type MemoTagLayoutItem,
  type MemoTagTreeItem,
} from '@features/memo/services/memo-list-metadata-service';
import { useI18n, type I18nParams } from '@/lib/i18n';
import { invalidateMentionTags } from '@features/editor/extensions/tag-mention';
import { useDragReorder, type DragDropTarget } from '@features/memo/hooks/use-drag-reorder';
import {
  computeTagDropPosition,
  getSubtreeIds,
  rebuildTagOptionsFromLayout,
  reorderTagLayout,
  applyPinOrdering,
  diffPinnedByParent,
  migratePinnedByParentOnDelete,
  migratePinnedByParentOnPathChange,
  type TagDropPosition,
} from '@features/memo/components/tag-reorder';
import { markTagsCollapsedByAncestor } from '@features/memo/components/tag-collapse';
import { agent, system } from '@platform/tauri/client';

interface TagTreeProps {
  selectedNotebook: Notebook | null;
  /** loadTags 完成时上抛 (total/agent/todo) 计数, 供 NavFilterButtons 展示。 */
  onCountsChange: (counts: { total: number; agent: number; todo: number }) => void;
  /** Optional callback for lightweight consumers such as the memo-list drawer. */
  onSelectTag?: (tagId: string) => void;
  /** Hide the selected row treatment when rendered as a list-navigation drawer. */
  hideSelectionStyle?: boolean;
  /** Hide the section title and its top spacing in compact consumers. */
  hideSectionHeader?: boolean;
}

// 笔记本列表区域高度 ── 持久化键 + 读 / 写助手。
const TAG_COLLAPSED_STORAGE_PREFIX = 'flowix:tag-collapsed:';
const logger = createLogger('tag-tree');

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

// 标签树 ── 从 NoteNavigationPanel 拆出。自持:
//   - loadTags effect (selectedNotebook 变化时拉 metadata, 上抛 counts)
//   - tag 状态 (tagOptions/tagLayout/hiddenTagIds/collapsedTagIds/编辑/删除)
//   - 拖拽重排 + reparent (useDragReorder, 替代原内联 tag 状态机)
//   - 行内重命名 / 右键删除确认弹窗 / drag ghost
// 与父级的唯一耦合是 onCountsChange (counts 上抛给 NavFilterButtons)。
// 落点位置 / 子树 / 同级重排 / segment 树重建等纯逻辑见 tag-reorder.ts。
export function TagTree({
  selectedNotebook,
  onCountsChange,
  onSelectTag,
  hideSelectionStyle = false,
  hideSectionHeader = false,
}: TagTreeProps) {
  const { t } = useI18n();
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const setActiveFilter = useMemoStore((s) => s.setActiveFilter);
  const selectedTagId = useTagStore((s) => s.selectedTagId);
  const setSelectedTagId = useTagStore((s) => s.setSelectedTagId);
  const tagMetadataRefreshVersion = useTagStore((s) => s.metadataRefreshVersion);
  const loadLibraryMetadata = useMemoLibraryMetadataStore((s) => s.loadMetadata);
  const clearLibraryMetadata = useMemoLibraryMetadataStore((s) => s.clearMetadata);

  const [tagOptions, setTagOptions] = useState<MemoTagTreeItem[]>([]);
  const [tagLayout, setTagLayout] = useState<MemoTagLayoutItem[]>([]);
  const [hiddenTagIds, setHiddenTagIds] = useState<string[]>([]);
  // 置顶簿: parent fullPath (root 用 '') → MRU 顺序 child fullPath 列表。
  // 真源在 `system.json`；这里只用作乐观更新 + 渲染输入。tagOptions 已经在
  // loadMemoLibraryMetadata 里 applyPinOrdering 过, 渲染拿到的就是已排好的
  // 顺序, 这里另存一份是为迁移 / diff 持久化。
  const [pinnedByParent, setPinnedByParent] = useState<Record<string, string[]>>({});
  const [collapsedTagIds, setCollapsedTagIds] = useState<string[]>([]);
  // 行内重命名编辑态: editingTagId 命中时标签名 span 替换为 input。
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newTagParentPath, setNewTagParentPath] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [createTagError, setCreateTagError] = useState<string | null>(null);
  const [isCreatingTag, setIsCreatingTag] = useState(false);
  // 删除确认弹窗: `deletingTag` 命中时, 弹 Dialog 提示子树影响范围 + 确认。
  const [deletingTag, setDeletingTag] = useState<MemoTagTreeItem | null>(null);
  // 批量管理模式: true 时标签末尾的数字变成删除按钮 (SquareMinus),
  // 标题栏 + 图标变成 Done, 点击退出批量模式。
  const [batchMode, setBatchMode] = useState(false);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());

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
    // 不过滤折叠子树, 而是全量渲染并标记 collapsedByAncestor;
    // 折叠的子树行留在 DOM 中, 由外层 .tag-collapse-track 过渡高度和透明度。
    // 基于 parentId 祖先链判定，避免嵌套折叠节点覆盖外层折叠范围。
    return markTagsCollapsedByAncestor(tagOptions, collapsedTagIdSet);
  }, [collapsedTagIdSet, tagOptions]);

  useEffect(() => {
    let cancelled = false;

    const loadTags = async (notebook: Notebook) => {
      try {
        const metadata = await loadLibraryMetadata(
          notebook,
          tagMetadataRefreshVersion
        );
        if (!metadata || cancelled) return;
        setTagOptions(metadata.tagOptions);
        setTagLayout(metadata.tagLayout);
        setHiddenTagIds(metadata.hiddenTagIds);
        setPinnedByParent(metadata.pinnedByParent);
        // 「对话」计数走 agent conversation 实例表 (按 source_notebook_id 圈定),
        // 而非 memo 索引里的"含对话笔记数" —— 与中间列对话列表同口径。
        const conversationCount = await agent
          .countConversationInstancesByNotebook(notebook.id)
          .catch((error) => {
            logger.warn('failed to count conversations', { error });
            return 0;
          });
        if (cancelled) return;
        onCountsChange({
          total: metadata.totalMemoCount,
          agent: conversationCount,
          todo: metadata.todoMemoCount,
        });
        if (selectedNotebook) {
          const validTagIds = new Set(metadata.tagOptions.map((tag) => tag.id));
          const nextCollapsed = readPersistedCollapsedTagIds(selectedNotebook.id)
            .filter((id) => validTagIds.has(id));
          setCollapsedTagIds(nextCollapsed);
        }
        // 用当前 selectedTagId 重新校验 (而非 IPC 时的旧值): IPC 期间
        // selectedTagId 可能已变 (重命名 commitRename 把旧路径更新到新
        // fullPath), 用旧值校验出的 null 会覆盖新值, 选中态丢成"全部"。
        const currentSelectedTagId = useTagStore.getState().selectedTagId;
        const resolvedSelectedTagId = resolveSelectedTagId(currentSelectedTagId, metadata.tagOptions);
        if (resolvedSelectedTagId !== currentSelectedTagId) {
          setSelectedTagId(resolvedSelectedTagId);
        }
      } catch (error) {
        if (!cancelled) {
          logger.warn('failed to load tags', { error });
          setTagOptions([]);
          setTagLayout([]);
          setHiddenTagIds([]);
          setPinnedByParent({});
          setCollapsedTagIds([]);
          onCountsChange({ total: 0, agent: 0, todo: 0 });
        }
      }
    };

    if (!selectedNotebook) {
      setTagOptions([]);
      setTagLayout([]);
      setHiddenTagIds([]);
      setPinnedByParent({});
      setCollapsedTagIds([]);
      setBatchMode(false);
      onCountsChange({ total: 0, agent: 0, todo: 0 });
      clearLibraryMetadata();
      return;
    }

    void loadTags(selectedNotebook);

    return () => {
      cancelled = true;
    };
  }, [clearLibraryMetadata, loadLibraryMetadata, tagMetadataRefreshVersion, selectedNotebook, setSelectedTagId, onCountsChange]);

  const handleTagSelect = useCallback(
    (tagId: string) => {
      setSelectedTagId(tagId);
      setActiveFilter('tagged');
      onSelectTag?.(tagId);
    },
    [
      onSelectTag,
      setActiveFilter,
      setSelectedTagId,
    ],
  );

  const openCreateTagDialog = useCallback(() => {
    setNewTagParentPath('');
    setNewTagName('');
    setCreateTagError(null);
    setCreateDialogOpen(true);
  }, []);

  const submitCreateTag = useCallback(async () => {
    if (!selectedNotebook || isCreatingTag) return;
    const name = newTagName.trim();
    if (!name) {
      setCreateTagError(t('memo.tag.createEmpty'));
      return;
    }
    if (name.startsWith('#')) {
      setCreateTagError(t('memo.tag.createWithoutHash'));
      return;
    }
    if (!isValidTagPath(name)) {
      setCreateTagError(t('memo.tag.createInvalid'));
      return;
    }
    const path = newTagParentPath ? `${newTagParentPath}/${name}` : name;

    setIsCreatingTag(true);
    setCreateTagError(null);
    try {
      const report = await useTagStore
        .getState()
        .createTag(selectedNotebook.id, path);
      clearLibraryMetadata();
      invalidateMentionTags();
      setCreateDialogOpen(false);
      setNewTagParentPath('');
      setNewTagName('');
      toast.success(
        t('memo.tag.createdToast', { path: report.path } satisfies I18nParams),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(
        message.includes('already exists')
          ? t('memo.tag.createDuplicate')
          : `${t('memo.tag.createFailed')}: ${message}`,
      );
    } finally {
      setIsCreatingTag(false);
    }
  }, [
    clearLibraryMetadata,
    isCreatingTag,
    newTagName,
    newTagParentPath,
    selectedNotebook,
    t,
  ]);

  const startRename = useCallback((tag: MemoTagTreeItem) => {
    setEditingTagId(tag.id);
    setEditingTagName(tag.name);
  }, []);

  /**
   * 持久化 pinnedByParent 的差异：diff before/after, 逐个 parentKey 调
   * `system.setTagPinned`。空数组由 Rust 端清空 key。
   *
   * 任一调用失败时 record 最后一个错, 调用方统一处理回滚。错误不抛出
   * 中断后续 parentKey 写入 ── 一次失败就停 chain 会让后端再次进入
   * 不一致状态, 全调一遍 + 报最后一条错更可控。
   */
  const persistPinnedChanges = useCallback(
    async (
      before: Record<string, string[]>,
      after: Record<string, string[]>,
      notebookId: string,
    ): Promise<void> => {
      const changes = diffPinnedByParent(before, after);
      let lastError: unknown = null;
      for (const { parentKey, pinnedIds } of changes) {
        try {
          await system.setTagPinned(notebookId, parentKey, pinnedIds);
        } catch (err) {
          lastError = err;
          logger.warn('failed to persist pinned', { error: err, parentKey });
        }
      }
      if (lastError) throw lastError;
    },
    [],
  );

  /**
   * 「置顶」菜单项: 把 tag 推到 parent 下兄弟组最前 (MRU 语义)。无提供取消
   * 路径 ── pinned 只能通过 delete / rename / reparent 间接迁移或清空。
   * 既有 pinned 重新置顶 = 把它从当前位置抽离并插到 head (让其他 pinned 后
   * 退一格), 符合 "最近置顶排第一"。
   */
  const pinTag = useCallback(
    async (tag: MemoTagTreeItem) => {
      const notebookId = useMemoStore.getState().selectedNotebook?.id;
      if (!notebookId) return;
      const parentKey = tag.parentId ?? '';
      const current = pinnedByParent[parentKey] ?? [];
      const next: string[] = [
        tag.fullPath,
        ...current.filter((p) => p !== tag.fullPath),
      ];
      const prev = pinnedByParent;
      const nextMap: Record<string, string[]> = {
        ...pinnedByParent,
        [parentKey]: next,
      };
      // 乐观更新
      setPinnedByParent(nextMap);
      setTagOptions(applyPinOrdering(tagOptions, nextMap));
      try {
        await system.setTagPinned(notebookId, parentKey, next);
      } catch (err) {
        // 回滚
        setPinnedByParent(prev);
        setTagOptions(applyPinOrdering(tagOptions, prev));
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [pinnedByParent, tagOptions],
  );

  // 行内重命名提交: 复用 moveTag (重命名 = 同父级 move 末段)。segment 字符
  // 与共享 tag path 校验一致; 冲突依赖后端 AlreadyExists 报错 toast,
  // 保持编辑态。成功后失效 mention 缓存 + 清 metadata, 并把 selectedTagId
  // 跟到新 fullPath (否则 metadata refresh 会用 validTagSelectionSet 校验掉
  // 旧路径, 丢失选中态)。
  const commitRename = useCallback(
    async (tag: MemoTagTreeItem, newSegment: string) => {
      const trimmed = newSegment.trim();
      if (!trimmed || trimmed === tag.name) {
        setEditingTagId(null);
        return;
      }
      if (!isValidTagPath(trimmed) || trimmed.includes('/')) {
        toast.error(t('memo.tag.renameInvalidChar'));
        return;
      }
      const lastSlash = tag.fullPath.lastIndexOf('/');
      const parent = lastSlash > 0 ? tag.fullPath.slice(0, lastSlash) : null;
      const newFullPath = parent ? `${parent}/${trimmed}` : trimmed;
      if (newFullPath === tag.fullPath) {
        setEditingTagId(null);
        return;
      }
      const notebookId = useMemoStore.getState().selectedNotebook?.id;
      if (!notebookId) {
        setEditingTagId(null);
        return;
      }
      // moveTag 前记下选中态 ── 不能在 await 后取: moveTag 期间后端 emit
      // MemoEvent::Updated 触发 metadata 重载, 会把旧路径 selectedTagId
      // 校验清成 null, await 后取到的已是 null, 无法前缀替换。
      const beforeSelected = useTagStore.getState().selectedTagId;
      // pinned 迁移: rename only 改 last segment, parent 不变; oldParentKey === newParentKey。
      const newLastSlash = newFullPath.lastIndexOf('/');
      const newParentKey = newLastSlash > 0 ? newFullPath.slice(0, newLastSlash) : '';
      const oldParentKey = tag.parentId ?? '';
      const prevPinned = pinnedByParent;
      const migratedPinned = migratePinnedByParentOnPathChange(
        pinnedByParent,
        tag.fullPath,
        newFullPath,
        oldParentKey,
        newParentKey,
      );
      try {
        const report = await useTagStore
          .getState()
          .moveTag(notebookId, tag.fullPath, newFullPath);
        if (report) {
          // 选中态保持: 把 selectedTagId 从旧前缀映射到新前缀 (本身 / 后代),
          // 在 clearLibraryMetadata 前同步写回, 不依赖 await 后的 selectedTagId。
          const nextSelected = rebaseSelectedTagId(beforeSelected, tag.fullPath, newFullPath);
          if (nextSelected !== useTagStore.getState().selectedTagId) {
            useTagStore.getState().setSelectedTagId(nextSelected);
          }
          // pinned 簿同步迁移: 必须先 await 持久化再 clearLibraryMetadata ──
          // 否则 clear 触发的 metadata 重载会读到旧 (pre-migration) 的
          // pinnedByParent, 把刚 set 的 migratedPinned 覆盖掉。
          // moveTag 已经成功, 这里 pinned 写盘失败不应阻塞 UI, 仅 toast / log。
          setPinnedByParent(migratedPinned);
          setTagOptions(applyPinOrdering(tagOptions, migratedPinned));
          try {
            await persistPinnedChanges(prevPinned, migratedPinned, notebookId);
          } catch (err) {
            console.warn('[TagTree] Failed to persist pinned after rename:', err);
          }
          clearLibraryMetadata();
          invalidateMentionTags();
        }
        setEditingTagId(null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [clearLibraryMetadata, persistPinnedChanges, pinnedByParent, tagOptions, t],
  );

  /**
   * 提交删除一个 tag 子树。 与 `commitRename` 对称 ── 但语义不同:
   * rename 是改写 token, delete 是移除 token。 删除的影响范围**可能**跨
   * 多级 (子节点也会被一并删), 所以先经 Dialog 确认, 用户明确点确认才
   * 真正调 IPC。
   *
   * 选中态处理: 如果 selectedTagId 命中被删子树 (是 tag 自身或其后代),
   * 一律 `setSelectedTagId(null)` + 切 `activeFilter='all'` ── 被删的 tag
   * 已经不存在了, 旧选中态没意义。 这与 rename 的 rebaseSelectedTagId
   * (跟到新 fullPath) 形成对照。
   *
   * 后端 `delete_memo_tag` IPC 同步完成后会 emit `MemoEvent::TagsDeleted`,
   * frontend handler 走 `handleTagsDeleted` 局部 patch memos[*].tags。
   */
  const confirmDeleteTag = useCallback(
    async (tag: MemoTagTreeItem) => {
      const notebookId = useMemoStore.getState().selectedNotebook?.id;
      if (!notebookId) return;
      // 记下删除前的 selectedTagId ── 同 commitRename 的 beforeSelected
      // 模式: IPC 期间 memo-event 触发 metadata 重载, 旧 selectedTagId
      // 会被 validate 掉成 null, await 后取不到原值。
      const beforeSelected = useTagStore.getState().selectedTagId;
      // 计算受影响的下游:
      // - selectedTagId 命中子树 -> 重置为 null + 切 activeFilter='all'
      // - 命中但不在子树的 (前/同级) -> 保留不动
      const selectedInsideSubtree =
        beforeSelected !== null &&
        (beforeSelected === tag.fullPath ||
          beforeSelected.startsWith(`${tag.fullPath}/`));
      // pinned 簿清理: 删除子树命中会带走 pinned 条目 (精确 + 子孙)。
      const prevPinned = pinnedByParent;
      const migratedPinned = migratePinnedByParentOnDelete(pinnedByParent, tag.fullPath);
      try {
        const report = await useTagStore.getState().deleteTag(notebookId, tag.fullPath);
        if (report) {
          if (selectedInsideSubtree) {
            // 选中态失效: selectedTagId 校验会立刻清成 null (validate
            // 失败), 我们主动先写回 null 避免 useEffect 异步路径里出现
            // 一次 "无效值" 闪烁。 activeFilter 切 'all' 让列表回到
            // 未筛选状态。
            setSelectedTagId(null);
            setActiveFilter('all');
          }
          // 同 commitRename: 必须先 await pinned 持久化, 再 clearLibraryMetadata
          // 否则后续 metadata 重载会用旧 pinnedByParent 覆盖刚 set 的值。
          setPinnedByParent(migratedPinned);
          setTagOptions(applyPinOrdering(tagOptions, migratedPinned));
          try {
            await persistPinnedChanges(prevPinned, migratedPinned, notebookId);
          } catch (err) {
            console.warn('[TagTree] Failed to persist pinned after delete:', err);
          }
          clearLibraryMetadata();
          invalidateMentionTags();
          toast.success(t('memo.tag.deletedToast', { path: tag.fullPath } satisfies I18nParams));
        }
      } catch (err) {
        toast.error(
          `${t('memo.tag.deleteFailed')}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [clearLibraryMetadata, persistPinnedChanges, pinnedByParent, setActiveFilter, setSelectedTagId, tagOptions, t],
  );

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
      const sourceSubtreeIds = getSubtreeIds(tagOptions, sourceId);
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
      // 的 YAML `tags`, 同步 memo index。
      if (position === 'inside') {
        const newPath = `${target.fullPath}/${sourceTag.name}`;

        // 展开 target (让用户看到子树整体移动)
        setCollapsedTagIds((current) => {
          if (!current.includes(targetId)) return current;
          const next = current.filter((id) => id !== targetId);
          writePersistedCollapsedTagIds(notebookId, next);
          return next;
        });

        // moveTag 前记下选中态 ── await 期间 memo-event 触发的 metadata 重载
        // 会把旧路径 selectedTagId 校验清成 null, await 后取不到原值。
        const beforeSelected = useTagStore.getState().selectedTagId;
        // pinned 迁移: reparent = parentKey 变化。source 的 parent 从
        // sourceTag.parentId → target.fullPath; entry 要从旧 parentKey
        // 列表搬到新 parentKey 列表。
        const prevPinned = pinnedByParent;
        const migratedPinned = migratePinnedByParentOnPathChange(
          pinnedByParent,
          sourceTag.fullPath,
          newPath,
          sourceTag.parentId ?? '',
          target.fullPath,
        );
        try {
          const report = await useTagStore
            .getState()
            .moveTag(notebookId, sourceTag.fullPath, newPath);
          if (report) {
            // 选中态保持: 把 selectedTagId 从旧前缀映射到新前缀, 在
            // clearLibraryMetadata 前同步写回, 不依赖 await 后的 selectedTagId。
            const nextSelected = rebaseSelectedTagId(beforeSelected, sourceTag.fullPath, newPath);
            if (nextSelected !== useTagStore.getState().selectedTagId) {
              useTagStore.getState().setSelectedTagId(nextSelected);
            }
            setPinnedByParent(migratedPinned);
            setTagOptions(applyPinOrdering(tagOptions, migratedPinned));
            try {
              await persistPinnedChanges(prevPinned, migratedPinned, notebookId);
            } catch (err) {
              console.warn('[TagTree] Failed to persist pinned after reparent:', err);
            }
            // 编辑器 `#` mention 缓存失效 + metadata 重拉 (列表/面板/下拉)。
            // 必须放在 persist 之后, 避免 metadata 重载读到旧 pinnedByParent
            // 把刚 set 的 migratedPinned 覆盖掉。
            clearLibraryMetadata();
            invalidateMentionTags();
          }
        } catch (err) {
          // 失败: 给出可见错误提示, 不改变 UI 状态 (memo index 没动)
          console.warn(
            `[TagTree] move tag "${sourceTag.fullPath}" -> "${newPath}" failed:`,
            err,
          );
          toast.error(
            err instanceof Error ? err.message : String(err),
          );
        }
        return;
      }

      // **before / after**: 纯 UI 排序, 持久化到 tagLayout。布局算术走
      // tag-reorder 的纯函数 (reorderTagLayout), 这里只做副作用。
      const nextLayout = reorderTagLayout(tagLayout, tagOptions, sourceId, targetId, position);
      if (!nextLayout) return;

      setTagLayout(nextLayout);
      setTagOptions(rebuildTagOptionsFromLayout(nextLayout, tagOptions));
      void persistTagLayout(nextLayout, notebookId).catch((error) => {
        console.warn('[TagTree] Failed to persist tag layout:', error);
      });
      clearLibraryMetadata();
      invalidateMentionTags();
    },
    [clearLibraryMetadata, persistPinnedChanges, pinnedByParent, tagLayout, tagOptions]
  );

  const findDropTarget = useCallback(
    (y: number, sourceId: string): DragDropTarget<TagDropPosition> | null => {
      const sourceSubtreeIds = getSubtreeIds(tagOptions, sourceId);
      for (const tag of visibleTagOptions) {
        if (tag.collapsedByAncestor) continue;
        if (sourceSubtreeIds.includes(tag.id)) continue;
        const row = rowRefs.current.get(tag.id);
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const position = computeTagDropPosition(y - rect.top, rect.height);
          return { id: tag.id, position };
        }
      }
      return null;
    },
    [tagOptions, visibleTagOptions]
  );

  const { draggingId, dropTarget, dragGhost, handlePointerDown } = useDragReorder<TagDropPosition>({
    findDropTarget,
    applyMove: applyTagMove,
    onSelect: handleTagSelect,
  });

  const draggingTagId = draggingId;

  return (
    <>
      {/* 标签组 ── 外侧容器, pt-1 提供组上方留白 (与资料组对称, 两侧均用 padding 而非 margin);
          标签行间距由 .tag-collapse-track 自身控制，确保折叠轨道不残留 space-y margin。 */}
      <div className={cn('tag-tree-list', !hideSectionHeader && 'pt-1')}>
        {/* 标签分类标题 ── 过滤器 (全部/对话/待办) 在上, 真正的标签树在此标题之下。 */}
        {!hideSectionHeader && (
          <div className="agent-thread-card__access-section-label flex items-center justify-between">
            <span>{t('memo.navigation.tags')}</span>
            {batchMode ? (
              <button
                type="button"
                onClick={() => setBatchMode(false)}
                className="-my-1 flex h-5 translate-x-1 items-center gap-1 rounded-md px-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                aria-label={t('memo.tag.batchDone')}
                title={t('memo.tag.batchDone')}
              >
                <span>{t('memo.tag.batchDone')}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={openCreateTagDialog}
                disabled={!selectedNotebook}
                className="-my-1 flex h-5 w-5 translate-x-1 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:pointer-events-none disabled:opacity-40"
                aria-label={t('memo.tag.create')}
                title={t('memo.tag.create')}
              >
                <PlusIcon className="h-3.5 w-3.5" weight="light" />
              </button>
            )}
          </div>
        )}
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
                className="tag-collapse-track"
                data-collapsed={tag.collapsedByAncestor || undefined}
                aria-hidden={tag.collapsedByAncestor || undefined}
              >
              <ContextMenu>
              <ContextMenuTrigger asChild>
              <div
                ref={(node) => {
                  if (node) {
                    rowRefs.current.set(tag.id, node);
                  } else {
                    rowRefs.current.delete(tag.id);
                  }
                }}
                role="button"
                tabIndex={tag.collapsedByAncestor ? -1 : 0}
                onPointerDown={(event) => handlePointerDown(event, tag.id)}
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
                  'group relative flex h-7 w-full cursor-pointer select-none items-center gap-0 rounded-lg pr-2 text-left text-sm transition-[color]',
                  hideSelectionStyle
                    ? 'text-[var(--foreground)] hover:bg-[var(--muted)]'
                    : isSelected
                    ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
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
                  className="relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center -ml-1 mr-1"
                  // `#` 图标当作独立控件: 单击展开/折叠, 不触发行
                  // 选中也不进入拖拽。键盘 Enter/Space 同样可用。
                  // hover/focus 时 [data-tag-icon]:hover 规则加深展开三角
                  // ── 视觉提示该图标可点击。
                  role={hasChildren ? 'button' : undefined}
                  tabIndex={hasChildren ? 0 : undefined}
                  aria-expanded={
                    hasChildren ? !collapsedTagIdSet.has(tag.id) : undefined
                  }
                  aria-label={
                    hasChildren
                      ? collapsedTagIdSet.has(tag.id)
                        ? t('memo.tag.expand')
                        : t('memo.tag.collapse')
                      : undefined
                  }
                  style={{
                    color: isSelected && !hideSelectionStyle
                      ? 'var(--primary-foreground)'
                      : undefined,
                  }}
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
                    className="h-3.5 w-3.5"
                    weight="bold"
                  />
                  {hasChildren && (
                    <span
                      aria-hidden
                      className="tag-expand-indicator pointer-events-none absolute bottom-[3px] right-[3px] h-0 w-0 border-b-[5px] border-l-[5px] border-l-transparent"
                    />
                  )}
                </span>
                {editingTagId === tag.id ? (
                  <input
                    autoFocus
                    value={editingTagName}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setEditingTagName(e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void commitRename(tag, editingTagName);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingTagId(null);
                      }
                    }}
                    onBlur={() => void commitRename(tag, editingTagName)}
                    className="min-w-0 flex-1 rounded-md bg-[var(--background)] px-0 text-sm outline-none ring-1 ring-[var(--primary)]"
                  />
                ) : (
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      isHidden && !isSelected && 'text-[var(--muted-foreground)]',
                    )}
                  >
                    {tag.name}
                  </span>
                )}
                {batchMode ? (
                  <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      void confirmDeleteTag(tag);
                    }}
                    className="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--destructive)] focus:text-[var(--destructive)]"
                    aria-label={t('memo.tag.batchDelete', { path: tag.fullPath } satisfies I18nParams)}
                    title={t('memo.tag.batchDelete', { path: tag.fullPath } satisfies I18nParams)}
                  >
                    <SquareMinus className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <span
                    className={cn(
                      'ml-2 shrink-0 tabular-nums text-xs text-[var(--muted-foreground)]',
                      isSelected && 'text-[var(--foreground)]/70',
                    )}
                  >
                    {tag.count}
                  </span>
                )}
                {isDropBefore && (
                  <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-[var(--brand)]" />
                )}
                {isDropAfter && (
                  <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-[var(--brand)]" />
                )}
              </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <ContextMenuItem
                  onClick={() => startRename(tag)}
                  className="h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                >
                  {t('memo.tag.rename')}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => void pinTag(tag)}
                  className="h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                >
                  {t('memo.tag.pin')}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => setBatchMode(true)}
                  className="h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                >
                  {t('memo.tag.batchManage')}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => setDeletingTag(tag)}
                  className="h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-[var(--destructive)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                >
                  {t('memo.tag.delete')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
              </div>
            );
          })}
          </>
        )}
      </div>

      {/* Tag 删除确认弹窗 ── 右键菜单"删除" 触发。 子树命中时给出更
          严肃的提示文案, 明确告诉用户删除是整棵子树 + body 里所有
          #tag 都会被移除, 无法撤销。 */}
      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          if (isCreatingTag) return;
          setCreateDialogOpen(open);
          if (!open) {
            setNewTagParentPath('');
            setNewTagName('');
            setCreateTagError(null);
          }
        }}
      >
        <DialogContent className="w-[460px]">
          <DialogHeader className="pr-7">
            <DialogTitle>{t('memo.tag.createTitle')}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreateTag();
            }}
          >
            <div className="flex items-center gap-2">
              <div className="w-1/3 shrink-0">
                <Select
                  value={newTagParentPath || '__root__'}
                  disabled={isCreatingTag}
                  onValueChange={(value) => {
                    setNewTagParentPath(value === '__root__' ? '' : value);
                    if (createTagError) setCreateTagError(null);
                  }}
                >
                  <SelectTrigger className="bg-[var(--background)]">
                    <span className="min-w-0 truncate text-left">
                      {newTagParentPath
                        ? `#${newTagParentPath}`
                        : t('memo.tag.createParent')}
                    </span>
                  </SelectTrigger>
                  <SelectContent align="start" className="max-h-64 w-[240px] overflow-y-auto">
                    <SelectItem value="__root__">
                      {t('memo.tag.createNoParent')}
                    </SelectItem>
                    {tagOptions.map((tag) => (
                      <SelectItem key={tag.id} value={tag.fullPath}>
                        <span
                          className="block truncate"
                          style={{ paddingLeft: `${tag.depth * 12}px` }}
                        >
                          #{tag.fullPath}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-w-0 flex-1 items-center rounded-lg border border-input bg-background focus-within:border-[var(--primary)]">
                <span className="pl-3 text-sm text-[var(--muted-foreground)]">#</span>
                <Input
                  id="new-tag-name"
                  autoFocus
                  value={newTagName}
                  disabled={isCreatingTag}
                  placeholder={t('memo.tag.createPlaceholder')}
                  aria-label={t('memo.tag.createName')}
                  onChange={(event) => {
                    setNewTagName(event.target.value);
                    if (createTagError) setCreateTagError(null);
                  }}
                  className="border-0 pl-1 focus-visible:border-0"
                  aria-invalid={Boolean(createTagError)}
                />
              </div>
            </div>
            {createTagError && (
              <p className="mt-1.5 text-xs text-[var(--destructive)]">
                {createTagError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={isCreatingTag}
                onClick={() => setCreateDialogOpen(false)}
              >
                {t('memo.tag.createCancel')}
              </Button>
              <Button
                type="submit"
                disabled={isCreatingTag || !newTagName.trim()}
              >
                {isCreatingTag
                  ? t('memo.tag.creating')
                  : t('memo.tag.createConfirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deletingTag !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingTag(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memo.tag.deleteConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {(() => {
                const target = deletingTag;
                if (!target) return '';
                // 子孙节点数 (含自身=1 之外的层级, 即 tag.<...>) ── 用
                // tagOptions 派生, 不走后端 IPC。 子树命中 0 个就显示
                // "leaf" 文案, 1+ 个就显示 "withChildren" 文案。
                const subtreeCount = tagOptions.filter(
                  (opt) =>
                    opt.fullPath !== target.fullPath &&
                    opt.fullPath.startsWith(`${target.fullPath}/`),
                ).length;
                if (subtreeCount === 0) {
                  return t('memo.tag.deleteConfirmLeaf', { path: target.fullPath } satisfies I18nParams);
                }
                return t('memo.tag.deleteConfirmWithChildren', {
                  path: target.fullPath,
                  count: subtreeCount,
                } satisfies I18nParams);
              })()}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setDeletingTag(null)}
            >
              {t('memo.tag.deleteCancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deletingTag;
                if (!target) return;
                setDeletingTag(null);
                void confirmDeleteTag(target);
              }}
            >
              {t('memo.tag.deleteConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {dragGhost && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[110] flex items-center gap-2 rounded-md border border-[var(--primary)] bg-[var(--card)] px-2 text-sm opacity-50 shadow-lg"
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
    </>
  );
}
