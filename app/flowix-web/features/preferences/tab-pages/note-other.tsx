'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { canonicalDirectoryPath } from '@/lib/path';
import { Select, SelectTrigger, SelectContent, SelectItem } from '@shared/ui/select';
import { Popover, PopoverTrigger, PopoverContent } from '@shared/ui/popover';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { FieldRow, SectionHeader } from '@features/preferences/sections/primitives';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { ResourceFolderIcon } from '@features/surface/public/shell-api';
import { readSelectedNotebookId } from '@/lib/selected-notebook-storage';
import { files, notebooks, type NotebookViewPreferences } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import type { NotebookRecord } from '@platform/tauri/client';

interface NotebookFolderChoice {
  relativePath: string;
  depth: number;
}

/**
 * 偏好页内联开关。项目里没有通用 Switch 组件，尺寸与 `sections/dsh.tsx`、
 * `sections/pi.tsx` 的开关保持一致（h-5 w-9 + 4px 圆点 + primary 轨道）。
 */
function SettingsSwitch({
  checked,
  label,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange ? () => onChange(!checked) : undefined}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--card)] shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}

/**
 * 「笔记 → 笔记设置」偏好页。分组标题「笔记设置」右侧是笔记本选择器（默认对齐当前
 * 正在使用的笔记本）；正文一行 = 主标题「笔记默认位置」+ 副标题「笔记列表的
 * 新建写入文件夹」，右侧是文件夹选择器——per-notebook 设置（存放在笔记本
 * `.flowix/view-preferences.json`）。文件夹下拉复用多维表格
 * 数据集合「位置」选择器的样式（mention-note 浮层 + 层级折叠树）；修改后通过
 * `notebook-view-preferences-changed` 事件同步主窗口的树标记与新建落点。
 */
export function NoteOtherPreferencesTab() {
  const { t } = useI18n();
  const [notebookList, setNotebookList] = useState<NotebookRecord[] | null>(null);
  const [selectedNotebookPath, setSelectedNotebookPath] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<NotebookViewPreferences | null>(null);
  const [folderOptions, setFolderOptions] = useState<NotebookFolderChoice[]>([]);
  const [folderOptionsLoading, setFolderOptionsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  // 两个「访问空间」显示开关：全局设置，落在 ~/.flowix/boot/preference.json，
  // 由 Rust 在列举文件树时读取并过滤。
  const showHiddenFolders = useUserSettingsStore((state) => state.settings.spaceShowHiddenFolders);
  const showSystemFolders = useUserSettingsStore((state) => state.settings.spaceShowSystemFolders);
  const updateSettings = useUserSettingsStore((state) => state.updateSettings);

  const loadForNotebook = useCallback(async (notebookPath: string) => {
    setLoading(true);
    try {
      const prefs = await files.getNotebookViewPreferences(notebookPath);
      setPreferences(prefs);
    } catch (error) {
      console.warn('[NoteOtherPreferencesTab] load notebook view preferences failed:', error);
      setPreferences({ defaultCreateFolder: null });
      toast.error(t('preferences.noteOther.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadFolderOptions = useCallback((notebookPath: string) => {
    setFolderOptionsLoading(true);
    void files.getNotebookFolderOptions(notebookPath).then((options) => {
      setFolderOptions(options);
    }).catch(() => {
      setFolderOptions([]);
    }).finally(() => {
      setFolderOptionsLoading(false);
    });
  }, []);

  useEffect(() => {
    let current = true;
    void notebooks.getAll().then((all) => {
      if (!current) return;
      setNotebookList(all);
      // 优先对齐「用户正在看的笔记本」（主窗口持久化的选中项），其次默认笔记本，
      // 最后兜底第一本。偏好窗口是独立 React 树，只能读持久化快照。
      const currentNotebookId = readSelectedNotebookId();
      const preferred = all.find((item) => item.id === currentNotebookId)
        ?? all.find((item) => item.isDefault)
        ?? all[0];
      if (preferred) {
        setSelectedNotebookPath(preferred.path);
        void loadForNotebook(preferred.path);
      } else {
        setLoading(false);
      }
    }).catch((error) => {
      console.warn('[NoteOtherPreferencesTab] list notebooks failed:', error);
      if (current) {
        setNotebookList([]);
        setLoading(false);
      }
    });
    return () => { current = false; };
  }, [loadForNotebook]);

  // 其他界面（集合标题栏开关、重命名后的 rebase）也会改写默认创建位置，保持同步。
  useEffect(() => {
    if (!selectedNotebookPath) return;
    return subscribe<{ notebookPath: string; defaultCreateFolderChanged: boolean }>(
      'notebook-view-preferences-changed',
      ({ notebookPath, defaultCreateFolderChanged }) => {
        if (defaultCreateFolderChanged
          && canonicalDirectoryPath(notebookPath) === canonicalDirectoryPath(selectedNotebookPath)) {
          void loadForNotebook(selectedNotebookPath);
        }
      },
    );
  }, [selectedNotebookPath, loadForNotebook]);

  const handleNotebookChange = (path: string) => {
    setSelectedNotebookPath(path);
    setPreferences(null);
    setFolderOptions([]);
    setCollapsedFolders(new Set());
    setFolderPickerOpen(false);
    void loadForNotebook(path);
  };

  const handlePickerOpenChange = (open: boolean) => {
    setFolderPickerOpen(open);
    if (open && selectedNotebookPath) loadFolderOptions(selectedNotebookPath);
  };

  const handleDefaultFolderChange = async (relativePath: string | null) => {
    if (!selectedNotebookPath || !preferences || saving) return;
    setSaving(true);
    try {
      await files.setNotebookViewPreferences(selectedNotebookPath, {
        ...preferences,
        defaultCreateFolder: relativePath,
      });
      setPreferences({ ...preferences, defaultCreateFolder: relativePath });
      toast.success(t('preferences.noteOther.saved'));
      setFolderPickerOpen(false);
    } catch (error) {
      console.warn('[NoteOtherPreferencesTab] save default create folder failed:', error);
      toast.error(t('preferences.noteOther.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const selectedNotebook = notebookList?.find(
    (item) => item.path === selectedNotebookPath,
  ) ?? null;
  const currentFolderValue = preferences?.defaultCreateFolder ?? null;
  // 触发按钮展示完整相对路径（根目录用占位文案）；下拉树行内仍只显示末级名。
  const currentFolderLabelText = loading && !preferences
    ? ''
    : currentFolderValue ?? t('preferences.noteOther.rootFolder');

  // 折叠的祖先目录之下的层级不渲染（与数据集合「位置」选择器一致）。
  const visibleFolderOptions = folderOptions.filter((option) => {
    const segments = option.relativePath.split('/');
    return !segments.slice(0, -1).some((_, index) => collapsedFolders.has(segments.slice(0, index + 1).join('/')));
  });

  return (
    <div className="flex flex-col gap-14">
      {/* 组 1：笔记设置 —— 页首标题（右侧笔记本选择器）+ 默认位置 + 笔记索引说明。 */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--divider)] pb-3">
          <SectionHeader title={t('preferences.noteOther.interface')} className="border-0 pb-0" />
          {notebookList !== null && notebookList.length > 1 && (
            <Select value={selectedNotebook?.path ?? ''} onValueChange={handleNotebookChange}>
              {/* 幽灵态触发器：无边框无底色，只保留「当前笔记本名 + 下拉箭头」，
                  hover 时才淡出一层 muted 底色作为可点提示。 */}
              <SelectTrigger
                aria-label={t('preferences.noteOther.notebook.title')}
                className="h-8 w-auto max-w-[240px] shrink-0 justify-start gap-1.5 rounded-lg border-0 bg-transparent px-1.5 text-sm hover:bg-[var(--muted)] focus:border-0 [&>svg]:shrink-0 [&>svg]:text-[var(--muted-foreground)]"
              >
                <span className="min-w-0 truncate">{selectedNotebook?.name ?? t('preferences.general.loading')}</span>
              </SelectTrigger>
              {/* 笔记本可能很多：弹层最高 50vh，超出部分在浮层内部滚动。 */}
              <SelectContent className="flowix-preferences-select-content" fitViewport maxHeight="50vh">
                {notebookList.map((item) => (
                  <SelectItem key={item.id} value={item.path}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {notebookList !== null && notebookList.length === 0 && (
          <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.noteOther.noNotebooks')}</p>
        )}

        {selectedNotebook && (
          <FieldRow
            title={t('preferences.noteOther.createLocation.label')}
            description={t('preferences.noteOther.createLocation.description')}
          >
            <Popover open={folderPickerOpen} onOpenChange={handlePickerOpenChange}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={loading && !preferences}
                  aria-label={t('preferences.noteOther.createLocation.label')}
                  data-state={folderPickerOpen ? 'open' : 'closed'}
                  title={currentFolderLabelText}
                  className="flex h-8 w-60 min-w-0 shrink-0 items-center justify-between gap-2 rounded-lg bg-[var(--card)] border border-[var(--border)] px-3 text-left text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="min-w-0 truncate">{currentFolderLabelText}</span>
                  <ChevronDown className={cn('h-4 w-4 shrink-0 text-[var(--muted-foreground)] transition-transform', folderPickerOpen && 'rotate-180')} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="end"
                sideOffset={6}
                className="max-h-[min(60vh,280px)] w-[260px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
              >
                <div className="mention-note-header">{t('preferences.noteOther.createLocation.pickerTitle')}</div>
                <OverlayScrollbar
                  className="mention-note-items-frame max-h-[calc(min(60vh,280px)_-_36px)]"
                  scrollerClassName="mention-note-items max-h-[calc(min(60vh,280px)_-_36px)] overflow-y-auto overflow-x-hidden"
                >
                  {folderOptionsLoading
                    ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('preferences.general.loading')}</p>
                    : (
                      <div className="space-y-0.5">
                        <button
                          type="button"
                          aria-pressed={currentFolderValue === null}
                          onClick={() => void handleDefaultFolderChange(null)}
                          className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${currentFolderValue === null ? 'bg-[var(--muted)]' : ''}`}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2 pl-2">
                            <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                            <span className="min-w-0 truncate">{t('preferences.noteOther.rootFolder')}</span>
                          </span>
                        </button>
                        {visibleFolderOptions.map((option) => {
                          const segments = option.relativePath.split('/');
                          const folderName = segments[segments.length - 1] ?? option.relativePath;
                          const selected = currentFolderValue === option.relativePath;
                          const hasChildren = folderOptions.some((candidate) => candidate.relativePath.startsWith(`${option.relativePath}/`));
                          const collapsed = collapsedFolders.has(option.relativePath);
                          return (
                            <div
                              key={option.relativePath}
                              className={`flex h-8 min-w-0 items-center rounded-lg pr-2 text-sm hover:bg-[var(--muted)] ${selected ? 'bg-[var(--muted)]' : ''}`}
                              style={{ paddingLeft: `${8 + option.depth * 12}px` }}
                            >
                              {hasChildren
                                ? (
                                  <button
                                    type="button"
                                    aria-label={`${collapsed ? t('preferences.noteOther.expandFolder') : t('preferences.noteOther.collapseFolder')} ${folderName}`}
                                    aria-expanded={!collapsed}
                                    onClick={() => setCollapsedFolders((current) => {
                                      const next = new Set(current);
                                      if (next.has(option.relativePath)) next.delete(option.relativePath);
                                      else next.add(option.relativePath);
                                      return next;
                                    })}
                                    className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                                  >
                                    <ChevronRight className={`h-3.5 w-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden="true" />
                                  </button>
                                )
                                : <span className="w-5 shrink-0" aria-hidden="true" />}
                              <button
                                type="button"
                                title={option.relativePath}
                                aria-pressed={selected}
                                onClick={() => void handleDefaultFolderChange(option.relativePath)}
                                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg text-left"
                              >
                                <ResourceFolderIcon expanded={!collapsed && hasChildren} className="h-[18px] w-[18px] shrink-0" />
                                <span className="min-w-0 truncate">{folderName}</span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                </OverlayScrollbar>
              </PopoverContent>
            </Popover>
          </FieldRow>
        )}

        {/* 说明项：标题 + 副标题与「笔记默认位置」同一套字段样式（SectionHeader
            `size="field"`），只是没有控件——隐藏文件夹恒不参与索引，不由用户切换。 */}
        <SectionHeader
          size="field"
          title={t('preferences.noteOther.indexSection')}
          description={t('preferences.noteOther.indexDescription')}
        />
      </section>

      {/* 「访问空间」分组标题与页首「笔记设置」同用 SectionHeader（同一字号 + 分割线）；
          两个开关写 ~/.flowix/boot/preference.json，关掉后 Rust 列举文件树时直接
          不再下发对应目录（索引 / watcher / 鉴权口径不受影响）。 */}
      <section className="space-y-4">
        <SectionHeader title={t('preferences.noteOther.spaceSection')} />
        <FieldRow
          title={t('preferences.noteOther.spaceHiddenFolders.label')}
          description={t('preferences.noteOther.spaceHiddenFolders.description')}
        >
          <SettingsSwitch
            checked={showHiddenFolders}
            onChange={(checked) => void updateSettings({ spaceShowHiddenFolders: checked })}
            label={t('preferences.noteOther.spaceHiddenFolders.label')}
          />
        </FieldRow>

        <FieldRow
          title={t('preferences.noteOther.spaceSystemFolders.label')}
          description={t('preferences.noteOther.spaceSystemFolders.description')}
        >
          <SettingsSwitch
            checked={showSystemFolders}
            onChange={(checked) => void updateSettings({ spaceShowSystemFolders: checked })}
            label={t('preferences.noteOther.spaceSystemFolders.label')}
          />
        </FieldRow>
      </section>
    </div>
  );
}
