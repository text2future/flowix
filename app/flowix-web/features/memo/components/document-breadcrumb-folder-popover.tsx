'use client';

import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { ResourceFolderIcon } from '@features/surface/public/resource-icon-api';
import { useI18n } from '@/lib/i18n';
import { FolderFileTree } from './folder-file-tree';
import { useFolderTree } from './use-folder-tree';

/** 弹层与树体共用的宽度：树自带 236px，外层别再另算一套。 */
const POPOVER_WIDTH_CLASS = 'w-[min(236px,calc(100vw-2rem))]';
/** 两个弹层共用的外观：圆角、裁切、浮起阴影。 */
const POPOVER_SKIN_CLASS = 'overflow-hidden rounded-xl shadow-[0_8px_30px_-5px_rgb(0_0_0_/_0.28)]';

export interface DocumentBreadcrumbFolderPopoverProps {
  /** 被点击的文件夹段路径，即树根。 */
  folderPath: string;
  /** 树头显示的目录名（面包屑段文案）。 */
  folderName: string;
  /** 当前打开的文档，用于树里高亮。 */
  activeFilePath?: string | null;
  onFileSelect: (filePath: string) => void;
  /** 触发段本身，样式与 aria 文案由面包屑决定。 */
  children: ReactNode;
}

/** 只在弹层真正打开时挂载，未展开的面包屑段不发目录 IPC。 */
function FolderTreeBody({
  folderPath,
  folderName,
  activeFilePath,
  onFileSelect,
  onBack,
}: Omit<DocumentBreadcrumbFolderPopoverProps, 'children'> & {
  /** 下钻态才有：返回被折叠文件夹列表。放在树自己的标题行里，避免文件夹名重复一遍。 */
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const tree = useFolderTree(folderPath);

  return (
    <div className={`${POPOVER_WIDTH_CLASS} overflow-hidden rounded-[inherit]`}>
      <FolderFileTree
        folderPath={folderPath}
        folderName={folderName}
        activeFilePath={activeFilePath}
        expandToActiveFile={false}
        layout="content"
        treeViewportClassName="max-h-[min(376px,calc(100vh-7rem))]"
        tree={tree}
        /* 文件夹用侧边栏「访问空间」的统一图标（静态 folder 轮廓 + hover 换展开箭头），
           不再用 FolderSimple/FolderOpen 那套双态图标。 */
        folderIcon={ResourceFolderIcon}
        /* 下拉窗只用来切换目标，行尾「…」菜单去掉；右键菜单仍保留同一批操作。 */
        showRowMenu={false}
        headerLeading={onBack ? (
          <button
            type="button"
            aria-label={t('breadcrumb.backToCollapsedFolders')}
            title={t('breadcrumb.backToCollapsedFolders')}
            onClick={onBack}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : undefined}
        onFileSelect={onFileSelect}
      />
    </div>
  );
}

/** 面包屑提供触发器（样式与 aria 文案由它决定），展开态只有弹层知道，补回 aria-expanded。 */
function withExpanded(children: ReactNode, open: boolean): ReactNode {
  return isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-expanded'?: boolean }>, { 'aria-expanded': open })
    : children;
}

/**
 * 文档顶栏面包屑的文件夹弹层。
 *
 * 行为对齐仓库面包屑的文件夹弹层：点文件夹名展开同一棵惰性文件树，文件夹
 * 就地展开、继续往里选，选中文件后弹层收起并交给调用方在当前栏打开。
 * 实现是独立一份（仓库弹层可下钻的折叠态、资源图标由那边自己维护），
 * 只共用已经存在的树组件，不再抽象出第三层。
 */
export function DocumentBreadcrumbFolderPopover({
  folderPath,
  folderName,
  activeFilePath = null,
  onFileSelect,
  children,
}: DocumentBreadcrumbFolderPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{withExpanded(children, open)}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className={`w-auto ${POPOVER_SKIN_CLASS} p-0`}
      >
        {open && (
          <FolderTreeBody
            folderPath={folderPath}
            folderName={folderName}
            activeFilePath={activeFilePath}
            onFileSelect={(filePath) => {
              setOpen(false);
              onFileSelect(filePath);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

export interface DocumentBreadcrumbCollapsedItem {
  label: string;
  path: string;
}

export interface DocumentBreadcrumbCollapsedPopoverProps {
  /** 被折叠在 `···` 里的中间文件夹段（不含根段与当前文件）。 */
  items: readonly DocumentBreadcrumbCollapsedItem[];
  /** 当前打开的文档，进入某层文件夹后用于树里高亮。 */
  activeFilePath?: string | null;
  onFileSelect: (filePath: string) => void;
  /** 面包屑里的 `···` 标记。 */
  children: ReactNode;
}

/**
 * `···` 标记的弹层，逻辑照搬仓库面包屑：先列出所有被折叠的文件夹，点一层
 * 就地换成该层的文件树，选到文件后弹层收起并把路径交给调用方。
 *
 * 返回按钮不单独占一行 —— 它作为 `headerLeading` 融进树自己的标题行，
 * 于是「返回 · 文件夹名 · 折叠全部」是同一条，文件夹名不会连出两遍。
 *
 * 先列文件夹再进树，是因为被折叠的可能有好几层，直接摊开全树的缩进会在
 * 236px 宽度里挤成一团；多一次点击换回清晰的层级。
 */
export function DocumentBreadcrumbCollapsedPopover({
  items,
  activeFilePath = null,
  onFileSelect,
  children,
}: DocumentBreadcrumbCollapsedPopoverProps) {
  const [open, setOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<DocumentBreadcrumbCollapsedItem | null>(null);
  const closeAndOpen = (filePath: string) => {
    setOpen(false);
    onFileSelect(filePath);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        // 收起后忘掉下钻的层级，下次打开回到文件夹列表。
        if (!nextOpen) setSelectedFolder(null);
      }}
    >
      <PopoverTrigger asChild>{withExpanded(children, open)}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        /* 下钻态换成一整棵树，由树自己撑满宽度（它自带 236px），
           外层不再留 p-1，否则树会被裁掉右侧 8px；列表态才需要内边距。 */
        className={`${POPOVER_WIDTH_CLASS} ${POPOVER_SKIN_CLASS} ${selectedFolder ? 'p-0' : 'p-1'}`}
      >
        {selectedFolder ? (
          <FolderTreeBody
            folderPath={selectedFolder.path}
            folderName={selectedFolder.label}
            activeFilePath={activeFilePath}
            onFileSelect={closeAndOpen}
            onBack={() => setSelectedFolder(null)}
          />
        ) : (
          <div className="flex flex-col gap-0.5">
            {items.map((item) => (
              <button
                key={item.path}
                type="button"
                title={item.path}
                onClick={() => setSelectedFolder(item)}
                className="flex h-7 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors hover:bg-[var(--muted)]"
              >
                <ResourceFolderIcon expanded={false} className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
