'use client';

/**
 * 集合 tab 条的「···」菜单。
 *
 * 「添加视图」按业务口径分两组，展示结构即业务结构：
 *   - 添加笔记视图 ── 表格/日历/看板/画廊，建在表格数据（笔记）上；
 *   - 添加资料视图 ── 数据域 tab：图墙（媒体域，图/视频）与「列表」（其余文件，
 *                     即原「工作文档」，tab 与入口同名，一处概念一个名字）。
 * 其余入口：
 *   1. 管理视图   ── 管理**全部已添加的 tab**：宿主 tab（文件树/图墙/列表）+ 表格视图，
 *                   可改名（仅视图）、可移除（视图删除 / 数据域移除 tab）
 *   2. 显示标题   ── 显示集合名称；一个集合只有一个名字，与内部有几个数据域无关
 *   3. 显示头图   ── 顶部图片导览的显隐（属性 `banner_hidden`）；与「显示标题」一样
 *                   用眼睛图标表达当前是否可见，而不是图片图标
 *
 * 这个菜单只是**渲染**：向导状态机在 `use-view-add-wizard`（`wizard` 一个对象），
 * 写入动作由调用方提供：工作区集合交给外壳，编辑器内嵌表格交给笔记面板。props 按三块分组，
 * 避免再出现五十个平铺参数：
 *   - `wizard`  ── 添加视图的步骤 / 待选类型 / 换字段目标
 *   - `display` ── 集合级的两个显示开关（标题 / 头图）
 *   - 其余      ── 「管理视图」的列表与视图创建动作
 *
 * 「管理视图」里宿主 tab 的行按 `host:` 前缀区分（`hostTabEditId`），提交改名一律交给
 * 调用方的 `onRenameHostTab`——与 tab 条上的双击改名同一个落点，不各自校验一遍。
 */
import type { ReactNode, RefObject } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DotsThreeIcon, EyeIcon, EyeSlashIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { useI18n } from '@/lib/i18n';
import { hostTabEditId, type CollectionHostTab } from './collection-host-tab';
import type { ViewAddWizard } from './use-view-add-wizard';

/** 集合级的两个显示开关（集合属性 / 全局偏好），由外壳持有真值。 */
export interface CollectionDisplayToggles {
  titleVisible: boolean;
  onToggleTitleVisibility: () => void;
  /** null = 该入口没有头图，不提供开关。 */
  bannerVisible: boolean | null;
  onToggleBannerVisibility?: () => void;
}

interface MenuField { id: string; type: string; property_key?: string; name?: string }
interface MenuView { id: string; name: string }
export interface CollectionViewMenuProps<TableField extends MenuField, TableView extends MenuView> {
  hideTrigger?: boolean;
  fieldManagerAvailable?: boolean;
  editable: boolean;
  saving: boolean;
  canDeleteViews: boolean;
  /** 添加视图的向导状态机（打开 / 步骤 / 待选类型 / 换字段目标）。 */
  wizard: ViewAddWizard;
  display: CollectionDisplayToggles;
  /** 集合外壳提供的宿主 tab（文件树 + 媒体库/列表的视图实例），在「管理视图」里一起管理。 */
  hostTabs: readonly CollectionHostTab[];
  onRemoveHostTab?: (key: string) => void;
  /** 是否允许补数据域 tab（文件夹集合恒可，独立集合需外壳接管）。 */
  canAddDomainTab: boolean;
  domainAdditionsDisabled: boolean;
  /** 添加资料视图（图墙 / 列表按视图实例创建，与笔记视图平行）；缺省时不提供「添加资料视图」。 */
  onRequestAddAssetView?: (kind: 'media_library' | 'work_documents') => void;
  /** 「管理视图」里重命名宿主 tab；缺省时宿主 tab 不提供改名。 */
  onRenameHostTab?: (key: string, name: string) => void;
  /** 创建视图前的字段选择列表。 */
  viewFieldChoices: TableField[];
  /** 日历视图可选的日期来源（笔记内置日期字段 + 只读的系统时间字段）。 */
  calendarDateChoices: readonly { id: string; label: string; readOnly?: boolean }[];
  onSelectCalendarDateField: (fieldId: string) => void;
  statusField?: TableField;
  fieldLabelOf: (field: TableField) => ReactNode;
  onCreateTableView: () => void;
  onCreateGalleryView: () => void;
  onChooseKanbanStatusField: () => void;
  onCreateKanbanViewForStatus: () => void;
  onSelectViewField: (field: TableField) => void;
  onOpenDatasetFieldManager: () => void;
  /** 表格自身视图 tab 的列表与管理；外壳里由 tab 条自己给，因此可省略。 */
  views?: readonly TableView[];
  managingViewId: string | null;
  managingViewName: string;
  onManagingViewNameChange: (name: string) => void;
  manageViewRenameInputRef: RefObject<HTMLInputElement | null>;
  onFinishManageViewRename: (view: Pick<TableView, 'id' | 'name'>, name: string) => void;
  onCancelManageViewRename: () => void;
  onBeginManageViewRename: (view: Pick<TableView, 'id' | 'name'>) => void;
  onRequestDeleteView?: (view: TableView) => void;
}

export function CollectionViewMenu<TableField extends MenuField, TableView extends MenuView>({
  hideTrigger = false, fieldManagerAvailable = true, editable, saving, canDeleteViews, wizard, display,
  hostTabs, onRemoveHostTab, canAddDomainTab, domainAdditionsDisabled,
  onRequestAddAssetView, onRenameHostTab,
  viewFieldChoices, calendarDateChoices, onSelectCalendarDateField, statusField,
  fieldLabelOf, onCreateTableView, onCreateGalleryView,
  onChooseKanbanStatusField, onCreateKanbanViewForStatus, onSelectViewField,
  onOpenDatasetFieldManager, views = [], managingViewId, managingViewName,
  onManagingViewNameChange, manageViewRenameInputRef, onFinishManageViewRename,
  onCancelManageViewRename, onBeginManageViewRename, onRequestDeleteView,
}: CollectionViewMenuProps<TableField, TableView>) {
  const { t } = useI18n();
  const step = wizard.step;
  const fieldPickTitle = wizard.pendingType === 'calendar'
    ? t('collection.wizard.chooseDateField')
    : t('collection.wizard.chooseSelectField');

  // 触发按钮与 tab 同圆角同高（rounded-md / h-7）+ 四周 p-1.5 → 16px 图标撑成 28×28 的正方形；
  // hover / 按下 / 展开态都取 tab 那一档背景色，视觉上和 tab 是同一套控件。
  return <Popover open={wizard.open} anchorRect={wizard.anchorRect} onOpenChange={wizard.setOpen}>
    <PopoverTrigger asChild>
      <button type="button" hidden={hideTrigger} style={hideTrigger ? { display: 'none' } : undefined} disabled={!editable || saving} aria-label={t('collection.display.more')} title={t('collection.display.more')} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)] active:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)] disabled:opacity-40">
        <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    {/* 触发按钮在 tab 行右端，弹层贴它的右缘向左展开，避免越过窗口右边。 */}
    <PopoverContent key={step} align="end" side="bottom" sideOffset={5} fitViewport className={`${step === 'manage' ? 'w-[220px]' : 'w-[190px]'} rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]`}>
      {step === 'kind' ? <div className="space-y-0.5">
        <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">{t('collection.menu.addNoteViews')}</div>
        <button type="button" disabled={!editable || saving} onClick={onCreateTableView} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">{t('collection.viewType.table')}</button>
        <button type="button" disabled={!editable || saving} onClick={() => wizard.chooseType('calendar')} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          {t('collection.viewType.calendar')}<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
        </button>
        <button type="button" disabled={!editable || saving} onClick={() => wizard.chooseType('kanban')} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          {t('collection.viewType.kanban')}<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
        </button>
        <button type="button" disabled={!editable || saving} onClick={onCreateGalleryView} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          {t('collection.viewType.gallery')}
        </button>
        {/* 数据域视图（添加资料视图）：图墙 / 列表按视图实例创建，与笔记视图平行——
            已有几个都还可以再加；缺失的域由外壳补域（首个视图随域一起建）。 */}
        {canAddDomainTab && onRequestAddAssetView && <>
          <div role="separator" aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--border)]" />
          <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">{t('collection.menu.addAssetViews')}</div>
          <button type="button" disabled={domainAdditionsDisabled} onClick={() => {
            wizard.setOpen(false);
            onRequestAddAssetView('media_library');
          }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
            <span>{t('collection.mediaView')}</span>
            <span className="text-xs text-[var(--muted-foreground)]">{t('collection.menu.mediaHint')}</span>
          </button>
          <button type="button" disabled={domainAdditionsDisabled} onClick={() => {
            wizard.setOpen(false);
            onRequestAddAssetView('work_documents');
          }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
            <span>{t('collection.workView')}</span>
          </button>
        </>}
        <div role="separator" aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--border)]" />
        <button type="button" disabled={!editable || saving} onClick={() => wizard.setStep('manage')} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          <span>{t('collection.menu.manageViews')}</span>
          <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
        </button>
        <button type="button" aria-label={display.titleVisible ? t('collection.display.hideTitle') : t('collection.display.title')} aria-pressed={display.titleVisible} onClick={display.onToggleTitleVisibility} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)]">
          <span>{t('collection.display.title')}</span>
          {display.titleVisible
            ? <EyeIcon size={16} weight="bold" className="text-[var(--brand)]" aria-hidden="true" />
            : <EyeSlashIcon size={16} weight="bold" className="text-[var(--muted-foreground)]" aria-hidden="true" />}
        </button>
        {display.bannerVisible !== null ? <button type="button" disabled={!editable || saving} aria-label={display.bannerVisible ? t('collection.display.hideBanner') : t('collection.display.banner')} aria-pressed={display.bannerVisible} onClick={display.onToggleBannerVisibility} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          <span>{t('collection.display.banner')}</span>
          {display.bannerVisible
            ? <EyeIcon size={16} weight="bold" className="text-[var(--brand)]" aria-hidden="true" />
            : <EyeSlashIcon size={16} weight="bold" className="text-[var(--muted-foreground)]" aria-hidden="true" />}
        </button> : null}
      </div> : step === 'manage' ? <div className="space-y-0.5">
        <div className="flex min-w-0 items-center gap-0.5 px-1.5 py-[0.35rem]">
          <button type="button" aria-label={t('collection.menu.backToViewTypes')} className="inline-flex min-h-4 shrink-0 items-center gap-0.5 rounded px-0 text-xs leading-[1.2] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none" onClick={() => wizard.setStep('kind')}>
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="min-w-0 truncate text-xs leading-[1.2] text-[var(--muted-foreground)]">{t('collection.menu.manageViews')}</span>
          </button>
        </div>
        <div className="max-h-[min(60vh,420px)] space-y-0.5 overflow-y-auto">
          {/* 全部已添加的 tab：宿主 tab（文件树 + 媒体库/列表的视图实例）在前，表格视图在后。
              视图型宿主 tab 与表格视图同一套改名交互（铅笔 → 输入框 → 保存/失焦提交）。 */}
          {hostTabs.map((tab) => {
            const hostEditId = hostTabEditId(tab.key);
            const canRename = Boolean(tab.viewId && onRenameHostTab);
            const editing = canRename && managingViewId === hostEditId;
            return <div key={hostEditId} className="flex h-8 w-full min-w-0 items-center gap-1 rounded-lg px-1">
              {editing ? <input
                ref={manageViewRenameInputRef}
                aria-label={t('collection.manage.renameView', { name: tab.label })}
                value={managingViewName}
                disabled={!editable || saving}
                onChange={(event) => onManagingViewNameChange(event.currentTarget.value)}
                onBlur={(event) => onFinishManageViewRename({ id: hostEditId, name: tab.label }, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    onCancelManageViewRename();
                  }
                }}
                className="h-7 min-w-0 flex-1 rounded-md border border-[var(--primary)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none"
              /> : <span className="min-w-0 flex-1 truncate px-1.5 text-sm text-[var(--foreground)]">{tab.label}</span>}
              {editing ? <button
                type="button"
                disabled={!editable || saving}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onFinishManageViewRename({ id: hostEditId, name: tab.label }, managingViewName)}
                className="inline-flex h-7 w-11 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--background)] text-xs text-[var(--primary)] hover:bg-[var(--muted)] disabled:opacity-40"
              >{t('common.save')}</button> : <>
                {canRename && <button type="button" aria-label={t('collection.manage.renameView', { name: tab.label })} title={t('multidimensionalTable.view.rename')} disabled={!editable || saving || managingViewId !== null} onClick={() => onBeginManageViewRename({ id: hostEditId, name: tab.label })} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40">
                  <PencilSimpleIcon size={15} aria-hidden="true" />
                </button>}
                {tab.removable && onRemoveHostTab
                  ? <button type="button" aria-label={t('collection.manage.removeTab', { name: tab.label })} title={t('collection.manage.remove')} disabled={!editable || saving || tab.deleteDisabled} onClick={() => { onRemoveHostTab(tab.key); wizard.close(); }} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-40">
                    <TrashIcon size={15} aria-hidden="true" />
                  </button>
                  : (!canRename ? <span className="shrink-0 px-1.5 text-xs text-[var(--muted-foreground)]">{t('collection.manage.fixed')}</span> : null)}
              </>}
            </div>;
          })}
          {views.map((view) => <div key={view.id} className="flex h-8 w-full min-w-0 items-center gap-1 rounded-lg px-1">
            {managingViewId === view.id ? <input
              ref={manageViewRenameInputRef}
              aria-label={t('collection.manage.renameView', { name: view.name })}
              value={managingViewName}
              disabled={!editable || saving}
              onChange={(event) => onManagingViewNameChange(event.currentTarget.value)}
              onBlur={(event) => onFinishManageViewRename(view, event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancelManageViewRename();
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-[var(--primary)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none"
            /> : <span className="min-w-0 flex-1 truncate px-1.5 text-sm text-[var(--foreground)]">{view.name}</span>}
            {managingViewId === view.id ? <button
              type="button"
              disabled={!editable || saving}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onFinishManageViewRename(view, managingViewName)}
              className="inline-flex h-7 w-11 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--background)] text-xs text-[var(--primary)] hover:bg-[var(--muted)] disabled:opacity-40"
            >{t('common.save')}</button> : <button type="button" aria-label={t('collection.manage.renameView', { name: view.name })} title={t('multidimensionalTable.view.rename')} disabled={!editable || saving || managingViewId !== null} onClick={() => onBeginManageViewRename(view)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40">
              <PencilSimpleIcon size={15} aria-hidden="true" />
            </button>}
            {managingViewId !== view.id && <button type="button" aria-label={t('collection.manage.deleteView', { name: view.name })} title={canDeleteViews ? t('multidimensionalTable.view.delete') : t('collection.manage.deleteDisabled')} disabled={!editable || !canDeleteViews || saving || views.length <= 1 || managingViewId !== null} onClick={() => onRequestDeleteView?.(view)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-40">
              <TrashIcon size={15} aria-hidden="true" />
            </button>}
          </div>)}
        </div>
      </div> : <div className="space-y-0.5">
        <div className="flex min-w-0 items-center gap-0.5 px-1.5 py-[0.35rem]">
          {wizard.configuringViewId ? <span className="min-w-0 truncate px-0.5 text-xs leading-[1.2] text-[var(--muted-foreground)]">{fieldPickTitle}</span> : <button type="button" aria-label={t('collection.menu.backToViewTypes')} className="inline-flex min-h-4 shrink-0 items-center gap-0.5 rounded px-0 text-xs leading-[1.2] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none" onClick={wizard.backToKinds}>
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="min-w-0 truncate text-xs leading-[1.2] text-[var(--muted-foreground)]">{fieldPickTitle}</span>
          </button>}
        </div>
        {wizard.pendingType === 'kanban' && !statusField && <button type="button" disabled={!editable || saving} title={wizard.configuringViewId ? t('collection.kanban.createStatusFieldForView') : t('collection.kanban.createStatusFieldAndView')} onClick={onChooseKanbanStatusField} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          {t('collection.kanban.statusField')}
        </button>}
        {wizard.pendingType === 'kanban' && statusField && statusField.type !== 'Select' && <p className="px-2 py-2 text-xs leading-5 text-[var(--muted-foreground)]">{t('collection.kanban.statusNotSelect')}</p>}
        {viewFieldChoices.map((field) => <button type="button" key={field.id} disabled={!editable || saving} onClick={() => { if (field.property_key === 'status' && !wizard.configuringViewId) onCreateKanbanViewForStatus(); else onSelectViewField(field); }} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          {fieldLabelOf(field)}
        </button>)}
        {wizard.pendingType === 'kanban' && viewFieldChoices.length === 0 && !statusField && <p className="px-2 py-2 text-xs leading-5 text-[var(--muted-foreground)]">{t('collection.kanban.addSelectHint')}</p>}
        {wizard.pendingType === 'calendar' && calendarDateChoices.map((choice) => <button type="button" key={choice.id} disabled={!editable || saving} onClick={() => onSelectCalendarDateField(choice.id)} className="flex h-8 w-full items-center gap-1 rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          <span>{choice.label}</span>
          {choice.readOnly && <span title={t('collection.readOnlySystemTime')} className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--muted)] px-1 py-px text-xs font-normal text-[var(--muted-foreground)]">{t('collection.readOnly')}</span>}
        </button>)}
        <div role="separator" aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--border)]" />
        <button type="button" disabled={!editable || saving || !fieldManagerAvailable} onClick={() => {
          wizard.setOpen(false);
          onOpenDatasetFieldManager();
        }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
          <span>{t('collection.wizard.fieldManager')}</span>
          <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
        </button>
      </div>}
    </PopoverContent>
  </Popover>;
}
