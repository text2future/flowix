import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n';
import { CollectionViewMenu as ViewMenu, useViewAddWizard } from '@features/collection/public/view-menu-api';
import { collectionNoteViewOptions, calendarDateChoices } from '@features/multidimensional-table/public/note-view-options-api';
import { collectionTabList, hostTabKeyFromEditId, isHostTabEditId, useTabInlineEdit } from '@features/collection/public/tab-api';
import type { CollectionHostTabsState } from './use-collection-surface-state';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

/**
 * 外壳版的「···」菜单 ── 把集合外壳的状态接到共用菜单上。
 *
 * 外壳里的 tab 条**全部**由自己渲染（表格的 nav 关闭），所以这里没有「表格自身视图」
 * 那几行：`views` 留空，改名 / 删除只作用于宿主 tab。菜单行的排列与 tab 条共用
 * `collectionTabList`，两处不会各自排一遍。
 *
 * 「管理视图」里的改名与 tab 条双击改名走同一条提交（`onCommitHostTabRename`）：
 * 空名校验、去空格、报错提示只有一份实现。
 */
export function CollectionViewMenu({ tabs, editable, bannerVisible, onToggleBanner,
  titleVisible, onToggleTitle, onAddNoteView, onRequestDelete, onCommitHostTabRename,
  source, noteViews = [], viewOrder, onOpenFieldManager, busy = false }: {
  tabs: CollectionHostTabsState;
  editable: boolean;
  bannerVisible: boolean;
  onToggleBanner: () => void;
  titleVisible: boolean;
  onToggleTitle: () => void;
  onAddNoteView: (layout: TableViewType, fieldId?: string) => void;
  /** 删除确认交给外壳（与 tab 条右键删除同一个对话框）。 */
  onRequestDelete: (tab: { key: string; label: string }) => void;
  /** 改名提交：与 tab 条双击改名同一条路径。 */
  onCommitHostTabRename: (key: string, name: string) => void;
  source?: string;
  noteViews?: readonly { id: string; name: string }[];
  viewOrder?: readonly string[];
  onOpenFieldManager?: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const edit = useTabInlineEdit();
  const wizard = useViewAddWizard({ onClose: edit.end });
  const { statusField, viewFieldChoices } = useMemo(() => collectionNoteViewOptions(source, wizard.pendingType), [source, wizard.pendingType]);
  const sections = useMemo(() => collectionTabList(tabs.list, noteViews, viewOrder), [noteViews, tabs.list, viewOrder]);
  const create = (layout: TableViewType, fieldId?: string) => { wizard.close(); onAddNoteView(layout, fieldId); };
  return <ViewMenu editable={editable} saving={busy} canDeleteViews={false}
    wizard={wizard} display={{ titleVisible, onToggleTitleVisibility: onToggleTitle,
      bannerVisible, onToggleBannerVisibility: onToggleBanner }}
    hostTabs={sections.all} canAddDomainTab domainAdditionsDisabled={!editable || busy}
    onRequestAddAssetView={tabs.addAssetView}
    onRenameHostTab={tabs.renameTab}
    onReorderViews={tabs.reorderViews}
    onRemoveHostTab={(key) => { const tab = sections.all.find((item) => item.key === key); if (tab) onRequestDelete(tab); }}
    viewFieldChoices={viewFieldChoices} calendarDateChoices={calendarDateChoices} statusField={statusField}
    onSelectCalendarDateField={(fieldId) => create('calendar', fieldId)}
    fieldLabelOf={(field) => field.name ?? (field.property_key === 'status' ? t('collection.kanban.statusField') : field.property_key) ?? field.id}
    onCreateTableView={() => create('table')} onCreateGalleryView={() => create('gallery')}
    onChooseKanbanStatusField={() => create('kanban')} onCreateKanbanViewForStatus={() => create('kanban')}
    onSelectViewField={(field) => create(wizard.pendingType ?? 'kanban', field.id)}
    fieldManagerAvailable={Boolean(onOpenFieldManager)} onOpenDatasetFieldManager={() => onOpenFieldManager?.()}
    managingViewId={edit.editingId} managingViewName={edit.name}
    onManagingViewNameChange={edit.setName} manageViewRenameInputRef={edit.inputRef}
    onFinishManageViewRename={(view, name) => {
      edit.end();
      // 外壳的菜单只列宿主 tab（`host:` 前缀）；表格视图的行由表格自己给。
      if (isHostTabEditId(view.id)) onCommitHostTabRename(hostTabKeyFromEditId(view.id), name);
    }}
    onCancelManageViewRename={edit.end} onBeginManageViewRename={(view) => edit.begin(view.id, view.name)} />;
}
