
import { DialogFooter } from '@shared/ui/dialog-footer';
import { useRef, useState, type ReactNode } from 'react';
import { DotsThreeIcon, EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { useI18n } from '@/lib/i18n';
import { noteTabKey, noteViewIdFromTabKey } from '@/lib/collection-tab-key';
import { HostTabButtons, collectionTabList, useHostTabActions, useTabInlineEdit } from '@features/collection/public/tab-api';
import { CollectionTabBar, CollectionTabStrip } from '@shared/ui/collection-tab-bar';
import { CollectionViewMenu } from './collection-view-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import type { CollectionHostTabsState } from './use-collection-surface-state';

/**
 * 文件夹表面的「···」── 只有两条：显示标题、显示头图。
 *
 * 文件夹没有集合体，也就没有「添加视图 / 管理视图 / 字段管理」：那三样都是
 * 集合协议的一部分。留一个独立菜单而不是给共享菜单加开关，是因为共享菜单的
 * 视图向导、管理列表、拖拽排序在文件夹里全都不成立，加了开关也只会留下一堆
 * 永远不会走到的分支。
 */
function FolderDisplayMenu({ editable, bannerVisible, onToggleBanner, titleVisible, onToggleTitle }: {
  editable: boolean;
  bannerVisible: boolean;
  onToggleBanner: () => void;
  titleVisible: boolean;
  onToggleTitle: () => void;
}) {
  const { t } = useI18n();
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" disabled={!editable} aria-label={t('collection.display.more')} title={t('collection.display.more')}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)] active:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)] disabled:opacity-40">
        <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" side="bottom" sideOffset={5} className="w-[190px] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <div className="space-y-0.5">
        <button type="button" aria-label={titleVisible ? t('collection.display.hideTitle') : t('collection.display.title')} aria-pressed={titleVisible} onClick={onToggleTitle} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)]">
          <span>{t('collection.display.title')}</span>
          {titleVisible
            ? <EyeIcon size={16} weight="bold" className="text-[var(--brand)]" aria-hidden="true" />
            : <EyeSlashIcon size={16} weight="bold" className="text-[var(--muted-foreground)]" aria-hidden="true" />}
        </button>
        <button type="button" disabled={!editable} aria-label={bannerVisible ? t('collection.display.hideBanner') : t('collection.display.banner')} aria-pressed={bannerVisible} onClick={onToggleBanner} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          <span>{t('collection.display.banner')}</span>
          {bannerVisible
            ? <EyeIcon size={16} weight="bold" className="text-[var(--brand)]" aria-hidden="true" />
            : <EyeSlashIcon size={16} weight="bold" className="text-[var(--muted-foreground)]" aria-hidden="true" />}
        </button>
      </div>
    </PopoverContent>
  </Popover>;
}

/**
 * 集合 tab 条 ── 固定文件夹 tab 在首位，其余笔记与资料视图按集合顺序排列。
 * `collectionTabList` 同时提供管理菜单顺序。宿主 tab 与笔记视图共用同一套渲染与
 * 就地改名（`HostTabButtons` → `TabStripItem`），也共用同一个 `edit` 实例：
 * 一条 strip 同一时刻只能有一个输入框。
 *
 * 改名与删除的落点都在外壳（hybrid 视图 / 外壳自身的 tab），所以由
 * `useHostTabActions` 统一处理校验与删除确认；「···」菜单复用同一条改名提交，
 * 不与 tab 条各写一套。
 */
export function CollectionHostNavigation({ tabs, actions, editable, bannerVisible, onToggleBanner, titleVisible, onToggleTitle, noteViews = [], viewOrder, activeNoteViewId, onSelectNoteView, onAddNoteView, source, onOpenFieldManager, busy = false, folderOnly = false }: {
  tabs: CollectionHostTabsState;
  source?: string;
  onOpenFieldManager?: () => void;
  busy?: boolean;
  actions: ReactNode;
  editable: boolean;
  bannerVisible: boolean;
  onToggleBanner: () => void;
  titleVisible: boolean;
  onToggleTitle: () => void;
  /** 文件夹表面：tab 只有「文件」，菜单只留显示标题 / 头图。 */
  folderOnly?: boolean;
  noteViews?: readonly { id: string; name: string }[];
  viewOrder?: readonly string[];
  activeNoteViewId?: string | null;
  onSelectNoteView?: (viewId: string) => void;
  onAddNoteView: (layout: TableViewType, fieldId?: string) => void;
}) {
  const { t } = useI18n();
  const edit = useTabInlineEdit();
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const widthRef = useRef(0);
  const host = useHostTabActions({ edit, renameHostTab: tabs.renameTab, removeHostTab: tabs.removeTab, editable, saving: busy });
  const sections = collectionTabList(tabs.list, noteViews, viewOrder);
  const viewScope = tabs.activeDomain !== null
    ? t('collection.viewScope.assets')
    : tabs.active === null ? t('collection.viewScope.notes') : null;
  const bindings = {
    // 表格视图激活时 `tabs.active` 为 null，高亮要回落到当前笔记视图的键。
    activeKey: tabs.active ?? (activeNoteViewId ? noteTabKey(activeNoteViewId) : null),
    editable, saving: busy, edit, menuKey, onMenuKeyChange: setMenuKey,
    widthRef,
    onSelect: (key: string) => {
      const noteViewId = noteViewIdFromTabKey(key);
      if (noteViewId) onSelectNoteView?.(noteViewId);
      else tabs.select(key);
    },
    onBeginRename: host.beginRenameHostTab,
    onCommitRename: host.commitHostTabRename,
    onRequestDelete: host.requestDeleteHostTab,
  };
  return <>
    <CollectionTabBar pinned label={t('collection.tabsLabel')}>
      <CollectionTabStrip>
        <HostTabButtons tabs={sections.all} {...bindings} />
      </CollectionTabStrip>
      {folderOnly
        ? <FolderDisplayMenu editable={editable} bannerVisible={bannerVisible} onToggleBanner={onToggleBanner}
            titleVisible={titleVisible} onToggleTitle={onToggleTitle} />
        : <CollectionViewMenu tabs={tabs} editable={editable}
            bannerVisible={bannerVisible} onToggleBanner={onToggleBanner}
            titleVisible={titleVisible} onToggleTitle={onToggleTitle}
            onAddNoteView={onAddNoteView} onRequestDelete={host.requestDeleteHostTab}
            onCommitHostTabRename={host.commitHostTabRename}
            source={source} noteViews={noteViews} viewOrder={viewOrder} onOpenFieldManager={onOpenFieldManager} busy={busy} />}
      <div aria-hidden="true" className="min-w-0 flex-1" />
      {viewScope ? (
        <span className="shrink-0 px-1 py-1 text-xs text-[var(--muted-foreground)]" data-view-scope={tabs.activeDomain !== null ? 'assets' : 'notes'} aria-label={`${t('collection.viewScope.label')}: ${viewScope}`}>
          {viewScope}
        </span>
      ) : null}
      {actions}
    </CollectionTabBar>
    <Dialog open={host.hostTabPendingDelete !== null} onOpenChange={(next) => { if (!next) host.cancelDeleteHostTab(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('multidimensionalTable.view.delete')}</DialogTitle>
          <DialogDescription>{t('multidimensionalTable.view.deleteConfirm', { name: host.hostTabPendingDelete?.label ?? '' })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={host.cancelDeleteHostTab}>{t('dialog.cancel')}</Button>
          <Button variant="destructive" onClick={host.confirmDeleteHostTab}>{t('dialog.delete')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
