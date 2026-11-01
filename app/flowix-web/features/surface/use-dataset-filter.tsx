'use client';

import { CollectionNoteFilterSlot } from '@shared/ui/collection-note-filter-slot';

/**
 * 集合里「资料筛选」（图墙 / 列表共用同一份配置）的面板状态机。
 *
 * 这里只管**草稿**：打开菜单时用已保存条件回填，改动先落在草稿上，点「应用」或关闭菜单时写盘；
 * 位置选择（选文件夹 / 全部位置）是即时生效的，因为它本身就是一次显式选择。
 * 写盘与冲突处理在调用方（集合文件会话），这里只把条件算好交出去。
 */
import { useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { CollectionDatasetMenu } from '@shared/ui/collection-dataset-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { files, type NotebookFolderOption } from '@platform/tauri/client';
import { MediaLibraryFilterPanel } from '@features/media-library/public/surface-api';
import { normalizeAssetFilterCondition, type AssetFilterCondition, type AssetFilterSaveOptions } from '@features/collection/public/folder-api';

export interface DatasetFilterOptions {
  /** 已保存的筛选条件（来自集合文件）。 */
  condition: AssetFilterCondition;
  /** 写回条件；返回 false 表示没保存成功（面板保持打开）。 */
  onChange?: (condition: AssetFilterCondition, options: AssetFilterSaveOptions) => Promise<boolean>;
  notebookPath: string;
  /** 固定位置（文件夹类型的集合）；undefined = 位置可改。 */
  fixedFolderPath?: string;
  /** 保存中 / 只读：面板控件禁用。 */
  busy?: boolean;
  /** Reports menu visibility so a collection can temporarily route this panel's action slot. */
  onOpenChange?: (open: boolean) => void;
}

export interface DatasetFilterController {
  /** 已应用的条件（用于「筛选是否生效」判断与提示）。 */
  appliedNameQuery: string;
  appliedPathQuery: string;
  filterCount: number;
  /** 有写回通道才允许编辑（只读集合 / 缺回调时禁用）。 */
  canEdit: boolean;
  activeFileTypes: string[];
  allKindValues: string[];
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Shared open/close behavior, including saving drafts on dismissal. */
  onMenuOpenChange: (open: boolean) => void;
  /** 打开菜单（回填草稿），供「选择数据」「筛选」等入口调用。 */
  openMenu: () => void;
  /** 草稿里是否填了条件（空态文案要区分「没选数据」与「选了但无匹配」）。 */
  hasDraft: boolean;
  /** 渲染面板：`locationOnly` 是筛选菜单里的「只改位置」那一层。 */
  renderPanel: (locationOnly: boolean) => ReactNode;
  /** 渲染整个筛选菜单（触发按钮 + 位置行 + 嵌套的「资料筛选」子菜单）。 */
  renderMenu: (labels: {
    title: string;
    set: string;
    empty: string;
    label: string;
    disabled?: boolean;
    otherFilter?: { label: string; onSelect: () => void; disabled?: boolean };
  }) => ReactNode;
}

export function useDatasetFilter({
  condition, onChange, notebookPath, fixedFolderPath, busy = false, onOpenChange,
}: DatasetFilterOptions): DatasetFilterController {
  const { t } = useI18n();
  const noteFilterSlot = useContext(CollectionNoteFilterSlot);
  const [nameQuery, setNameQuery] = useState('');
  const [typeQuery, setTypeQuery] = useState<string[]>([]);
  const [pathQuery, setPathQuery] = useState('');
  const [pathIsAll, setPathIsAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderOptions, setFolderOptions] = useState<NotebookFolderOption[]>([]);
  const [folderOptionsLoading, setFolderOptionsLoading] = useState(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const setMenuOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChangeRef.current?.(next);
  }, []);

  /** 共享资料筛选的全类目（图墙/列表同一份）：多选类型，图墙与列表各取子集。 */
  const kindOptions = useMemo(() => [
    { value: 'image', label: t('mediaLibrary.images') },
    { value: 'video', label: t('mediaLibrary.videos') },
    { value: 'document', label: t('workDocuments.kind.document') },
    { value: 'spreadsheet', label: t('workDocuments.kind.spreadsheet') },
    { value: 'presentation', label: t('workDocuments.kind.presentation') },
    { value: 'web', label: t('workDocuments.kind.web') },
    { value: 'archive', label: t('workDocuments.kind.archive') },
    { value: 'database', label: t('workDocuments.kind.database') },
  ], [t]);
  const allKindValues = useMemo(() => kindOptions.map((option) => option.value), [kindOptions]);

  const appliedNameQuery = (condition.file_name_contains ?? '').trim().toLocaleLowerCase();
  const appliedPathQuery = (condition.path_contains ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
  const activeFileTypes = useMemo(() => condition.file_types ?? [], [condition.file_types]);
  const hasDraft = nameQuery.trim().length > 0;
  const filterCount = (appliedNameQuery ? 1 : 0)
    + (appliedPathQuery ? 1 : 0)
    + (activeFileTypes.length ? 1 : 0)
    + (condition.path_scope === 'all' ? 1 : 0);

  // Locations save immediately, so there is no location draft to preserve across external updates.
  useEffect(() => {
    setPathQuery(condition.path_contains ?? '');
    setPathIsAll(condition.path_scope === 'all');
  }, [condition.path_contains, condition.path_scope]);

  useEffect(() => {
    if (!folderPickerOpen || !notebookPath) return;
    let active = true;
    setFolderOptionsLoading(true);
    void files.getNotebookFolderOptions(notebookPath).then((options) => {
      if (active) setFolderOptions(options);
    }).catch(() => {
      if (active) setFolderOptions([]);
    }).finally(() => {
      if (active) setFolderOptionsLoading(false);
    });
    return () => { active = false; };
  }, [folderPickerOpen, notebookPath]);

  const save = useCallback(async (pathOverride?: string | null): Promise<boolean> => {
    if (!onChange) return false;
    const nextPathIsAll = pathOverride === null || (pathOverride === undefined && condition.path_scope === 'all');
    const rawCondition = {
      file_name_contains: nameQuery.trim(),
      file_types: typeQuery.length && typeQuery.length < allKindValues.length ? typeQuery : undefined,
      path_contains: nextPathIsAll ? undefined : (pathOverride ?? condition.path_contains ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      path_scope: nextPathIsAll ? 'all' : undefined,
    };
    const next = normalizeAssetFilterCondition(rawCondition as AssetFilterCondition);
    const currentPath = (condition.path_contains ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    // 草稿与已保存条件等价时不必写盘（省一次集合文件读改写）。
    if (pathOverride === undefined
      && next.file_name_contains === (condition.file_name_contains?.trim() || undefined)
      && JSON.stringify(next.file_types ?? []) === JSON.stringify(activeFileTypes.length === allKindValues.length ? [] : activeFileTypes)
      && next.path_contains === (currentPath || undefined)
      && next.path_scope === condition.path_scope) return true;
    return onChange(next, { updateLocation: pathOverride !== undefined });
  }, [activeFileTypes, allKindValues.length, condition.file_name_contains, condition.path_contains, condition.path_scope, nameQuery, onChange, typeQuery]);

  const openMenu = useCallback(() => {
    setNameQuery(condition.file_name_contains ?? '');
    setTypeQuery(activeFileTypes.length === allKindValues.length ? [] : activeFileTypes);
    setPathQuery(condition.path_contains ?? '');
    setPathIsAll(condition.path_scope === 'all');
    setDataOpen(false);
    setMenuOpen(true);
  }, [activeFileTypes, allKindValues.length, condition.file_name_contains, condition.path_contains, condition.path_scope, setMenuOpen]);

  const onMenuOpenChange = useCallback((next: boolean) => {
    if (next) openMenu();
    else {
      setMenuOpen(false);
      setDataOpen(false);
      setFolderPickerOpen(false);
      void save();
    }
  }, [openMenu, save, setMenuOpen]);

  const renderPanel = useCallback((locationOnly: boolean) => (
    <MediaLibraryFilterPanel
      fileName={nameQuery}
      fileTypes={typeQuery}
      path={pathQuery}
      pathIsAll={pathIsAll}
      fixedFolderPath={fixedFolderPath}
      folderPickerOpen={folderPickerOpen}
      folderOptions={folderOptions}
      folderOptionsLoading={folderOptionsLoading}
      notebookAvailable={Boolean(notebookPath)}
      autoFocus={!locationOnly}
      locationOnly={locationOnly}
      showLocationMenu={false}
      busy={busy}
      kindOptions={kindOptions}
      onFileNameChange={setNameQuery}
      onFileTypesChange={setTypeQuery}
      onPathChange={setPathQuery}
      onPathSelected={async (selectedPath) => {
        const saved = await save(selectedPath);
        if (saved) {
          setPathQuery(selectedPath ?? '');
          setPathIsAll(selectedPath === null);
        }
        return saved;
      }}
      onFolderPickerOpenChange={setFolderPickerOpen}
      onReset={() => { setNameQuery(''); setTypeQuery([]); }}
      onApply={() => { void save().then((saved) => { if (saved) setMenuOpen(false); }); }}
    />
  ), [busy, fixedFolderPath, folderOptions, folderOptionsLoading, folderPickerOpen, kindOptions, nameQuery, notebookPath, pathIsAll, pathQuery, save, setMenuOpen, typeQuery]);

  /** 筛选菜单的整体外壳（含嵌套的「资料筛选」子菜单）：状态都在这里，别在调方重写一遍。 */
  const renderMenu = useCallback((labels: {
    title: string;
    set: string;
    empty: string;
    label: string;
    disabled?: boolean;
    otherFilter?: { label: string; onSelect: () => void; disabled?: boolean };
  }) => (
    <CollectionDatasetMenu open={open} onOpenChange={onMenuOpenChange} disabled={labels.disabled} label={labels.label} active={filterCount > 0}
      ignoreOutside={folderPickerOpen || dataOpen} location={renderPanel(true)}
          noteFilter={labels.otherFilter && noteFilterSlot && <div ref={noteFilterSlot.setTarget} />}
          assetFilter={<Popover open={dataOpen} onOpenChange={setDataOpen}>
            <div className={`rounded-lg transition-colors ${dataOpen ? 'bg-[var(--hover-bg)]' : 'hover:bg-[var(--hover-bg)]'}`}>
              <PopoverTrigger asChild>
                <button type="button" className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm">
                  <span>{labels.title}</span>
                  <span className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                    {hasDraft ? labels.set : labels.empty}
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </button>
              </PopoverTrigger>
            </div>
            <PopoverContent side="left" align="start" sideOffset={0} fitViewport style={{ zIndex: 160 }} ignorePopoverOutside={folderPickerOpen} className="max-h-[min(70vh,420px)] w-[320px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              {renderPanel(false)}
            </PopoverContent>
          </Popover>}
    />
  ), [noteFilterSlot, dataOpen, filterCount, folderPickerOpen, hasDraft, open, onMenuOpenChange, renderPanel]);

  return {
    appliedNameQuery, appliedPathQuery, filterCount, canEdit: onChange !== undefined, activeFileTypes, allKindValues,
    open, setOpen: setMenuOpen, openMenu, onMenuOpenChange,
    hasDraft,
    renderPanel, renderMenu,
  };
}
