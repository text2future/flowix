'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { ChevronRight, FoldVertical, MoreHorizontal } from 'lucide-react';
import { CaretRightIcon, FolderOpenIcon, FolderSimpleIcon } from '@phosphor-icons/react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { files, type DocTreeItem } from '@platform/tauri/client';
import { openPath } from '@platform/tauri/opener';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { DROPDOWN_DIVIDER_SKIN } from '@shared/ui/dropdown-divider';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { canonicalPath } from '@/lib/path';
import {
  flattenVisibleTree,
  type FolderTreeController,
  type VisibleTreeNode,
} from '@features/memo/components/use-folder-tree';
import { FileTypeIcon } from '@features/memo/components/file-type-icon';
import { useI18n } from '@/lib/i18n';

const TREE_EDGE_GUTTER = 6;
const ITEM_INLINE_PADDING = 6;
const ITEM_ICON_SIZE = 16;
const INDENT_PER_LEVEL = 20;
const FOLDER_MENU_CLASS =
  'min-w-[188px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const FOLDER_MENU_ITEM_CLASS =
  'h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const FOLDER_MENU_DIVIDER_CLASS = 'mx-1 my-1 h-px bg-[var(--border-popup)] opacity-60';

type FileTreeFileIcon = ComponentType<{ path: string; className?: string }>;
type FileTreeFolderIcon = ComponentType<{ expanded: boolean; className?: string }>;

/** Unix epoch 毫秒 → "YYYY-MM-DD HH:mm" (本地时区)；null → "—"。 */
function formatTimestamp(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 资料文件夹文件树 (中间列) ── VSCode 风格。
 *
 * - 惰性展开: 后端单层列举, 展开 folder 时才拉子级 (`useFolderTree`)。
 * - 缩进: depth × 20px 外边距; 展开的 folder 子树沿父级图标中心显示
 *   竖向引导线。folder 默认显示 FolderSimple, hover 时原位替换成展开箭头。
 * - 交互: folder 行单击切展开; 文件单击后通过 Browser Column 导航用例打开，
 *   由统一的 document surface 按类型处理文本、图片和不支持的文件。
 * - 右键菜单: 新建笔记 / 新建文件夹 (folder 上), 重命名, 删除, 复制
 *   路径, 在 Finder 显示。写操作走 `files.*` IPC, 成功后局部 `refresh`
 *   父目录。
 * - header 与 MemoList 同构高度 (Mac h-12 / Win h-9 由外层 titlebar
 *   组件负责), 这里只渲染标题行 + 树体。
 */
export function FolderFileTree({
  folderPath,
  folderName,
  embedded = false,
  onRequestClose,
  activeFilePath = null,
  expandToActiveFile = true,
  className,
  layout = 'fill',
  treeViewportClassName,
  onFileSelect,
  onFileOpenInNewTab,
  tree,
  fileIcon: FileIcon = FileTypeIcon,
  folderIcon: FolderIcon,
}: {
  folderPath: string;
  folderName: string;
  embedded?: boolean;
  onRequestClose?: () => void;
  activeFilePath?: string | null;
  /** Popover trees start collapsed even when the open document is nested. */
  expandToActiveFile?: boolean;
  className?: string;
  /** `content` lets a popover size to its contents while constraining its viewport. */
  layout?: 'fill' | 'content';
  treeViewportClassName?: string;
  onFileSelect?: (filePath: string, scopePath: string) => void;
  onFileOpenInNewTab?: (filePath: string) => void;
  tree: FolderTreeController;
  /** Optional icon renderers let the resource tree use its own visual language. */
  fileIcon?: FileTreeFileIcon;
  folderIcon?: FileTreeFolderIcon;
}) {
  const { t } = useI18n();
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  // 新建/重命名行的受控输入态: null = 无进行中的行内编辑。
  const [draftRow, setDraftRow] = useState<{ parentPath: string; kind: 'file' | 'folder'; value: string } | null>(null);
  const [renaming, setRenaming] = useState<{ item: DocTreeItem; value: string } | null>(null);
  // 「…」按钮下拉采用受控单开: 同一时刻只允许一个行菜单展开,
  // 点击其他按钮 / 其他位置时由 DropdownMenu 的 pointerdown 收起逻辑驱动 onOpenChange(false)。
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // The persisted document may be nested below a collapsed folder. Once the
  // root has loaded, expand its parent chain so the restored selection is
  // actually visible in the tree.
  useEffect(() => {
    if (!expandToActiveFile || tree.loading || !activeFilePath) return;
    void tree.expandTo(activeFilePath);
  }, [activeFilePath, expandToActiveFile, tree.expandTo, tree.loading]);

  // 滚动 / 缩放时收起「…」下拉 (对齐右键菜单的消失逻辑, DropdownMenu 自身不含此逻辑)。
  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [openMenuId]);

  const visibleNodes = useMemo(() => flattenVisibleTree(tree), [tree]);

  const openDocument = useCallback((item: DocTreeItem) => {
    onFileSelect?.(item.fullPath, folderPath);
  }, [folderPath, onFileSelect]);

  const handleDelete = useCallback(async (item: DocTreeItem) => {
    const ok = await files.delete(item.fullPath, folderPath);
    if (!ok) {
      toast.error(t('memo.fileTree.deleteFailed'));
      return;
    }
    const parent = item.fullPath.slice(0, item.fullPath.replace(/\/+$/, '').lastIndexOf('/'));
    await tree.refresh(parent || folderPath);
    toast.success(t('memo.fileTree.deleted', { name: item.name }));
  }, [folderPath, t, tree]);

  const handleRename = useCallback(async (item: DocTreeItem, nextName: string) => {
    const trimmed = nextName.trim();
    setRenaming(null);
    if (!trimmed || trimmed === item.name) return;
    if (item.type === 'document') {
      try {
        await files.rename(item.fullPath, trimmed, folderPath);
      } catch (error) {
        toast.error(t(String(error).includes('FILE_EXISTS') ? 'memo.fileTree.nameConflict' : 'memo.fileTree.renameFailed'));
        return;
      }
    } else {
      // folder 重命名需要递归拷贝, 首版不支持 ── 提示走 Finder。
      toast.info(t('memo.fileTree.renameFolderUnsupported'));
      return;
    }
    const normalizedPath = canonicalPath(item.fullPath);
    const parent = normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
    await tree.refresh(parent || folderPath);
    toast.success(t('memo.fileTree.renamed', { name: trimmed }));
  }, [folderPath, t, tree]);

  const handleCreate = useCallback(async (parentPath: string, kind: 'file' | 'folder', name: string) => {
    const trimmed = name.trim();
    setDraftRow(null);
    if (!trimmed) return;
    try {
      const created = kind === 'file'
        ? await files.createDocument(parentPath, trimmed)
        : await files.createFolder(parentPath, trimmed);
      if (!created) {
        toast.error(t('memo.fileTree.createFailed'));
        return;
      }
    } catch (error) {
      toast.error(t(String(error).includes('FILE_EXISTS') ? 'memo.fileTree.nameConflict' : 'memo.fileTree.createFailed'));
      return;
    }
    await tree.refresh(parentPath);
  }, [t, tree]);

  const handleCopyPath = useCallback(async (item: DocTreeItem) => {
    try {
      await navigator.clipboard.writeText(item.fullPath);
      toast.success(t('memo.fileTree.pathCopied'));
    } catch {
      toast.error(t('memo.fileTree.copyFailed'));
    }
  }, [t]);

  const handleReveal = useCallback((item: DocTreeItem) => {
    void openPath(item.type === 'folder' ? item.fullPath : item.fullPath.slice(0, item.fullPath.lastIndexOf('/')));
  }, []);

  const closeLabel = tree.error ? t('memo.fileTree.unreadable') : folderName;
  const contentSized = layout === 'content';

  // 保留每个 folder 的子树容器, 让收起也能从当前高度过渡到 0。
  // 子项仍由 nodes 缓存提供, 因此收起再展开不会重复请求已加载的目录。
  const renderTreeItems = (items: DocTreeItem[], depth: number): ReactNode[] => items.map((item) => {
    const isFolder = item.type === 'folder';
    const itemKey = canonicalPath(item.fullPath);
    const isExpanded = tree.expanded.has(itemKey);
    const children = isFolder ? (tree.nodes.get(itemKey)?.children ?? []) : [];
    const openable = !isFolder;
    const isActive = !isFolder && !!activeFilePath
      && canonicalPath(activeFilePath) === canonicalPath(item.fullPath);
    const DefaultFolderIcon = isExpanded ? FolderOpenIcon : FolderSimpleIcon;
    const isRenamingRow = renaming?.item.id === item.id;
    const creationParentPath = isFolder
      ? item.fullPath
      : item.fullPath.slice(0, item.fullPath.lastIndexOf('/')) || folderPath;

    return (
      <Fragment key={item.id}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              role={isFolder ? 'treeitem' : openable ? 'button' : undefined}
              aria-expanded={isFolder ? isExpanded : undefined}
              tabIndex={0}
              title={item.fullPath}
              onClick={() => (isFolder ? tree.toggle(item.fullPath) : openDocument(item))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  if (isFolder) tree.toggle(item.fullPath);
                  else if (openable) openDocument(item);
                }
              }}
              className={cn(
                'folder-file-tree__item group relative flex h-7 items-center rounded-lg px-1.5 text-left text-[13px] font-normal leading-[1.6] text-[color-mix(in_oklch,var(--foreground)_95%,transparent)] transition-colors duration-150',
                isFolder || openable ? 'cursor-pointer' : 'cursor-default',
                isActive
                  ? 'bg-[var(--muted)]'
                  : 'hover:bg-[var(--muted)]',
              )}
              style={{
                marginLeft: TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL,
                width: `calc(100% - ${TREE_EDGE_GUTTER * 2 + depth * INDENT_PER_LEVEL}px)`,
              }}
            >
              {isRenamingRow ? (
                <>
                  {isFolder ? (
                    FolderIcon ? (
                      <FolderIcon
                        expanded={isExpanded}
                        className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
                      />
                    ) : (
                      <DefaultFolderIcon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
                    )
                  ) : (
                    <FileIcon
                      path={item.name}
                      className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
                    />
                  )}
                  <input
                    autoFocus
                    value={renaming.value}
                    onChange={(event) => setRenaming({ item: renaming.item, value: event.target.value })}
                    onBlur={() => void handleRename(renaming.item, renaming.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleRename(renaming.item, renaming.value);
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    className="ml-1.5 h-5 w-full min-w-0 border-0 bg-transparent px-0 text-[13px] font-normal text-[var(--foreground)] outline-none"
                  />
                </>
              ) : (
                <>
                  {isFolder ? (
                    <span className="relative h-4 w-4 shrink-0">
                      <CaretRightIcon
                        aria-hidden="true"
                        className={cn(
                          'absolute inset-0 m-auto h-3 w-3 text-[var(--muted-foreground)] opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
                          isExpanded && 'rotate-90',
                        )}
                      />
                      {FolderIcon ? (
                        <FolderIcon
                          expanded={isExpanded}
                          className="absolute inset-0 h-4 w-4 text-[var(--muted-foreground)] transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                        />
                      ) : (
                        <DefaultFolderIcon className="absolute inset-0 h-4 w-4 text-[var(--muted-foreground)] transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0" />
                      )}
                    </span>
                  ) : (
                    <FileIcon
                      path={item.name}
                      className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
                    />
                  )}
                  <span className="ml-1.5 min-w-0 flex-1 truncate">
                    {item.name}
                  </span>
                  <DropdownMenu
                    open={openMenuId === item.id}
                    onOpenChange={(open) => setOpenMenuId(open ? item.id : null)}
                  >
                    <DropdownMenuTrigger
                      asChild
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        aria-label={t('memo.fileTree.moreActions')}
                        title={t('memo.fileTree.moreActions')}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                        className={cn(
                          'absolute right-1 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)] transition-opacity hover:text-[var(--foreground)] group-hover:opacity-100 data-[state=open]:opacity-100',
                          isActive ? 'opacity-100' : 'opacity-0',
                        )}
                      >
                        <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="bottom" className={FOLDER_MENU_CLASS}>
                      <div className="select-text rounded-lg px-2 py-1 text-[11px] leading-[1.6] text-[var(--muted-foreground)]">
                        <div className="flex items-center gap-0.5">
                          <span className="opacity-70">{t('memo.fileTree.createdAt')}</span>
                          <span className="tabular-nums">{formatTimestamp(item.createdMs)}</span>
                        </div>
                        <div className="flex items-center gap-0.5">
                          <span className="opacity-70">{t('memo.fileTree.updatedAt')}</span>
                          <span className="tabular-nums">{formatTimestamp(item.modifiedMs)}</span>
                        </div>
                      </div>
                      <div role="separator" aria-hidden="true" className={FOLDER_MENU_DIVIDER_CLASS} />
                      <DropdownMenuItem
                        onClick={() => setDraftRow({ parentPath: creationParentPath, kind: 'file', value: '' })}
                        className={FOLDER_MENU_ITEM_CLASS}
                      >
                        {t('memo.fileTree.newDocument')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDraftRow({ parentPath: creationParentPath, kind: 'folder', value: '' })}
                        className={FOLDER_MENU_ITEM_CLASS}
                      >
                        {t('memo.fileTree.newFolder')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setRenaming({ item, value: item.name })}
                        className={FOLDER_MENU_ITEM_CLASS}
                      >
                        {t('memo.fileTree.rename')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void handleCopyPath(item)}
                        className={FOLDER_MENU_ITEM_CLASS}
                      >
                        {t('memo.fileTree.copyPath')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleReveal(item)}
                        className={FOLDER_MENU_ITEM_CLASS}
                      >
                        {t('memo.fileTree.reveal')}
                      </DropdownMenuItem>
                      <div role="separator" aria-hidden="true" className={FOLDER_MENU_DIVIDER_CLASS} />
                      <DropdownMenuItem
                        onClick={() => void handleDelete(item)}
                        className={cn(FOLDER_MENU_ITEM_CLASS, 'text-[var(--destructive)]')}
                      >
                        {t('memo.fileTree.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className={FOLDER_MENU_CLASS}>
            {!isFolder && onFileOpenInNewTab && (
              <ContextMenuItem onClick={() => onFileOpenInNewTab(item.fullPath)} className={FOLDER_MENU_ITEM_CLASS}>
                {t('memo.fileTree.openInNewTab')}
              </ContextMenuItem>
            )}
            <div className="select-text rounded-lg px-2 py-1 text-[11px] leading-[1.6] text-[var(--muted-foreground)]">
              <div className="flex items-center gap-0.5">
                <span className="opacity-70">{t('memo.fileTree.createdAt')}</span>
                <span className="tabular-nums">{formatTimestamp(item.createdMs)}</span>
              </div>
              <div className="flex items-center gap-0.5">
                <span className="opacity-70">{t('memo.fileTree.updatedAt')}</span>
                <span className="tabular-nums">{formatTimestamp(item.modifiedMs)}</span>
              </div>
            </div>
            <div role="separator" aria-hidden="true" className={FOLDER_MENU_DIVIDER_CLASS} />
            <ContextMenuItem
              onClick={() => setDraftRow({ parentPath: creationParentPath, kind: 'file', value: '' })}
              className={FOLDER_MENU_ITEM_CLASS}
            >
              {t('memo.fileTree.newDocument')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => setDraftRow({ parentPath: creationParentPath, kind: 'folder', value: '' })}
              className={FOLDER_MENU_ITEM_CLASS}
            >
              {t('memo.fileTree.newFolder')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => setRenaming({ item, value: item.name })}
              className={FOLDER_MENU_ITEM_CLASS}
            >
              {t('memo.fileTree.rename')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => void handleCopyPath(item)}
              className={FOLDER_MENU_ITEM_CLASS}
            >
              {t('memo.fileTree.copyPath')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => handleReveal(item)}
              className={FOLDER_MENU_ITEM_CLASS}
            >
              {t('memo.fileTree.reveal')}
            </ContextMenuItem>
            <div role="separator" aria-hidden="true" className={FOLDER_MENU_DIVIDER_CLASS} />
            <ContextMenuItem
              onClick={() => void handleDelete(item)}
              className={cn(FOLDER_MENU_ITEM_CLASS, 'text-[var(--destructive)]')}
            >
              {t('memo.fileTree.delete')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {isFolder && children.length > 0 && (
          <div
            className="folder-file-tree__subtree"
            data-expanded={isExpanded}
            aria-hidden={!isExpanded}
            style={{
              '--folder-file-tree-guide-left': `${TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL + ITEM_INLINE_PADDING + ITEM_ICON_SIZE / 2}px`,
            } as CSSProperties}
          >
            <div className="folder-file-tree__subtree-inner">
              <div className="folder-file-tree__subtree-items">
                {isExpanded ? renderTreeItems(children, depth + 1) : null}
              </div>
            </div>
          </div>
        )}
      </Fragment>
    );
  });

  return (
    <div className={cn(
      'relative flex min-h-0 flex-col select-none bg-[var(--card)] text-[var(--foreground)]',
      contentSized ? 'h-fit' : 'h-full',
      className,
      embedded && 'border-l-0',
    )}>
      {/* 标题行 ── 标题右侧下拉菜单用于在访达中显示当前资料文件夹。 */}
      <div className="flex items-center justify-between px-2 py-1.5 gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-0">
          {embedded && onRequestClose && (
            <button
              type="button"
              aria-label="收起文件树"
              title="收起文件树"
              onClick={onRequestClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          )}
          <div
            className="truncate text-sm font-medium text-[var(--foreground)]"
            title={tree.error ? t('memo.fileTree.unreadable') : folderPath}
          >
            {closeLabel}
          </div>
        </div>
        <div className="flex items-center gap-0 shrink-0">
          <button
            type="button"
            aria-label={t('memo.fileTree.collapseAll')}
            title={t('memo.fileTree.collapseAll')}
            onClick={() => tree.collapseAll()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            <FoldVertical aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          {tree.loading && (
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border border-[var(--muted-foreground)]/40 border-t-transparent" />
          )}
        </div>
      </div>
      {/* 与 AgentConversationList 同款分割线, 落在 root 文件夹标题与子级列表之间 */}
      <hr className={cn('mx-2', DROPDOWN_DIVIDER_SKIN)} />
      <div className={cn(
        'relative min-h-0',
        contentSized ? 'flex-none' : 'flex-1',
      )}>
        <OverlayScrollbar
          className={cn(
            contentSized ? 'h-auto' : 'h-full',
            treeViewportClassName,
          )}
          scrollerClassName={cn(
            contentSized ? 'h-auto overflow-y-auto' : 'h-full overflow-y-auto',
            treeViewportClassName,
            'py-1',
          )}
          onScroll={(event) => setShowScrollTopHint(event.currentTarget.scrollTop > 0)}
        >
          {visibleNodes.length === 0 && !tree.loading && (
            <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
              {tree.error ? t('memo.fileTree.unreadableHint') : t('memo.fileTree.empty')}
            </div>
          )}
          <div className="folder-file-tree__items">
            {renderTreeItems(tree.rootChildren, 0)}
            {/* 新建行 ── 跟在目标 folder 的子级之后。简化: 渲染在列表末尾,
                首版可接受 (VSCode 是原地插入)。 */}
            {draftRow && (
              <div
                className="folder-file-tree__item flex h-7 items-center pr-2"
                style={{
                  marginLeft: TREE_EDGE_GUTTER + (findDepth(visibleNodes, draftRow.parentPath) + 1) * INDENT_PER_LEVEL,
                }}
              >
                {draftRow.kind === 'folder' ? (
                  FolderIcon ? (
                    <FolderIcon
                      expanded={false}
                      className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
                    />
                  ) : (
                    <FolderSimpleIcon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
                  )
                ) : (
                  <FileIcon
                    path={draftRow.value}
                    className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
                  />
                )}
                <input
                  autoFocus
                  value={draftRow.value}
                  placeholder={draftRow.kind === 'file' ? t('memo.fileTree.newNote') : t('memo.fileTree.newFolder')}
                  onChange={(event) => setDraftRow({ ...draftRow, value: event.target.value })}
                  onBlur={() => void handleCreate(draftRow.parentPath, draftRow.kind, draftRow.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleCreate(draftRow.parentPath, draftRow.kind, draftRow.value);
                    if (event.key === 'Escape') setDraftRow(null);
                  }}
                  className="ml-1.5 h-5 w-full min-w-0 border-0 bg-transparent px-0 text-[13px] font-normal text-[var(--foreground)] outline-none"
                />
              </div>
            )}
          </div>
        </OverlayScrollbar>
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-3 bg-gradient-to-b from-[color-mix(in_oklch,var(--foreground)_3%,transparent)] to-transparent transition-opacity duration-200',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
    </div>
  );
}

function findDepth(nodes: VisibleTreeNode[], parentPath: string): number {
  const canonicalParent = canonicalPath(parentPath).replace(/\/+$/, '');
  const hit = nodes.find(({ item }) => canonicalPath(item.fullPath) === canonicalParent);
  return hit?.depth ?? -1;
}
