'use client';

import { collectionDefaultIcon } from '@features/collection/public/appearance-api';

import { CollectionNoteFilterSlot } from '@shared/ui/collection-note-filter-slot';

/**
 * 集合外壳 ── **文件夹与集合文件共用的唯一一套框架**。
 *
 * 一个集合就是 **大标题 + tab 条 + 每个 tab 自己的操作区 + 对应数据列表**：
 *
 *   标题   集合名称（独占一行；「···」→「显示标题」控制显隐）+ 副标题（集合属性 `subtitle`）
 *          集合图标叠在头图下半部展示；头图隐藏时回退为标题行内方块图标
 *   一行   [文件树] [表格视图…] [图墙] [列表] ···        [当前 tab 的操作区]
 *   列表   当前 tab 的内容（表格 / 文件树 / 图墙 / 列表）
 *   底部   悬浮 AI 输入框（针对任意集合）
 *
 * 两种入口共用这一套框架，但**文件夹不是集合**（`folderOnly`）：
 *   - `folderPath`：文件夹表面。没有集合体、**不读也不写 `.index.yaml`**，
 *     外观属性（图标 / 头图 / 副标题）来自索引库的 `folder_index` 表，
 *     tab 固定只有「文件」一个。
 *   - `filePath`：直接打开集合文件（`.index.yaml` 等），tab 是表格视图 + 各数据域。
 *
 * 外壳拥有唯一一条 tab 栏与「···」菜单，文件树、笔记视图、图墙、列表平铺。
 * 面板只提供内容与数据操作；表格在集合中关闭内部导航，筛选操作传入外壳操作槽。
 * 状态与写入在 useCollectionSurfaceState，滚动布局在 useCollectionPageLayout。
 * 面板保留挂载、按当前 tab 显隐，集合的头图、标题与导航不会因面板切换重复出现。
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { useTitleEditCaret } from '@shared/hooks/use-title-edit-caret';
import { CollectionScrollContext } from '@shared/ui/collection-scroll-context';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { readCollectionHostTab } from '@/lib/collection-host-tab';
import { FILES_TAB_KEY, noteViewIdFromTabKey } from '@/lib/collection-tab-key';
import { useCollectionTitleVisibility } from '@/lib/collection-title-visibility';
import { registerCollectionBannerControl } from '@/lib/collection-banner-visibility';
import { CollectionNameHeader, collectionHeaderTitle, folderHeaderTitle, useCollectionNameEdit, type CollectionNameEditControls } from '@features/collection/public/title-api';
import { filesHostTab } from '@features/collection/public/tab-api';
import { CollectionActionsSlot, INACTIVE_COLLECTION_ACTIONS_HOST } from '@shared/ui/collection-actions';
import { requestCollectionDatasetFilter, type CollectionDatasetFilterTarget } from '@features/collection/public/dataset-filter-api';
import { files } from '@platform/tauri/client';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { getPropertyIconOption } from '@features/document/public/property-display-api';
import { CollectionIconPickerButton } from './collection-icon-button';
import type { CollectionPanelControls } from '@features/collection/public/panel-api';
import type { FileDisplayIdentity } from '@/lib/file-display-registry';
import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import { CollectionAgentComposer } from './collection-agent-composer';
import { bannerHue } from './collection-banner-tint';
import { CollectionBanner } from './collection-banner';
import { CollectionFilesTab } from './collection-files-tab';
import { CollectionAssetFilterMenu } from './collection-asset-filter-menu';
import { CollectionPanels } from './collection-panels';
import { CollectionHostNavigation } from './collection-host-navigation';
import { FilesTabDatasetMenu } from './files-tab-dataset-menu';
import { COLLECTION_PANEL_FALLBACK } from './collection-panel-fallback';
import { useCollectionSurfaceState, type CollectionHostTabsState } from './use-collection-surface-state';
import { useCollectionPageLayout } from './use-collection-page-layout';
import type { WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';

const TableDocumentView = lazy(() => import('@features/multidimensional-table/public/surface-api').then((module) => ({ default: module.TableDocumentView })));

/** 面板加载中的占位与面板容器共用一份（见 `collection-panel-fallback`）。 */
const PANEL_FALLBACK = COLLECTION_PANEL_FALLBACK;

export interface CollectionShellProps {
  notebookPath: string | null;
  notebookId: string | null;
  fileIdentity?: FileDisplayIdentity;
  expectedCollectionId?: string | null;
  initialViewId?: string | null;
  editable?: boolean;
  onActiveViewChange?: (viewId: string) => void;
  onFilePathChange?: (path: string) => void;
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  /** 直接打开集合文件（`.index.yaml`）时给出。 */
  filePath?: string | null;
  /** 直接打开文件夹时给出：集合缺失可就地建齐；文件树根目录也由它决定。 */
  folderPath?: string | null;
  host: WorkspaceSurfaceRenderContext['host'];
}

export function CollectionShell({ host, filePath: filePathProp = null, folderPath = null, onActiveViewChange, ...tableProps }: CollectionShellProps) {
  const { t } = useI18n();
  const { titleVisible, toggleTitleVisibility } = useCollectionTitleVisibility();
  const { notebookPath, notebookId, expectedCollectionId } = tableProps;
  /**
   * 文件夹表面：没有集合体、没有 `.index.yaml`，只有目录本身。
   * 外观（图标 / 头图 / 副标题）存在 `folder_index` 表里，tab 固定只有一个「文件」。
   */
  const folderOnly = folderPath !== null && filePathProp === null;
  /** 集合体地址：只有直接打开集合文件时才有；文件夹表面没有集合体。 */
  const sourceIndexPath = folderOnly ? '' : (filePathProp ?? '');
  /**
   * 改名后的新地址。改名不动数据域与视图，所以只覆盖路径，不重读集合
   * （重读会把已挂载的面板与当前 tab 打回初始态）。文件夹改名改的是目录本身，
   * 所以单独记一份目录路径。
   */
  const [noteViewId, setNoteViewId] = useState<string | null>(tableProps.initialViewId ?? null);
  const [renamedIndexPath, setRenamedIndexPath] = useState<string | null>(null);
  const [renamedFolderPath, setRenamedFolderPath] = useState<string | null>(null);
  useEffect(() => {
    setRenamedFolderPath(null);
    setRenamedIndexPath(null);
  }, [folderPath, sourceIndexPath]);
  const indexPath = folderOnly ? '' : (renamedIndexPath ?? sourceIndexPath);
  /** 文件夹表面改名 = 目录改名，所以单独记一份目录路径。 */
  const currentFolderPath = folderOnly ? (renamedFolderPath ?? folderPath) : null;
  /** 文件树 tab 的根目录（仅文件夹类型有意义）。 */
  const filesRoot = currentFolderPath ?? '';
  /** 文件树 tab 的数据集位置 = 集合所在文件夹（笔记本相对路径；'' = 笔记本根目录）。位置固定不可改。 */
  const filesFixedFolderPath = notebookPath && currentFolderPath
    ? notebookRelativeDirectoryPath(notebookPath, currentFolderPath) ?? ''
    : '';
  /** 大标题：文件夹显示目录名，集合文件显示文件名（去后缀）。 */
  const headerTitle = useMemo(() => (folderOnly
    ? folderHeaderTitle(currentFolderPath ?? '')
    : collectionHeaderTitle(indexPath)), [currentFolderPath, folderOnly, indexPath]);
  // 操作区的挂载目标由 React ref 同步，异步加载和槽位替换都会通知面板。
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const actionsHost = useMemo(() => ({ target: actionsTarget }), [actionsTarget]);
  const { existing, missing: collectionMissing, domains, tableReady, banner, subtitle, icon, tabs } = useCollectionSurfaceState({
    sourceIndexPath, folderPath, indexPath, currentFolderPath, notebookPath, notebookId, editable: tableProps.editable ?? true, folderOnly,
  });
  const collectionKey = expectedCollectionId ?? existing?.collectionId ?? sourceIndexPath;
  useEffect(() => { setNoteViewId(tableProps.initialViewId ?? null); }, [collectionKey, tableProps.initialViewId]);
  /** 自定义图标（属性图标 URL）：文件夹与集合都从各自的外观属性 `icon` 读。 */
  const defaultIcon = folderOnly ? 'folder' as const : collectionDefaultIcon(existing?.views ?? []);
  const collectionIconSrc = icon.value ? getPropertyIconOption(icon.value)?.src : undefined;
  const { active: activeHostTab, activeDomain, list: hostTabList, mountDomain, selectNoteView } = tabs;
  /** Which panel temporarily owns the shared action slot while its filter menu is open. */
  const [noteFilterTarget, setNoteFilterTarget] = useState<HTMLDivElement | null>(null);
  const noteFilterSlot = useMemo(() => ({ target: noteFilterTarget, setTarget: setNoteFilterTarget }), [noteFilterTarget]);
  const [datasetFilterOwner, setDatasetFilterOwner] = useState<CollectionDatasetFilterTarget | null>(null);
  /** 集合是否可编辑（缺省视为可编辑）。 */
  const editable = tableProps.editable ?? true;

  /**
   * 把「显示头图」的写入口交给 Work 列 header 的「···」菜单。头图的真实状态在
   * 表面状态里（只有它持有属性与写能力），header 在另一棵树上，靠注册表通信。
   * 文件夹表面用目录路径当键，与 `collectionIndexPath` 的换算保持一致。
   */
  const bannerControlKey = folderOnly ? (currentFolderPath ?? '') : indexPath;
  useEffect(() => {
    if (!bannerControlKey) return;
    return registerCollectionBannerControl(bannerControlKey, { visible: banner.visible, toggle: banner.toggleHidden });
  }, [banner.toggleHidden, banner.visible, bannerControlKey]);

  /**
   * 大标题的改名：集合文件改文件名；文件夹改目录名（走了另一条入口，因为文件夹
   * 已经没有集合体，改名不该再经过集合的 mutation 日志）。
   *
   * 两个 hook 都必须在顶层调用（hooks 规则），folderOnly 时把集合那条禁用掉。
   */
  const collectionNameEdit = useCollectionNameEdit({
    filePath: indexPath,
    notebookPath,
    notebookId,
    // 集合身份优先用外部给的，其次用读到的 summary：路径可能被复用，id 不会。
    expectedCollectionId: expectedCollectionId ?? existing?.collectionId ?? null,
    currentName: headerTitle.name,
    editable: editable && !folderOnly && !collectionMissing && indexPath !== '' && notebookPath !== null,
    onRenamed: (nextFilePath) => {
      setRenamedIndexPath(nextFilePath);
      tableProps.onFilePathChange?.(nextFilePath);
    },
  });
  const folderNameEdit = useFolderNameEdit({
    folderPath: currentFolderPath,
    notebookPath,
    currentName: headerTitle.name,
    editable: editable && folderOnly && notebookPath !== null,
    onRenamed: (nextFolderPath) => {
      setRenamedFolderPath(nextFolderPath);
      tableProps.onFilePathChange?.(nextFolderPath);
    },
  });
  const nameEdit = folderOnly ? folderNameEdit : collectionNameEdit;

  /** 表格内置视图 tab 被选中 → 退出宿主 tab。 */
  const handleActiveViewChange = useCallback((viewId: string) => {
    selectNoteView(viewId);
    setNoteViewId(viewId);
    onActiveViewChange?.(viewId);
  }, [onActiveViewChange, selectNoteView]);

  const pageLayout = useCollectionPageLayout(host, activeHostTab === null);

  // The shell owns one action slot for both missing and loaded collections.
  // Files render directly; data panels portal through the same reactive target.
  const hostActions = <CollectionActionsSlot onTargetChange={setActionsTarget}>
    {activeHostTab === 'files' ? <FilesTabDatasetMenu
      fixedFolderPath={filesFixedFolderPath}
      notebookAvailable={Boolean(notebookPath)}
      busy={!editable}
    /> : null}
  </CollectionActionsSlot>;

  const panelControlsRef = useRef<CollectionPanelControls>(null);
  const { addNoteView } = tabs;
  const handleAddNoteView = useCallback((layout: Parameters<typeof addNoteView>[0], fieldId?: string) => {
    if (!editable) return;
    void addNoteView(layout, fieldId).then((viewId) => {
      if (viewId) handleActiveViewChange(viewId);
    });
  }, [editable, handleActiveViewChange, addNoteView]);
  // 文件夹表面只有「文件」一个 tab：tab 条由这一份状态渲染，不就地拼键。
  const navigationTabs: CollectionHostTabsState = folderOnly
    ? { ...tabs, active: FILES_TAB_KEY, list: [filesHostTab(t('collection.filesTab'))] }
    : tabs;
  const noteViews = existing?.views.filter((view) => view.domain === 'notes') ?? [];
  useEffect(() => {
    if (!existing || tableProps.initialViewId) return;
    // 上次停在某个笔记视图（`notes:<id>`）→ 直接把它选回来；键的解析走语法表。
    const storedViewId = noteViewIdFromTabKey(readCollectionHostTab(existing.collectionId) ?? '');
    if (storedViewId && existing.views.some((view) => view.domain === 'notes' && view.id === storedViewId)) {
      setNoteViewId(storedViewId);
    }
  }, [existing, tableProps.initialViewId]);
  const selectedNoteViewId = noteViews.some((view) => view.id === noteViewId) ? noteViewId : existing?.defaultByDomain.notes;
  const hasAssetViews = domains.some((domain) => domain !== 'notes');
  const openDatasetFilter = useCallback((kind: 'notes' | 'assets') => {
    const target: CollectionDatasetFilterTarget = kind === 'notes'
      ? 'notes'
      : activeDomain ?? (hostTabList.some((tab) => tab.domain === 'media') ? 'media' : 'work_documents');
    const targetExists = target === 'notes'
      ? noteViews.length > 0
      : hostTabList.some((tab) => tab.domain === target);
    if (!targetExists) return;
    if (target !== 'notes') mountDomain(target);
    // Filtering is an action on the collection, not navigation: temporarily give
    // the requested panel the shared action slot without selecting its tab.
    setDatasetFilterOwner(target);
    requestCollectionDatasetFilter({ indexPath, target });
  }, [activeDomain, hostTabList, indexPath, mountDomain, noteViews.length]);
  const handleDatasetFilterVisibilityChange = useCallback((target: CollectionDatasetFilterTarget, open: boolean) => {
    setDatasetFilterOwner((current) => {
      if (open) return target;
      return current === target ? null : current;
    });
  }, []);

  const hostTabContent = <CollectionPanels
    tabs={tabs}
    domains={domains}
    filesRoot={filesRoot}
    notebookId={notebookId}
    notebookPath={notebookPath}
    host={host}
    indexPath={indexPath}
    expectedCollectionId={expectedCollectionId ?? existing?.collectionId}
    actionsHost={actionsHost}
    datasetFilterOwner={datasetFilterOwner}
    onDatasetFilterVisibilityChange={handleDatasetFilterVisibilityChange}
    onOpenNoteFilter={noteViews.length > 0 ? () => openDatasetFilter('notes') : undefined}
    editable={editable}
    onSurfaceLifecycleReady={tableProps.onSurfaceLifecycleReady}
    reportPresentation={tableProps.reportPresentation}
  />;

  /** 表格主体：宿主 tab 缺省时就是纯表格。 */
  const tableBody = <Suspense fallback={PANEL_FALLBACK}>
    <TableDocumentView
      {...tableProps}
      expectedCollectionId={expectedCollectionId ?? existing?.collectionId}
      filePath={indexPath}
      onActiveViewChange={handleActiveViewChange}
      initialViewId={noteViewId ?? tableProps.initialViewId}
      showNavigation={false}
      panelControlsRef={panelControlsRef}
      collectionActionsHost={datasetFilterOwner ? datasetFilterOwner === 'notes' ? actionsHost : INACTIVE_COLLECTION_ACTIONS_HOST : activeHostTab === null ? actionsHost : INACTIVE_COLLECTION_ACTIONS_HOST}
      assetFilterMenu={hasAssetViews ? <CollectionAssetFilterMenu source={existing?.source} indexPath={indexPath} notebookPath={notebookPath ?? ''} editable={editable} /> : undefined}
      onDatasetFilterOpenChange={(open) => handleDatasetFilterVisibilityChange('notes', open)}
      onSurfaceLifecycleReady={activeHostTab === null ? tableProps.onSurfaceLifecycleReady : undefined}
      reportPresentation={activeHostTab === null ? tableProps.reportPresentation : undefined}
      showNavTitle={false}
      bannerVisible={banner.visible}
      onToggleBannerVisibility={banner.toggleHidden}
      pageScroll
      collectionAreaMenu
      onActiveLayoutChange={pageLayout.onActiveLayoutChange}
    />
  </Suspense>;

  /**
   * 集合图标的底色色相 ── 仍由标题派生后传给标题行内的回退图标
   * （见 CollectionNameHeader 的 iconHue；`.collection-header-icon-tint` 的
   * 底色本身已改为 4% 前景色混入表面底色，见 styles/collection-banner.css）。
   * 头图可见时图标骑在头图下缘，头图隐藏回退标题行内，两处共用同一份图标样式。
   */
  const headerIconHue = bannerHue(headerTitle.name);
  /** 集合图标（头图下缘 45px 那枚）：可编辑时点击打开属性图标 picker，写入集合属性 `icon`；
   * 不可编辑（缺集合 / 只读）只展示。头图隐藏时同款交互由标题行内图标承担（见 titleIconSlot）。 */
  const headerIconNode = (
    <CollectionIconPickerButton
      defaultIcon={defaultIcon}
      iconSrc={collectionIconSrc}
      editable={editable}
      placement="banner"
      value={icon.value}
      onChange={icon.save}
      onReset={() => icon.save('')}
      changeLabel={t('collection.icon.change')}
      resetLabel={t('collection.icon.reset')}
    />
  );
  /** 头图隐藏时，标题行左侧继续使用头图图标的同款外观；可编辑时保留换图标交互。 */
  const titleIconSlot = (
    <CollectionIconPickerButton
      defaultIcon={defaultIcon}
      iconSrc={collectionIconSrc}
      editable={editable}
      placement="title"
      value={icon.value}
      onChange={icon.save}
      onReset={() => icon.save('')}
      changeLabel={t('collection.icon.change')}
      resetLabel={t('collection.icon.reset')}
    />
  );

  const bannerNode = banner.visible ? (
    // 图标骑在头图下缘：无容器盒，图标本体 h-12 w-12，探出量仍由 -bottom-[11px] 控制，
    // 左移距 left-4（与标题行的 px-4 左缘对齐）。
    // icon 的 z-10 让探出部分盖在标题行上方（父级无 stacking context，直接参与外层比较）。
    <div className="relative">
      <CollectionBanner
        notebookPath={notebookPath}
        notebookId={notebookId}
        title={headerTitle.name}
        scope={banner.scope}
        // 文件夹的头图写在 `folder_index` 表里，与是否「已有集合」无关。
        editable={editable && (existing !== null || folderOnly)}
        selectedImage={banner.selectedImage}
        onSelectImage={banner.selectImage}
      />
      {titleVisible ? (
        <div className="absolute -bottom-[11px] left-12 z-10">
          {headerIconNode}
        </div>
      ) : null}
    </div>
  ) : null;

  const titleNode = titleVisible ? <CollectionNameHeader
    {...headerTitle}
    edit={nameEdit}
    inputLabel={t('collection.nameInputLabel')}
    renameLabel={t('collection.renameName')}
    renameHint={t('collection.renameHint')}
    // 图标已叠到头图上时，标题行内不再重复一份（iconSlot 仅在 showIcon 时渲染）。
    showIcon={!banner.visible}
    iconHue={headerIconHue}
    iconSrc={collectionIconSrc}
    defaultIcon={defaultIcon}
    iconSlot={titleIconSlot}
    subtitle={{
      value: subtitle.value,
      editable: editable && (folderOnly || existing !== null),
      inputLabel: t('collection.subtitleInputLabel'),
      placeholder: t('collection.subtitlePlaceholder'),
      onSave: subtitle.save,
    }}
  /> : null;

  /**
   * 整页滚动轨道上的「钉住层」：头图与大标题同处滚动流，但**横向**用 `sticky left-0`
   * 钉住左缘、宽度恒为面板宽 —— 宽表整页横滚时它们不会跟着跑偏。
   */
  const pinnedRailClass = 'sticky left-0 shrink-0';
  const pinnedRailStyle = { width: 'var(--collection-viewport-w, 100%)' } as const;

  return <CollectionNoteFilterSlot.Provider value={noteFilterSlot}><CollectionScrollContext value={pageLayout.pageScroller}><div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
    {/* 整页滚动容器 ── 头图 / 标题 / tab 条 / 列表**共用同一个滚动区**（所有 tab 一致）：
        从头图一直滚到列表底部。集合内容区上穿 Work 标题栏（`--work-titlebar-h`），
        头图顶部从标题栏底下穿过；头图与标题离场后 tab 条吸在标题栏下沿，各列表自己的
        表头（文件树标题行、表格 thead）紧接着吸在 tab 条下沿。表格也在这个容器里：
        纵向不再自己滚，宽表的横向滚动由整页承担。
        滚动条用 OverlayScrollbar：默认不画、滚动才浮现；底部留白让最后一行
        不被悬浮的 AI 输入框盖住。横向滚动条只在表格（宽表）时出现。 */}
    <OverlayScrollbar
      scrollerRef={pageLayout.setPageScroller}
      horizontalScrollbar={pageLayout.horizontalScrollbar}
      observeContent
      // `collection-page-scroll-frame` 是层级钩子：吸顶的 tab 条（z-30）会盖住
      // 默认 z-2 的滑块，见 styles/overlay-scrollbar.css 末尾那条提权规则。
      className="collection-page-scroll-frame min-h-0 flex-1"
      scrollerClassName="collection-page-scroll flex h-full min-h-0 flex-col pb-[var(--collection-composer-clearance)]"
    >
      {/* 轨道宽度：只有表格版式撑到表格实际宽度（宽表整页横滚时头图 / tab 条
          才有 sticky 的余量）；文件树 / 画廊 / 日历是流式内容，保持面板宽。 */}
      <div
        className="flex shrink-0 flex-col gap-2"
        style={pageLayout.trackStyle}
      >
        {bannerNode ? <div className={pinnedRailClass} style={pinnedRailStyle}>{bannerNode}</div> : null}
        {/* 集合名称 ── 直接打开用大标题独占一行（双击改名）；显隐由「···」→「显示标题」控制 */}
        {titleNode ? <div className={pinnedRailClass} style={pinnedRailStyle}>{titleNode}</div> : null}
        <div className="flex flex-col">
          <CollectionHostNavigation
            tabs={navigationTabs}
            busy={tabs.busy}
            folderOnly={folderOnly}
            source={domains.includes('notes') ? existing?.source : undefined}
            onOpenFieldManager={tableReady ? () => panelControlsRef.current?.openFieldManager() : undefined}
            actions={hostActions}
            editable={editable && (existing !== null || collectionMissing)}
            bannerVisible={banner.visible}
            onToggleBanner={banner.toggleHidden}
            titleVisible={titleVisible}
            onToggleTitle={toggleTitleVisibility}
            noteViews={noteViews}
            viewOrder={existing?.views.map((view) => view.id)}
            activeNoteViewId={selectedNoteViewId}
            onSelectNoteView={handleActiveViewChange}
            onAddNoteView={handleAddNoteView}
          />
          {folderOnly ? <CollectionFilesTab rootPath={filesRoot} notebookId={notebookId} notebookPath={notebookPath} host={host} editable={editable} reportPresentation={tableProps.reportPresentation} />
            : collectionMissing ? tableBody : !existing ? PANEL_FALLBACK : <>
              {tableReady ? <div className={activeHostTab === null ? 'flex flex-col' : 'hidden'}>{tableBody}</div> : null}
              {hostTabContent}
            </>}
        </div>
      </div>
    </OverlayScrollbar>

    <CollectionAgentComposer
      kind={folderOnly ? 'folder' : 'collection'}
      notebookId={notebookId}
      collectionId={folderOnly ? null : (expectedCollectionId ?? existing?.collectionId ?? null)}
      collectionName={headerTitle.name}
      collectionPath={currentFolderPath ?? indexPath}
      indexPath={folderOnly ? null : (indexPath || null)}
      supportsNotes={domains.includes('notes')}
      host={host}
    />
  </div></CollectionScrollContext></CollectionNoteFilterSlot.Provider>;
}

/**
 * 文件夹大标题的改名 —— 改的是目录本身。
 *
 * 与集合改名共用同一份交互约定（双击进入、Enter / 失焦保存、Esc 退出、保存中
 * spinner），但落盘走文件系统的 `rename_folder`：文件夹已经没有集合体，改名
 * 不该再经过集合的 mutation 日志与 revision 校验。目录移动后后端会把
 * `folder_index` 里的外观整棵搬过去，前端缓存由 `folder-index-changed` /
 * `path-moved` 维护。
 */
function useFolderNameEdit({ folderPath, notebookPath, currentName, editable, onRenamed }: {
  folderPath: string | null;
  notebookPath: string | null;
  currentName: string;
  editable: boolean;
  onRenamed?: (nextFolderPath: string) => void;
}): CollectionNameEditControls {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const savingRef = useRef(false);
  const { inputRef, captureCaret } = useTitleEditCaret(editing);
  const unavailable = !editable || busy || !notebookPath || !folderPath;

  const beginEdit = useCallback(() => {
    if (unavailable || savingRef.current) return;
    setDraft(currentName);
    setEditing(true);
  }, [currentName, unavailable]);

  const commit = useCallback(async (raw: string) => {
    setEditing(false);
    const name = raw.trim();
    if (unavailable || savingRef.current || !notebookPath || !folderPath || !name || name === currentName) return;
    if (/[\\/]/.test(name)) {
      toast.error('文件名不能包含路径分隔符');
      return;
    }
    savingRef.current = true;
    setDraft(name);
    setBusy(true);
    try {
      const nextFolderPath = await files.renameFolder(folderPath, name, notebookPath);
      onRenamed?.(nextFolderPath);
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableRename'));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }, [currentName, folderPath, notebookPath, onRenamed, t, unavailable]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft(currentName);
  }, [currentName]);

  return { editing, draft, setDraft, inputRef, captureCaret, beginEdit, commit, cancel, disabled: !editable, busy };
}
