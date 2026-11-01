import { useRef, useState, type ReactNode } from 'react';
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
 * 集合 tab 条 ── 一条 strip 上有三段，顺序由 `collectionTabList` 唯一决定：
 * 文件树（前置）→ 笔记视图 → 资料视图。宿主 tab 与笔记视图共用同一套渲染与
 * 就地改名（`HostTabButtons` → `TabStripItem`），也共用同一个 `edit` 实例：
 * 一条 strip 同一时刻只能有一个输入框。
 *
 * 改名与删除的落点都在外壳（hybrid 视图 / 外壳自身的 tab），所以由
 * `useHostTabActions` 统一处理校验与删除确认；「···」菜单复用同一条改名提交，
 * 不与 tab 条各写一套。
 */
export function CollectionHostNavigation({ tabs, actions, editable, bannerVisible, onToggleBanner, titleVisible, onToggleTitle, noteViews = [], activeNoteViewId, onSelectNoteView, onAddNoteView, source, onOpenFieldManager, busy = false }: {
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
  noteViews?: readonly { id: string; name: string }[];
  activeNoteViewId?: string | null;
  onSelectNoteView?: (viewId: string) => void;
  onAddNoteView: (layout: TableViewType, fieldId?: string) => void;
}) {
  const { t } = useI18n();
  const edit = useTabInlineEdit();
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const widthRef = useRef(0);
  const host = useHostTabActions({ edit, renameHostTab: tabs.renameTab, removeHostTab: tabs.removeTab, editable, saving: busy });
  const sections = collectionTabList(tabs.list, noteViews);
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
        <HostTabButtons tabs={sections.before} {...bindings} />
        <HostTabButtons tabs={sections.notes} {...bindings} />
        <HostTabButtons tabs={sections.after} {...bindings} />
      </CollectionTabStrip>
      <CollectionViewMenu tabs={tabs} editable={editable}
        bannerVisible={bannerVisible} onToggleBanner={onToggleBanner}
        titleVisible={titleVisible} onToggleTitle={onToggleTitle}
        onAddNoteView={onAddNoteView} onRequestDelete={host.requestDeleteHostTab}
        onCommitHostTabRename={host.commitHostTabRename}
        source={source} noteViews={noteViews} onOpenFieldManager={onOpenFieldManager} busy={busy} />
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
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={host.cancelDeleteHostTab}>{t('dialog.cancel')}</Button>
          <Button variant="destructive" onClick={host.confirmDeleteHostTab}>{t('dialog.delete')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
