import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import type { NotebookFolderOption } from '@platform/tauri/client';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { DropdownMenuLabel } from '@shared/ui/dropdown-menu';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { useI18n } from '@/lib/i18n';
import { ResourceFolderIcon } from '@features/surface/resource-file-icon';

export function MediaLibraryFilterPanel({
  fileName,
  fileTypes,
  path,
  pathIsAll = false,
  fixedFolderPath,
  folderPickerOpen,
  folderOptions,
  folderOptionsLoading,
  notebookAvailable,
  busy = false,
  applying = false,
  autoFocus = false,
  showLocationMenu = true,
  locationOnly = false,
  /** 类型行显隐（多选，空选=全部）；文件树 tab 的数据集合菜单只有位置行，不传即不显示。 */
  showTypeSelect = true,
  kindOptions,
  onFileNameChange,
  onFileTypesChange,
  onPathChange,
  onPathSelected,
  onFolderPickerOpenChange,
  onReset,
  onApply,
}: {
  fileName: string;
  /** 多选类型：空数组 = 全部（面板类目内）。 */
  fileTypes: string[];
  path: string;
  pathIsAll?: boolean;
  /** Set for folder collections whose location cannot be changed. */
  fixedFolderPath?: string;
  folderPickerOpen: boolean;
  folderOptions: NotebookFolderOption[];
  folderOptionsLoading: boolean;
  notebookAvailable: boolean;
  busy?: boolean;
  applying?: boolean;
  autoFocus?: boolean;
  showLocationMenu?: boolean;
  locationOnly?: boolean;
  showTypeSelect?: boolean;
  onFileNameChange: (value: string) => void;
  onFileTypesChange: (values: string[]) => void;
  onPathChange: (value: string) => void;
  onPathSelected?: (value: string | null) => Promise<boolean | void> | boolean | void;
  onFolderPickerOpenChange: (open: boolean) => void;
  onReset: () => void;
  onApply: () => void;
  /** 面板类目内可选的类型；缺省 = 图片/视频（媒体库面板身份）。 */
  kindOptions?: Array<{ value: string; label: string }>;
}) {
  const { t } = useI18n();
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [typeSelectOpen, setTypeSelectOpen] = useState(false);
  const resolvedKindOptions = kindOptions ?? [
    { value: 'image', label: t('mediaLibrary.images') },
    { value: 'video', label: t('mediaLibrary.videos') },
  ];
  const selectedTypeLabels = resolvedKindOptions
    .filter((option) => fileTypes.includes(option.value))
    .map((option) => option.label);
  const toggleFileType = (value: string) => {
    const next = fileTypes.includes(value)
      ? fileTypes.filter((item) => item !== value)
      : [...fileTypes, value];
    onFileTypesChange(next);
  };
  useEffect(() => {
    if (fixedFolderPath !== undefined && folderPickerOpen) onFolderPickerOpenChange(false);
  }, [fixedFolderPath, folderPickerOpen, onFolderPickerOpenChange]);
  useEffect(() => {
    if (!folderPickerOpen) return;
    setCollapsedFolders(new Set(folderOptions
      .filter((option) => folderOptions.some((candidate) => candidate.relativePath.startsWith(`${option.relativePath}/`)))
      .map((option) => option.relativePath)));
  }, [folderPickerOpen, folderOptions]);
  const selectPath = async (value: string | null) => {
    if (onPathSelected && (await onPathSelected(value)) === false) return;
    onPathChange(value ?? '');
    onFolderPickerOpenChange(false);
  };
  const folderPathLabel = fixedFolderPath !== undefined
    ? fixedFolderPath || '笔记本根目录'
    : (path || pathIsAll) ? (pathIsAll ? t('mediaLibrary.anyFolder') : path) : '空';
  const canClearFolderPath = fixedFolderPath === undefined && Boolean(path || pathIsAll);

  const locationMenu = <Popover open={folderPickerOpen} onOpenChange={onFolderPickerOpenChange}>
        <div data-media-library-location-menu className={`flex min-w-0 items-center gap-0 rounded-lg transition-colors ${busy || !notebookAvailable || fixedFolderPath !== undefined ? '' : folderPickerOpen ? 'bg-[var(--hover-bg)]' : 'hover:bg-[var(--hover-bg)]'}`}>
          <PopoverTrigger asChild>
            <button type="button" disabled={busy || !notebookAvailable || fixedFolderPath !== undefined} className="flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg pl-1.5 text-left text-sm disabled:opacity-50">
              <span className="min-w-0 truncate">{t('multidimensionalTable.autoCollect.browseAndSave')}</span>
              <span className="flex min-w-0 flex-1 items-center justify-end text-[var(--muted-foreground)]">
                {folderPathLabel && <span title={fixedFolderPath !== undefined ? `固定：${folderPathLabel}` : folderPathLabel} className="max-w-[150px] truncate text-right text-xs">{folderPathLabel}</span>}
              </span>
            </button>
          </PopoverTrigger>
          {canClearFolderPath && <button
            type="button"
            disabled={busy}
            aria-label="清空路径"
            title="清空路径"
            onClick={(event) => {
              event.stopPropagation();
              void selectPath('');
            }}
            className="inline-flex h-6 w-4 shrink-0 items-center justify-center rounded-md pl-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:opacity-50"
          ><X className="h-3 w-3" aria-hidden="true" /></button>}
          <PopoverTrigger asChild>
            <button type="button" aria-label={t('multidimensionalTable.autoCollect.browseAndSave')} disabled={busy || !notebookAvailable || fixedFolderPath !== undefined} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] disabled:opacity-50">
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </div>
          <PopoverContent anchorSelector="[data-media-library-location-menu]" side="left" align="start" sideOffset={0} style={{ zIndex: 170 }} className="max-h-[min(60vh,280px)] w-[260px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            <OverlayScrollbar className="max-h-[calc(min(60vh,280px)_-_8px)]" scrollerClassName="max-h-[calc(min(60vh,280px)_-_8px)] overflow-y-auto overflow-x-hidden">
            <DropdownMenuLabel className="px-2">{t('multidimensionalTable.autoCollect.browseLocation')}</DropdownMenuLabel>
            {folderOptionsLoading ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('mediaLibrary.loadingFolders')}</p>
              : <div className="space-y-0.5">
                <button
                  type="button"
                  aria-pressed={pathIsAll}
                  onClick={() => { void selectPath(null); }}
                  className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${pathIsAll ? 'bg-[var(--muted)]' : ''}`}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 pl-2">
                    <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                    <span className="min-w-0 truncate">{t('mediaLibrary.anyFolder')}</span>
                  </span>
                </button>
                {folderOptions.length === 0 ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('mediaLibrary.noFolders')}</p> : folderOptions.filter((option) => {
                  const segments = option.relativePath.split('/');
                  return !segments.slice(0, -1).some((_, index) => collapsedFolders.has(segments.slice(0, index + 1).join('/')));
                }).map((option) => {
                  const folderName = option.relativePath.split('/').filter(Boolean).pop() ?? option.relativePath;
                  const selected = path === option.relativePath;
                  const hasChildren = folderOptions.some((candidate) => candidate.relativePath.startsWith(`${option.relativePath}/`));
                  const collapsed = collapsedFolders.has(option.relativePath);
                  return <div key={option.relativePath} className="flex h-8 min-w-0 items-center rounded-lg pr-2 text-sm hover:bg-[var(--muted)]" style={{ paddingLeft: `${8 + option.depth * 12}px` }}>
                    {hasChildren ? <button
                      type="button"
                      aria-label={`${collapsed ? '展开' : '折叠'}文件夹 ${folderName}`}
                      aria-expanded={!collapsed}
                      onClick={() => setCollapsedFolders((current) => {
                        const next = new Set(current);
                        if (next.has(option.relativePath)) next.delete(option.relativePath);
                        else next.add(option.relativePath);
                        return next;
                      })}
                      className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    ><ChevronRight className={`h-3.5 w-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden="true" /></button>
                      : <span className="w-5 shrink-0" aria-hidden="true" />}
                    <button
                      type="button"
                      title={option.relativePath}
                      aria-pressed={selected}
                      onClick={() => { void selectPath(option.relativePath); }}
                      className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg text-left ${selected ? 'bg-[var(--muted)]' : ''}`}
                    >
                      <ResourceFolderIcon expanded={!collapsed && hasChildren} className="h-[18px] w-[18px] shrink-0" />
                      <span className="min-w-0 truncate">{folderName}</span>
                    </button>
                  </div>;
                })}
              </div>}
            </OverlayScrollbar>
          </PopoverContent>
      </Popover>;

  if (locationOnly) return locationMenu;

  return <>
    <div className="space-y-1">
      {showLocationMenu && locationMenu}
      <p className="agent-thread-card__codex-settings-title">{t('mediaLibrary.filterByType')}</p>
      <label className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
        <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterFileName')}</span>
        <input
          autoFocus={autoFocus}
          value={fileName}
          disabled={busy}
          onChange={(event) => onFileNameChange(event.currentTarget.value)}
          placeholder={t('mediaLibrary.filterFileNamePlaceholder')}
          aria-label={t('mediaLibrary.filterFileName')}
          className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)] disabled:opacity-50"
        />
      </label>
      {showTypeSelect && <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
        <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterType')}</span>
        <Popover open={typeSelectOpen} onOpenChange={setTypeSelectOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={busy}
              className="flex h-8 min-w-0 w-full items-center justify-between gap-1 rounded-lg border border-[var(--border)] bg-transparent px-2 text-left text-sm disabled:opacity-50"
            >
              <span className="min-w-0 truncate">{selectedTypeLabels.length ? selectedTypeLabels.join('、') : t('mediaLibrary.all')}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" side="bottom" sideOffset={4} fitViewport style={{ zIndex: 170 }} className="w-[200px] max-w-[calc(100vw-16px)] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            {resolvedKindOptions.map((option) => {
              const checked = fileTypes.includes(option.value);
              return <button
                key={option.value}
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggleFileType(option.value)}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-[var(--muted)]"
              >
                <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--primary-foreground)]' : 'border-[var(--border)]'}`}>
                  {checked && <Check className="h-3 w-3" aria-hidden="true" />}
                </span>
                <span className="min-w-0 truncate">{option.label}</span>
              </button>;
            })}
          </PopoverContent>
        </Popover>
      </div>}
    </div>
    <div className="mt-2 flex gap-2">
      <button type="button" disabled={busy} className="flex h-8 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--muted)] px-2 text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50" onClick={onReset}>{t('mediaLibrary.reset')}</button>
      <button type="button" disabled={busy} className="flex h-8 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--muted)] px-2 text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50" onClick={onApply}>{applying ? t('mediaLibrary.saveProgress') : t('mediaLibrary.apply')}</button>
    </div>
  </>;
}
