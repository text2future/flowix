'use client';

import { useCallback } from 'react';
import { Folder } from '@phosphor-icons/react';
import { Plus } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { resolveNotebookAgentFiles } from '@/lib/agent-access-defaults';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Tooltip } from '@shared/ui/tooltip';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { NotebookIcon, type Notebook } from '@features/memo';
import { openBrowserColumnFileBrowser } from '@features/workspace/use-cases/browser-column-navigation';

/**
 * Shows add-dir entries for the selected notebook.  The notebook itself is
 * the workspace/cwd; this list only edits notebook-local `.flowix/agent.json`
 * and never selects a primary folder.
 */
interface NotebookAccessFilesListProps {
  notebook: Notebook | undefined;
  onOpenFile?: (path: string) => void;
}

interface ResolvedItem {
  path: string;
  name: string;
  missing: boolean;
}

// Agent-access paths can come from older config files or different platform
// path spellings. Use the same comparison semantics as the access-defaults
// resolver so the visual badge follows the persisted workspace value.
const comparablePath = (path: string): string =>
  path.trim().replace(/[\\/]+$/, '').toLowerCase();
const ACCESS_MENU_CLASS =
  'w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const ACCESS_MENU_ITEM_CLASS =
  'h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';

export function NotebookAccessFilesList({
  notebook,
  onOpenFile,
}: NotebookAccessFilesListProps) {
  const { t } = useI18n();
  const notebookId = notebook?.id;
  const config = useAgentAccessStore((s) => s.config);
  const notebookConfigs = useAgentAccessStore((s) => s.notebookConfigs);
  const addFolderFromPicker = useAgentAccessStore((s) => s.addFolderFromPicker);
  const setDefaultFiles = useAgentAccessStore((s) => s.setDefaultFiles);

  // Only the selected notebook's `.flowix/agent.json` add-dirs are shown;
  // global entries merely authorize paths and are never displayed as defaults.
  const defaultFiles = resolveNotebookAgentFiles(config, notebookConfigs, notebookId);
  // Keep stale local paths visible (as missing) so users can remove them. The
  // runtime resolver still intersects with the global authorization registry.
  const folderPaths = notebookId && notebookConfigs?.[notebookId]
    ? notebookConfigs[notebookId].addDirs
        .filter((directory) => directory.enabled)
        .map((directory) => directory.path)
    : defaultFiles?.folders ?? [];
  const entries = config.entries;
  const resolveItem = (path: string): ResolvedItem => {
    const found = entries.find(
      (e) => e.kind === 'folder' && comparablePath(e.path) === comparablePath(path),
    );
    if (found) return { path, name: found.name, missing: found.missing };
    // 默认里存了 path 但全局 entries 已没有 (folder 被删): 按缺失处理,
    // name 用路径末段兜底, 让用户仍能认出是哪个目录。
    const trimmed = path.replace(/[\\/]+$/, '');
    const derived = trimmed.split(/[\\/]/).pop() || trimmed;
    return { path, name: derived, missing: true };
  };

  const folderItems = folderPaths.map(resolveItem);

  const handleAddFolder = useCallback(async () => {
    const result = await addFolderFromPicker();
    if (!result.ok) {
      if (result.code === 'already-tracked') {
        toast.error(t('agent.access.alreadyTracked'));
      } else if (result.code === 'save-failed') {
        toast.error(t('agent.access.saveFailed'));
      }
      return;
    }
    // Attach the picked folder to this notebook's local add-dir list. Without
    // a selected notebook, the global authorization entry is still retained.
    if (!notebookId) return;
    // The picker reloads the global config before returning. Resolve the
    // latest notebook defaults instead of appending to a stale render closure.
    const latestState = useAgentAccessStore.getState();
    const latestFiles = resolveNotebookAgentFiles(
      latestState.config,
      latestState.notebookConfigs,
      notebookId,
    );
    if (
      (latestFiles?.folders ?? []).some(
        (path) => comparablePath(path) === comparablePath(result.entry.path),
      )
    ) {
      toast.info(t('agent.access.folderExists'));
      return;
    }
    const nextFolders = Array.from(new Set([...(latestFiles?.folders ?? []), result.entry.path]));
    const saved = await setDefaultFiles(notebookId, {
      folders: nextFolders,
      notebooks: latestFiles?.notebooks ?? [],
    });
    if (!saved) toast.error(t('agent.access.saveFailed'));
  }, [addFolderFromPicker, setDefaultFiles, notebookId, t]);

  // 删除资料文件夹只修改当前 notebook 的 add-dir 列表。
  const handleRemoveFolder = useCallback(
    async (path: string) => {
      if (!notebookId) return;
      const nextFolders = folderPaths.filter((p) => p !== path);
      const saved = await setDefaultFiles(notebookId, {
        folders: nextFolders,
        notebooks: defaultFiles?.notebooks ?? [],
      });
      if (!saved) {
        toast.error(t('agent.access.saveFailed'));
        return;
      }
      const item = folderItems.find((it) => it.path === path);
      toast.success(t('agent.access.folderDeleted', { name: item?.name ?? path }));
    },
    [notebookId, folderPaths, defaultFiles, folderItems, setDefaultFiles, t],
  );

  // 资料组 ── 外侧容器, pt-1 提供组上方留白 (与标签组对称, 用 padding 而非 margin); pb-4 是滚动列表末尾底部留白。
  return (
    <div className="pt-1 pb-4">
      <div className="agent-thread-card__access-section-label">
        {t('memo.navigation.files')}
      </div>
      <div className="space-y-0.5">
        {folderItems.map((item) => {
        const rowTitle = item.missing ? t('agent.access.pathMissing') : item.path;
        // 单击 = 在中间列打开该文件夹的文件树 (浏览), 主空间切换完全走右键
        // 菜单 ── 消除"单击切主空间"的隐藏语义。missing 行不可浏览。
        const canBrowse = !item.missing;
        const isBrowsing = false;
        return (
          <ContextMenu key={item.path}>
            <ContextMenuTrigger asChild>
              <div
                role={canBrowse ? 'button' : undefined}
                tabIndex={canBrowse ? 0 : undefined}
                title={rowTitle}
                aria-current={isBrowsing ? 'true' : undefined}
                onClick={
                  canBrowse
                    ? () => {
                        void openBrowserColumnFileBrowser(item.path);
                        onOpenFile?.(item.path);
                      }
                    : undefined
                }
                onKeyDown={
                  canBrowse
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          void openBrowserColumnFileBrowser(item.path);
                          onOpenFile?.(item.path);
                        }
                      }
                    : undefined
                }
                className={cn(
                  'relative flex h-7 w-full select-none items-center gap-0 rounded-lg pr-2 text-left text-sm transition-[color]',
                  canBrowse && 'cursor-pointer',
                  isBrowsing
                    ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                    : 'text-[var(--foreground)]',
                  item.missing && 'opacity-70',
                )}
                style={{ paddingLeft: 6 }}
              >
                <span
                  className={cn(
                    'relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center -ml-1 mr-1 overflow-hidden rounded-md opacity-90',
                    isBrowsing ? 'text-[var(--primary-foreground)]' : 'text-[var(--foreground)]',
                  )}
                >
                  {item.missing ? (
                    <NotebookIcon
                      icon={null}
                      name={item.name}
                      className="h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
                      imageClassName="h-[72%] w-[72%]"
                    />
                  ) : (
                    <Folder className="h-3.5 w-3.5" weight="fill" />
                  )}
                </span>
                <div className="flex-1 min-w-0 flex items-center gap-1.5">
                  <span className={cn('min-w-0 truncate', item.missing && 'text-[var(--muted-foreground)]')}>
                    {item.name}
                  </span>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className={ACCESS_MENU_CLASS}>
              <ContextMenuItem
                onClick={() => handleRemoveFolder(item.path)}
                className={cn(ACCESS_MENU_ITEM_CLASS, 'text-[var(--destructive)]')}
              >
                {t('agent.access.contextDelete')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
        })}
        <Tooltip content={t('agent.access.addFolderHint')} side="right" align="start">
          <button
            type="button"
            onClick={handleAddFolder}
            className="group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            style={{ paddingLeft: 6 }}
          >
            <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center -ml-1 mr-1 rounded-md text-[var(--muted-foreground)]">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {t('memo.navigation.addFolder')}
            </span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
