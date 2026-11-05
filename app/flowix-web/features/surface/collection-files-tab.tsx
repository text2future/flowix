'use client';

/**
 * 集合的「文件树」tab ── 内容就是集合所在目录里的**一层**文件夹与文件。
 *
 * 这个 tab 只属于**文件夹类型的集合**（外壳按 `folderPath` 入口判定），并且还要
 * `.index.yaml` 的 `payload.file_tree` 标记为真。直接打开集合文件时不渲染它，
 * 所以根目录一定是文件夹本身。
 *
 * 刻意不做树形展开：文件夹没有折叠箭头、也不在当前列表里就地展开，点一下直接进入
 * 该文件夹自己的集合视图（同一套外壳、同一套 tab），层级导航交给视图本身完成，
 * 所以这里永远只渲染一层。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { dialogs, files } from '@platform/tauri/client';
import type { DocTreeItem } from '@platform/tauri/client';
import { CollectionResourceIcon } from '@features/collection/public/appearance-api';
import { collectionIndexPathForFolder } from '@features/collection/public/folder-api';
import { ContentIcon, getFileIconKind, HtmlFileIcon } from '@features/content/public/content-api';
import { createPropertySvgIcon } from '@features/document/public/property-type-icon-api';
import { openFolderCollectionFromFolder } from '@features/workspace/public/main-window-api';
import { createLogger } from '@/lib/logger';
import { useI18n } from '@/lib/i18n';
import { formatUpdatedAt } from '@/lib/collection-updated-time';
import { toast } from '@/lib/toast';
import { displayTitleFromFilename } from '@/lib/utils';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { CollectionAreaMenu } from '@shared/ui/collection-area-menu';
import { filesAreaMenuItems } from '@shared/ui/collection-area-menu-items';
import folderIcon from '@/assets/folder-outline.svg?raw';
import type { SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import type { WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';

type SortField = 'name' | 'modifiedMs' | 'sizeBytes';
type FileSort = { field: SortField; direction: 'asc' | 'desc' } | null;

const logger = createLogger('collection-files-tab');

function isNoteItem(item: DocTreeItem): boolean {
  // 旧后端可能不下发 resourceKind，按扩展名兜底。
  if (item.resourceKind) return item.resourceKind === 'note';
  return /\.(md|markdown)$/i.test(item.name);
}

function fileSizeLabel(item: DocTreeItem): string {
  if (item.type === 'folder' || item.sizeBytes == null) return '';
  const bytes = item.sizeBytes;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${Number((bytes / 1024 ** (unitIndex + 1)).toFixed(1))} ${units[unitIndex]}`;
}

/** 文件树行图标 ── 与「访问空间」视图同一套规范：图标统一 18×18。 */
function TreeRowIcon({ item, notebookPath }: { item: DocTreeItem; notebookPath: string | null }) {
  if (item.type === 'folder') {
    return <CollectionResourceIcon filePath={collectionIndexPathForFolder(item.fullPath)} notebookPath={notebookPath}
      className="h-[18px] w-[18px] shrink-0 object-contain"
      fallback={<span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center"
        dangerouslySetInnerHTML={{ __html: folderIcon }} />} />;
  }
  if (/\.(?:index|table|lib|workdocs)\.ya?ml$/i.test(item.name)) {
    return <CollectionResourceIcon filePath={item.fullPath} notebookPath={notebookPath}
      fallbackType={/\.(lib|workdocs)\.ya?ml$/i.test(item.name) ? 'media_library' : 'table'}
      className="h-[18px] w-[18px] shrink-0 object-contain" />;
  }
  if (isNoteItem(item)) {
    return <ContentIcon content={{ kind: 'note' }} className="notebook-file-tree__default-file-icon h-[18px] w-[18px] shrink-0" />;
  }
  if (getFileIconKind(item.fullPath) === 'html') {
    return <HtmlFileIcon className="h-[18px] w-[18px] shrink-0" />;
  }
  return <ContentIcon content={{ kind: 'file', path: item.name }} className="h-[18px] w-[18px] shrink-0" />;
}

/** 文件树行名称 ── 笔记去扩展名展示标题，文件夹与其它文件保留原名。 */
function itemDisplayName(item: DocTreeItem): string {
  if (item.type !== 'folder' && isNoteItem(item)) return displayTitleFromFilename(item.name);
  return item.name;
}

/**
 * 表头列的「字段类型图标」── 与表格表头同源（`createPropertySvgIcon`）：
 * 笔记列用 `note`，更新时间列用 `date`。图标是命令式生成的 18px SVG，
 * 塞进 18px 宿主里，文字起点因此与下方数据行完全对齐。
 */
function HeaderTypeIcon({ kind }: { kind: 'note' | 'date' | 'number' }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const icon = createPropertySvgIcon(kind);
    hostRef.current?.replaceChildren(icon);
    return () => icon.remove();
  }, [kind]);
  return <span ref={hostRef} aria-hidden="true" className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center" />;
}

/**
 * 文件树 tab ── 单层列表，点文件夹进它自己的集合视图，不含任何集合配置。
 */
export function CollectionFilesTab({ rootPath, notebookId, notebookPath, collectionId, host, reportPresentation, editable = true }: {
  rootPath: string;
  notebookId: string | null;
  notebookPath: string | null;
  collectionId?: string | null;
  host: WorkspaceSurfaceRenderContext['host'];
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  editable?: boolean;
}) {
  const { t, language } = useI18n();
  const identity = JSON.stringify([notebookId, notebookPath, collectionId ?? rootPath]);
  const [listing, setListing] = useState<{ identity: string; rootPath: string; items: DocTreeItem[] } | null>(null);
  /** 导入 / 新建完成后就地重读本层目录（文件树只有一层，不需要展开状态）。 */
  const [refreshToken, setRefreshToken] = useState(0);
  const reload = useCallback(() => setRefreshToken((token) => token + 1), []);
  // A renamed folder has the same children. Rebase their addresses immediately
  // so retained rows remain safe to open while the new directory is read.
  const items = useMemo(() => {
    if (!listing || listing.identity !== identity) return null;
    if (listing.rootPath === rootPath) return listing.items;
    const prefix = `${canonicalDirectoryPath(listing.rootPath)}/`;
    const nextPrefix = `${canonicalDirectoryPath(rootPath)}/`;
    return listing.items.map((item) => {
      const path = canonicalPath(item.fullPath);
      return { ...item, fullPath: path.startsWith(prefix) ? nextPrefix + path.slice(prefix.length) : path };
    });
  }, [identity, listing, rootPath]);
  const headerScrollerRef = useRef<HTMLDivElement>(null);

  // Only the active panel receives the reporter. Re-publish when a retained
  // panel becomes active so another tab's loading state cannot linger.
  useEffect(() => {
    reportPresentation?.({ state: items === null
      ? { status: 'loading', loadingMode: 'blocking', retainContent: true }
      : { status: 'ready' } });
  }, [items, reportPresentation]);

  const [sort, setSort] = useState<FileSort>(null);
  useEffect(() => { setSort(null); }, [identity]);
  const sortedItems = useMemo(() => {
    const collator = new Intl.Collator(language, { numeric: true, sensitivity: 'base' });
    return items?.slice().sort((a, b) => {
      const folders = Number(b.type === 'folder') - Number(a.type === 'folder');
      if (folders) return folders;
      if (!sort) return 0;
      const direction = sort.direction === 'asc' ? 1 : -1;
      if (sort.field === 'name') return direction * collator.compare(itemDisplayName(a), itemDisplayName(b));
      if (sort.field === 'sizeBytes' && a.type === 'folder') return 0;
      const left = a[sort.field];
      const right = b[sort.field];
      // Missing metadata stays last within its group in either direction.
      if (left == null || right == null) return left == null ? (right == null ? 0 : 1) : -1;
      return direction * (left - right);
    }) ?? null;
  }, [items, sort, language]);

  const renderHeader = (field: SortField, kind: 'note' | 'date' | 'number', label: string) => {
    const direction = sort?.field === field ? sort.direction : null;
    const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown;
    return <th scope="col" role="columnheader" aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'} className="group/table-column bg-[var(--document-bg)] p-0 text-left font-normal">
      <div className="multidimensional-table__column-header flex min-w-0 items-center transition-colors hover:bg-[var(--muted)]">
      <button type="button" onClick={() => setSort((current) => current?.field === field
        ? current.direction === 'asc' ? { field, direction: 'desc' } : null
        : { field, direction: 'asc' })}
        className="multidimensional-table__cell-content multidimensional-table__header-trigger group flex min-w-0 items-center gap-x-1.5 text-left text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline focus-visible:outline-[var(--brand)]">
        <HeaderTypeIcon kind={kind} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Icon aria-hidden="true" className={`ml-auto h-3.5 w-3.5 shrink-0 ${direction ? 'text-[var(--brand)]' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`} />
      </button>
      </div>
    </th>;
  };

  useEffect(() => {
    let cancelled = false;
    files.getDirChildren(rootPath)
      .then((next) => { if (!cancelled) setListing({ identity, rootPath, items: next }); })
      .catch(() => { if (!cancelled) setListing({ identity, rootPath, items: [] }); });
    return () => { cancelled = true; };
  }, [identity, refreshToken, rootPath]);

  const openItem = useCallback(async (item: DocTreeItem) => {
    if (!notebookId || !notebookPath) return;
    try {
      // 文件夹＝另一层集合视图。这里与**侧边栏点文件夹完全同一条逻辑**
      // （`openFolderCollectionFromFolder` → `folder-collection` 外壳）：
      // 该文件夹已有集合就直接看到它，还没有就先看到文件树，点域 tab 时就地建齐。
      if (item.type === 'folder') {
        await openFolderCollectionFromFolder(notebookId, item.fullPath, host);
        return;
      }
      const { openWorkspaceSurface } = await import('@features/workspace/public/session-opening-api');
      if (item.resourceKind === 'image' || item.resourceKind === 'video') {
        await openWorkspaceSurface({ columnId: host, target: {
          kind: 'media', filePath: item.fullPath, notebookId, notebookPath, resourceKind: item.resourceKind,
        } });
        return;
      }
      await openWorkspaceSurface({
        columnId: host,
        target: { kind: 'external', path: item.fullPath, scopePath: notebookPath, transitionId: null },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('collection.openFailed'));
    }
  }, [host, notebookId, notebookPath, t]);

  /** 本层目录在笔记本内的相对路径（'' = 笔记本根）：新建的笔记落在这里。 */
  const relativeRoot = useMemo(() => {
    if (!notebookPath) return '';
    const root = canonicalDirectoryPath(notebookPath).replace(/\/$/, '');
    const folder = canonicalDirectoryPath(rootPath).replace(/\/$/, '');
    if (folder === root) return '';
    return folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : '';
  }, [notebookPath, rootPath]);
  const canEdit = editable && Boolean(notebookId && notebookPath);

  /** 新建笔记 → 落在本层目录并直接打开（与工作表「新建笔记」同一条链路）。 */
  const createNoteAtRoot = useCallback(async () => {
    if (!notebookId || !notebookPath) return;
    try {
      const { createShellNote } = await import('@features/memo/public/note-creation-api');
      const created = await createShellNote(notebookId, relativeRoot);
      reload();
      const { openWorkspaceSurface } = await import('@features/workspace/public/session-opening-api');
      await openWorkspaceSurface({
        columnId: host,
        target: { kind: 'external', path: created.path, scopePath: notebookPath, transitionId: null },
        options: { initialFocus: 'title', notebookId },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('memo.fileTree.createFailed'));
    }
  }, [host, notebookId, notebookPath, relativeRoot, reload, t]);

  /**
   * 新建文件夹 ── 就地在列表末尾开一行输入（与侧边栏文件树的新建行同一套交互：
   * 名字由用户敲，回车 / 失焦提交，Esc 取消），而不是先建一个「未命名文件夹」。
   */
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const submitFolderDraft = useCallback(async () => {
    const name = folderDraft?.trim() ?? '';
    setFolderDraft(null);
    if (!name) return;
    try {
      await files.createFolder(rootPath, name);
      reload();
    } catch (error) {
      logger.warn('creating collection folder failed', { error, name, rootPath });
      toast.error(String(error).includes('FILE_EXISTS')
        ? t('memo.fileTree.nameConflict')
        : t('memo.fileTree.createFailed'));
    }
  }, [folderDraft, reload, rootPath, t]);

  /** 导入文件… → 复制到本层目录（与侧边栏文件树的导入同一条 IPC）。 */
  const importFiles = useCallback(async () => {
    if (!notebookPath) return;
    const selected = await dialogs.selectFiles({ multiple: true });
    if (!selected?.length) return;
    let failed = 0;
    for (const sourcePath of selected) {
      try {
        await files.importFile(sourcePath, rootPath, notebookPath);
      } catch (error) {
        failed += 1;
        logger.warn('importing file into collection folder failed', { error, sourcePath, rootPath });
      }
    }
    reload();
    if (failed) toast.error(t('collection.areaMenu.importFilesFailed', { count: failed }));
  }, [notebookPath, reload, rootPath, t]);

  /** 导入文件夹… → 整个目录复制进来，导入期间给一条常驻进度提示。 */
  const importFolder = useCallback(async () => {
    if (!notebookPath) return;
    const sourceDirectoryPath = await dialogs.selectImportDirectory();
    if (!sourceDirectoryPath) return;
    const progressToastId = toast.info(t('memo.fileTree.importFolderInProgress'), { duration: Number.POSITIVE_INFINITY });
    try {
      await files.importFolder(sourceDirectoryPath, rootPath, notebookPath);
      reload();
      toast.success(t('memo.fileTree.importFolderSuccess'));
    } catch (error) {
      logger.warn('importing folder into collection folder failed', { error, sourceDirectoryPath, rootPath });
      toast.error(t('memo.fileTree.importFolderFailed'));
    } finally {
      toast.dismiss(progressToastId);
    }
  }, [notebookPath, reload, rootPath, t]);

  const areaMenuItems = useMemo(() => filesAreaMenuItems({
    t,
    onCreateNote: canEdit ? () => { void createNoteAtRoot(); } : undefined,
    onCreateFolder: canEdit ? () => setFolderDraft('') : undefined,
    onImportFiles: canEdit ? () => { void importFiles(); } : undefined,
    onImportFolder: canEdit ? () => { void importFolder(); } : undefined,
  }), [canEdit, createNoteAtRoot, importFiles, importFolder, t]);

  /** 行的更新时间 ── 今天 / 昨天 / 具体日期，精确到分钟；悬停显示完整值。 */
  const updatedLabel = (item: DocTreeItem): string => (item.modifiedMs ? formatUpdatedAt(item.modifiedMs, language, t) : '');
  const syncHeaderScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (headerScrollerRef.current) headerScrollerRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  const renderColumns = () => <colgroup>
    <col />
    <col style={{ width: '12.75rem' }} />
    <col style={{ width: '10rem' }} />
  </colgroup>;

  // Keep the header sticky to the page while the rows own their horizontal scroll.
  // The header's hidden overflow lets it follow the row scroller without widening the page.
  return <div className="min-w-0 pb-2 pl-4 pr-4">
    {/* 右键菜单包住整块列表区域（表头 + 行）：条目按「文件树 tab」给。 */}
    <CollectionAreaMenu items={areaMenuItems}>
    <div ref={headerScrollerRef} className="sticky top-[calc(var(--work-titlebar-h,0px)+var(--collection-tab-bar-h))] z-[1] min-w-0 overflow-hidden bg-[var(--document-bg)]">
      <table role="presentation" className="multidimensional-table collection-files-table w-full min-w-[38rem] table-fixed border-collapse text-sm">
        {renderColumns()}
        <thead className="bg-[var(--document-bg)] text-left text-sm text-[var(--muted-foreground)]">
          <tr>
            {renderHeader('name', 'note', t('collection.filesTab.fileColumn'))}
            {renderHeader('modifiedMs', 'date', t('collection.filesTab.updatedColumn'))}
            {renderHeader('sizeBytes', 'number', t('collection.filesTab.sizeColumn'))}
          </tr>
        </thead>
      </table>
    </div>
    <OverlayScrollbar horizontalScrollbar className="collection-files-tab__scrollbar min-w-0" scrollerClassName="collection-files-tab__scroller min-w-0" onScroll={syncHeaderScroll}>
      <table className="multidimensional-table collection-files-table w-full min-w-[38rem] table-fixed border-collapse text-sm">
        {renderColumns()}
        <thead className="sr-only">
          <tr>
            <th scope="col">{t('collection.filesTab.fileColumn')}</th>
            <th scope="col">{t('collection.filesTab.updatedColumn')}</th>
            <th scope="col">{t('collection.filesTab.sizeColumn')}</th>
          </tr>
        </thead>
        <tbody>
          {items === null || items.length === 0
            ? <tr><td colSpan={3} className="py-6 text-center text-sm text-[var(--muted-foreground)]">
              {items === null ? '…' : t('collection.emptyFiles')}
            </td></tr>
            : sortedItems?.map((item, index) => {
              const updated = updatedLabel(item);
              const cellClass = `${index < items.length - 1 ? 'border-b ' : ''}border-[var(--border)] p-0 align-middle`;
              return <tr key={item.id} onClick={() => void openItem(item)} className="cursor-pointer hover:bg-[var(--muted)]/25">
                <td className={cellClass}>
                  <div className="multidimensional-table__cell-content">
                    <button data-file-row type="button" onClick={(event) => { event.stopPropagation(); void openItem(item); }}
                      className="flex min-w-0 items-center gap-x-1.5 text-left text-sm text-[var(--foreground)] focus-visible:outline focus-visible:outline-[var(--brand)]"
                      title={item.type === 'folder' ? t('collection.openFolder', { name: item.name }) : item.name}>
                      <TreeRowIcon item={item} notebookPath={notebookPath} />
                      <span data-file-name className="min-w-0 flex-1 truncate">{itemDisplayName(item)}</span>
                    </button>
                  </div>
                </td>
                <td className={cellClass}>
                  <div className="multidimensional-table__cell-content text-[var(--foreground)]">
                    <span className="truncate tabular-nums" title={updated || undefined}>{updated}</span>
                  </div>
                </td>
                <td className={cellClass}>
                  <div className="multidimensional-table__cell-content text-[var(--foreground)]">
                    <span className="truncate tabular-nums">{fileSizeLabel(item)}</span>
                  </div>
                </td>
              </tr>;
            })}
          {folderDraft !== null && <tr>
            <td colSpan={3} className="p-0 align-middle">
              <div className="multidimensional-table__cell-content">
                <div className="flex min-w-0 items-center gap-x-1.5">
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[var(--muted-foreground)]"
                    dangerouslySetInnerHTML={{ __html: folderIcon }} />
                  <input
                    ref={draftInputRef}
                    autoFocus
                    value={folderDraft}
                    placeholder={t('memo.fileTree.newFolder')}
                    aria-label={t('memo.fileTree.newFolder')}
                    onChange={(event) => setFolderDraft(event.target.value)}
                    onBlur={() => void submitFolderDraft()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitFolderDraft();
                      // 取消 = 关掉这一行，不落盘（失焦提交因此也要先看草稿是否还在）。
                      if (event.key === 'Escape') setFolderDraft(null);
                    }}
                    className="h-6 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-[var(--foreground)] outline-none"
                  />
                </div>
              </div>
            </td>
          </tr>}
        </tbody>
      </table>
    </OverlayScrollbar>
    </CollectionAreaMenu>
  </div>;
}
