'use client';

import { useCallback } from 'react';
import { Folder } from '@phosphor-icons/react';
import { Plus } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useAgentWorkspaceStore } from '@features/agent/store/agent-workspace-store';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Tooltip } from '@shared/ui/tooltip';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { NotebookIcon } from '@features/memo/components/notebook-icon';
import type { Notebook } from '@features/memo/store/note-store';
import { createFileBrowserTarget } from '@features/workspace/public/browser-column-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { canUseNativeContextMenu, logNativeContextMenuError, popupNativeContextMenu } from '@platform/tauri/native-context-menu';
import { loadNativeMenuIcons } from '@platform/tauri/native-menu-icons';

/**
 * Shows add-dir entries for the selected notebook.  The notebook itself is
 * the workspace/cwd; this list edits that notebook’s mounts in `local.db`
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

const ACCESS_MENU_CLASS =
  'w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const ACCESS_MENU_ITEM_CLASS =
  'h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const ACCESS_NATIVE_ICON_NAMES = ['delete'] as const;

export function NotebookAccessFilesList({
  notebook,
  onOpenFile,
}: NotebookAccessFilesListProps) {
  const { t } = useI18n();
  const notebookId = notebook?.id;
  const workspaceNotebook = useAgentWorkspaceStore((state) =>
    notebookId ? state.workspace.byNotebookId[notebookId] : undefined,
  );
  const addFolderFromPicker = useAgentWorkspaceStore((s) => s.workspaceActions.addFolderFromPicker);
  const detachFolderFromNotebook = useAgentWorkspaceStore((s) => s.workspaceActions.detachFolderFromNotebook);

  // Show the selected notebook's mounts, including missing paths for removal.
  const folderItems: ResolvedItem[] = (workspaceNotebook?.addDirs ?? [])
    .filter(directory => directory.enabled)
    .map(directory => ({ path: directory.path, name: directory.label, missing: directory.missing }));

  const handleAddFolder = useCallback(async () => {
    const result = await addFolderFromPicker(notebookId);
    if (!result.ok) {
      if (result.code === 'already-tracked') {
        toast.error(t('agent.access.alreadyTracked'));
      } else if (result.code === 'save-failed') {
        toast.error(t('agent.access.saveFailed'));
      }
      return;
    }

  }, [addFolderFromPicker, notebookId, t]);

  // Removing a folder deletes only this notebook’s mount.
  const handleRemoveFolder = useCallback(
    async (path: string) => {
      if (!notebookId) return;
      const saved = await detachFolderFromNotebook(notebookId, path);
      if (saved === false) {
        toast.error(t('agent.access.saveFailed'));
        return;
      }
      if (saved === 'not-attached') return;
      const item = folderItems.find((it) => it.path === path);
      toast.success(t('agent.access.folderDeleted', { name: item?.name ?? path }));
    },
    [notebookId, folderItems, detachFolderFromNotebook, t],
  );

  // 资料组 ── 外侧容器, pt-1 提供组上方留白; pb-2 将滚动列表末尾底部留白缩小一半。
  return (
    <div className="pt-1 pb-2">
      <div className="agent-composer__access-section-label">
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
                onContextMenu={(event) => {
                  if (!canUseNativeContextMenu()) return;
                  event.preventDefault();
                  event.stopPropagation();
                  void loadNativeMenuIcons(ACCESS_NATIVE_ICON_NAMES)
                    .then((icons) => popupNativeContextMenu(event, [{
                      text: t('agent.access.contextDelete'),
                      icon: icons.delete!,
                      action: () => void handleRemoveFolder(item.path),
                    }]))
                    .catch((error) => logNativeContextMenuError('notebook access file', error));
                }}
                onClick={
                  canBrowse
                    ? () => {
                        void openWorkspaceSurface({
                          index: 1,
                          target: createFileBrowserTarget(null, item.path, item.path),
                        });
                        onOpenFile?.(item.path);
                      }
                    : undefined
                }
                onKeyDown={
                  canBrowse
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          void openWorkspaceSurface({
                            index: 1,
                            target: createFileBrowserTarget(null, item.path, item.path),
                          });
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
                className={cn(ACCESS_MENU_ITEM_CLASS, 'hover:bg-transparent hover:text-[var(--destructive)]')}
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
            disabled={!notebookId}
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
