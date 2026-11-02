'use client';

/** Coordinates collection navigation and retained panels.
 * Snapshot subscription, view writes and display properties have separate controllers.
 *
 * 「当前 tab」只有三种取值（键语法见 `lib/collection-tab-key.ts`）：文件树、
 * 某个资料视图、或 `null`（= 表格视图自身）。本 hook 是这些状态与本地偏好之间
 * 的**唯一**写入方，外壳只调用它给出的动作。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { readCollectionHostTab, writeCollectionHostTab } from '@/lib/collection-host-tab';
import {
  ASSET_DOMAINS,
  FILES_TAB_KEY,
  NOTES_TAB_KEY,
  assetTabKey,
  isAssetDomain,
  isNoteTabKey,
  noteTabKey,
  parseAssetTabKey,
  viewIdFromTabKey,
  type AssetDomain,
  type CollectionTabPreference,
  type HostTabKey,
} from '@/lib/collection-tab-key';
import {
  type CollectionDomain,
  type CollectionScope,
  type FolderCollectionSummary,
} from '@features/collection/public/folder-api';
import { filesHostTab, type CollectionHostTab } from '@features/collection/public/tab-api';
import { useCollectionAppearance } from './use-collection-appearance';
import { useCollectionViewCommands } from './use-collection-view-commands';
import { useCollectionSummary } from './use-collection-summary';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

const NO_DOMAINS: readonly CollectionDomain[] = [];

/** 某个资料域的默认视图 tab（默认视图记录了、且该视图还在）；否则 null。 */
function defaultAssetTab(loaded: FolderCollectionSummary, domain: AssetDomain): HostTabKey | null {
  const viewId = loaded.defaultByDomain[domain];
  if (!viewId || !loaded.views.some((view) => view.domain === domain && view.id === viewId)) return null;
  return assetTabKey(domain, viewId);
}

/**
 * 没有可恢复的宿主 tab 时的落点：笔记域优先（= 表格视图），
 * 否则第一个有默认视图的资料域。
 */
function fallbackHostTab(loaded: FolderCollectionSummary): HostTabKey | null {
  if (loaded.domains.includes('notes')) return null;
  for (const domain of ASSET_DOMAINS) {
    const tab = defaultAssetTab(loaded, domain);
    if (tab) return tab;
  }
  return null;
}

export interface CollectionSurfaceStateInput {
  /** 集合体地址（文件夹入口是 `<folder>/.index.yaml`，文件入口是给定路径）。 */
  sourceIndexPath: string;
  /** 文件夹类型集合的根目录；直接打开集合文件时为 null。 */
  folderPath: string | null;
  /** 改名后的集合体地址（改名不动数据域与视图，所以只覆盖路径、不重读）。 */
  indexPath: string;
  currentFolderPath: string | null;
  folderName: string;
  notebookPath: string | null;
  notebookId: string | null;
  editable?: boolean;
}

export interface CollectionBannerState {
  visible: boolean;
  /** 用户指定的头图相对路径（集合属性 `banner_image`）；undefined = 用媒体库第一张。 */
  selectedImage: string | undefined;
  /** 顶部图片导览的取值范围；undefined = 没有媒体域，没有图源。 */
  scope: CollectionScope | undefined;
  busy: boolean;
  toggleHidden: () => void;
  selectImage: (relativePath: string | null) => void;
}

export interface CollectionHostTabsState {
  active: HostTabKey | null;
  busy?: boolean;
  /** 当前激活 tab 的资料域（文件树与表格视图为 null）——面板可见性按域判断。 */
  activeDomain: AssetDomain | null;
  activeViewId: string | null;
  /** 已挂载的宿主面板：首次激活后常挂载，切 tab 只切可见性。 */
  mounted: readonly CollectionDomain[];
  /** 文件树 tab 是否存在（只属于文件夹类型集合，且 `payload.file_tree` 为真）。 */
  showFiles: boolean;
  /** tab 条要渲染的宿主 tab（文件树在前，图墙 / 列表的视图 tab 按实例平铺在后）。 */
  list: CollectionHostTab[];
  select: (key: string) => void;
  /** 表格内置视图被选中 → 退出宿主 tab，并把该笔记视图记为「当前 tab」（一次写入）。 */
  selectNoteView: (viewId: string) => void;
  /** 兜底态点占位 tab：缺集合就地建齐 / 缺域补域，然后上 tab。 */
  activateDomain: (domain: CollectionDomain) => void;
  /** Mount a retained data panel for cross-domain actions without selecting its tab. */
  mountDomain: (domain: CollectionDomain) => void;
  /** 「···」→ 添加资料视图：缺域先补域（默认视图），已有域再建一个视图实例。 */
  addAssetView: (kind: 'media_library' | 'work_documents') => void;
  addNoteView: (layout: TableViewType, fieldId?: string) => Promise<string | null>;
  /** 「管理视图」→ 重命名资料视图 tab。 */
  renameTab: (key: string, name: string) => void;
  /** 「管理视图」→ 调整笔记与资料视图 tab 的共同顺序。 */
  reorderViews: (viewIds: readonly string[]) => void | Promise<void>;
  /** 「管理视图」→ 删除资料视图 tab（所在域最后一个视图会连同域一起移除）。 */
  removeTab: (key: string) => void;
}

export interface CollectionSurfaceState {
  /** 读取结果：null = 加载中，'missing' = 尚无 `.index.yaml`。 */
  summary: FolderCollectionSummary | 'missing' | null;
  existing: FolderCollectionSummary | null;
  missing: boolean;
  domains: readonly CollectionDomain[];
  /** notes 域有可用视图时才挂载表格；单独的资料集合不依赖它。 */
  tableReady: boolean;
  banner: CollectionBannerState;
  /** 大标题下方的副标题：读集合属性 `subtitle`（Text），写入走同一套属性落盘。 */
  subtitle: {
    value: string;
    save: (value: string) => void;
  };
  /** 集合图标：读集合属性 `icon`（Text，属性图标 value），写入走同一套属性落盘。 */
  icon: {
    value: string;
    save: (value: string) => void;
  };
  tabs: CollectionHostTabsState;
}

export function useCollectionSurfaceState({
  sourceIndexPath, folderPath, indexPath, currentFolderPath, folderName, notebookPath, notebookId, editable = true,
}: CollectionSurfaceStateInput): CollectionSurfaceState {
  const { t } = useI18n();
  const isFolderCollection = folderPath !== null;
  /** null = 加载中；'missing' = 尚无 .index.yaml（文件夹入口可在点击域 tab 时就地建齐） */
  const [summary, setSummary] = useCollectionSummary(indexPath, notebookPath, notebookId);
  /** null = 某个表格视图激活；否则是宿主 tab。 */
  const [activeHostTab, setActiveHostTab] = useState<HostTabKey | null>(null);
  const [mountedDomains, setMountedDomains] = useState<CollectionDomain[]>([]);

  const existing = summary !== null && summary !== 'missing' ? summary : null;
  const missing = summary === 'missing';
  const domains = existing?.domains ?? NO_DOMAINS;
  /** 集合身份的稳定标识：优先用 id（改名 / 移动目录后不变）。 */
  const collectionId = existing?.collectionId ?? null;

  /**
   * 打开集合时落在哪个 tab：
   *   - 文件夹入口 → 始终默认文件树；集合文件入口 → 恢复自己的视图偏好；
   *   - 旧记录是域级键（`media` 等）→ 回落到该域的默认视图 tab；
   *   - 没有记录 → **文件夹类型的集合默认落在「文件树」**，其余默认落在表格视图。
   */
  const resolveHostTab = useCallback((loaded: FolderCollectionSummary): HostTabKey | null => {
    if (isFolderCollection && loaded.fileTree) return FILES_TAB_KEY;
    const stored = readCollectionHostTab(loaded.collectionId);
    // 上次停在表格视图（`notes` 或某个 `notes:<id>`）：笔记域还在就回到表格。
    if (stored !== null && (stored === NOTES_TAB_KEY || isNoteTabKey(stored))) {
      return loaded.domains.includes('notes') ? null : fallbackHostTab(loaded);
    }
    if (stored !== null && stored !== FILES_TAB_KEY) {
      // 旧域级键 → 该域的默认视图；视图级键 → 视图还在就用它，丢了也回落到默认视图。
      const parsed = isAssetDomain(stored) ? { domain: stored, viewId: '' } : parseAssetTabKey(stored);
      if (parsed && loaded.domains.includes(parsed.domain)) {
        const viewAlive = parsed.viewId !== ''
          && loaded.views.some((view) => view.domain === parsed.domain && view.id === parsed.viewId);
        if (viewAlive) return assetTabKey(parsed.domain, parsed.viewId);
        const defaultTab = defaultAssetTab(loaded, parsed.domain);
        if (defaultTab) return defaultTab;
      }
    }
    return fallbackHostTab(loaded);
  }, [isFolderCollection]);

  const initializedSourceRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${sourceIndexPath}:${notebookPath}`;
    if (summary === null || initializedSourceRef.current === key) return;
    initializedSourceRef.current = key;
    const tab = summary === 'missing' ? (folderPath ? FILES_TAB_KEY : null) : resolveHostTab(summary);
    setActiveHostTab(tab);
    const parsed = tab ? parseAssetTabKey(tab) : null;
    setMountedDomains(parsed ? [parsed.domain] : []);
  }, [folderPath, notebookPath, resolveHostTab, sourceIndexPath, summary]);

  /**
   * 切换宿主 tab，并把「当前 tab」记到本地偏好里（下次打开直接进入）。
   * `null` 是表格视图自身，统一折成 `notes` 落盘；选中具体笔记视图时由
   * `selectNoteView` 传入该视图的键。
   */
  const applyHostTab = useCallback((
    next: HostTabKey | null,
    options: { collectionKey?: string | null; preference?: CollectionTabPreference } = {},
  ) => {
    setActiveHostTab(next);
    const key = options.collectionKey ?? collectionId;
    if (key) writeCollectionHostTab(key, options.preference ?? next ?? NOTES_TAB_KEY);
  }, [collectionId]);

  /**
   * 文件树 tab 只属于**文件夹类型的集合**：集合体就是这个文件夹，树才有意义。
   * 直接打开集合文件时（包括 `.index.yaml`）即使 `payload.file_tree` 为真也不展示，
   * 因为此时它是一个有自己名字的集合文件，不是某个文件夹的首页。
   */
  const showFilesTab = isFolderCollection && existing !== null && existing.fileTree;
  const tableReady = existing !== null && domains.includes('notes')
    && existing.views.some((view) => view.domain === 'notes');

  const mountDomain = useCallback((domain: CollectionDomain) => {
    setMountedDomains((current) => current.includes(domain) ? current : [...current, domain]);
  }, []);

  // 激活的宿主 tab 被外部移除时回落（视图 / 域已不在集合里 / 文件树不再适用）。
  useEffect(() => {
    if (!activeHostTab || !existing) return;
    if (activeHostTab === FILES_TAB_KEY) {
      if (!showFilesTab) applyHostTab(null);
      return;
    }
    const parsed = parseAssetTabKey(activeHostTab);
    if (!parsed) {
      applyHostTab(null);
      return;
    }
    const viewAlive = existing.domains.includes(parsed.domain)
      && existing.views.some((view) => view.domain === parsed.domain && view.id === parsed.viewId);
    if (viewAlive) return;
    // 视图没了：回落到该域的默认视图；域也没了才退出到表格。
    const fallbackTab = existing.domains.includes(parsed.domain) ? defaultAssetTab(existing, parsed.domain) : null;
    if (fallbackTab) {
      mountDomain(parsed.domain);
      applyHostTab(fallbackTab);
    } else {
      applyHostTab(null);
    }
  }, [activeHostTab, applyHostTab, existing, mountDomain, showFilesTab]);

  /** 切换宿主 tab：面板首次激活时挂载（常挂载，只切可见性）。 */
  const selectTab = useCallback((key: string) => {
    if (key === FILES_TAB_KEY) {
      applyHostTab(FILES_TAB_KEY);
      return;
    }
    const parsed = parseAssetTabKey(key);
    if (!parsed) return;
    mountDomain(parsed.domain);
    applyHostTab(assetTabKey(parsed.domain, parsed.viewId));
  }, [applyHostTab, mountDomain]);

  /** 表格内置视图被选中：退出宿主 tab，并把「当前 tab」记成选中的笔记视图。 */
  const selectNoteView = useCallback((viewId: string) => {
    applyHostTab(null, { preference: noteTabKey(viewId) });
  }, [applyHostTab]);

  const commands = useCollectionViewCommands({ indexPath, notebookPath, currentFolderPath, folderName,
    editable, summary, onSummary: setSummary });
  const { addAssetView: createAssetView, addNoteView: createNoteView, renameView, reorderViews, removeView, busy } = commands;
  const addAssetView = useCallback((kind: 'media_library' | 'work_documents') => {
    const domain = kind === 'media_library' ? 'media' : 'work_documents';
    void createAssetView(domain).then((result) => {
      if (!result) return;
      mountDomain(domain);
      applyHostTab(assetTabKey(domain, result.viewId), { collectionKey: result.summary.collectionId });
    });
  }, [createAssetView, mountDomain, applyHostTab]);
  const addNoteView = useCallback(async (layout: TableViewType, fieldId?: string) => {
    const result = await createNoteView(layout, fieldId);
    if (!result) return null;
    applyHostTab(null, { collectionKey: result.summary.collectionId });
    return result.viewId;
  }, [createNoteView, applyHostTab]);
  const activateDomain = useCallback((domain: CollectionDomain) => {
    if (domain === 'notes') { void addNoteView('table'); return; }
    addAssetView(domain === 'media' ? 'media_library' : 'work_documents');
  }, [addAssetView, addNoteView]);
  const renameTab = useCallback((key: string, name: string) => {
    const id = viewIdFromTabKey(key);
    if (id) void renameView(id, name);
  }, [renameView]);
  const reorderTabs = useCallback((viewIds: readonly string[]) => {
    return reorderViews(viewIds).then(() => undefined);
  }, [reorderViews]);
  const removeTab = useCallback((key: string) => {
    const id = viewIdFromTabKey(key);
    if (!id) return;
    void removeView(id).then((result) => {
      if (!result) return;
      setMountedDomains((current) => current.filter((domain) => result.domains.includes(domain)));
      const removedActiveNotesDomain = isNoteTabKey(key)
        && activeHostTab === null
        && !result.domains.includes('notes');
      if (activeHostTab === key || removedActiveNotesDomain) {
        const next = resolveHostTab(result);
        const asset = next ? parseAssetTabKey(next) : null;
        if (asset) mountDomain(asset.domain);
        applyHostTab(next);
      }
    });
  }, [removeView, activeHostTab, resolveHostTab, mountDomain, applyHostTab]);

  /**
   * tab 条上的宿主 tab：文件树固定在表格视图之前（只在文件夹类型的集合出现），
   * 图墙 / 列表按**视图实例**平铺在后（与笔记视图平行，可多次创建、可改名）。
   * tab 条与「管理视图」由集合外壳渲染，这里只提供数据。
   */
  const hostTabs = useMemo<CollectionHostTab[]>(() => {
    const tabs: CollectionHostTab[] = [];
    if (showFilesTab) tabs.push(filesHostTab(t('collection.filesTab')));
    for (const view of existing?.views ?? []) {
      if (view.domain === 'notes') continue;
      const domain = view.domain as AssetDomain;
      tabs.push({
        key: assetTabKey(domain, view.id),
        label: view.name,
        placement: 'after',
        removable: true,
        domain,
        viewId: view.id,
      });
    }
    return tabs;
  }, [existing, showFilesTab, t]);

  const activeAssetView = useMemo(
    () => (activeHostTab ? parseAssetTabKey(activeHostTab) : null),
    [activeHostTab],
  );

  const { banner, subtitle, icon } = useCollectionAppearance({ existing, indexPath, notebookPath, notebookId,
    isFolderCollection, currentFolderPath, folderName, editable, setSummary });

  return useMemo<CollectionSurfaceState>(() => ({
    summary, existing, missing, domains, tableReady,
    banner, subtitle, icon,
    tabs: {
      active: activeHostTab,
      busy: busy,
      activeDomain: activeAssetView?.domain ?? null,
      activeViewId: activeAssetView?.viewId ?? null,
      mounted: mountedDomains,
      showFiles: showFilesTab,
      list: hostTabs,
      select: selectTab,
      selectNoteView,
      activateDomain,
      mountDomain,
      addAssetView,
      addNoteView,
      renameTab,
      reorderViews: reorderTabs,
      removeTab,
    },
  }), [
    busy, activateDomain, activeAssetView, activeHostTab, addAssetView, addNoteView, mountDomain,
    banner, subtitle, icon, domains, existing, hostTabs, missing, mountedDomains,
    removeTab, renameTab, reorderTabs, selectNoteView, selectTab, showFilesTab, summary, tableReady,
  ]);
}
