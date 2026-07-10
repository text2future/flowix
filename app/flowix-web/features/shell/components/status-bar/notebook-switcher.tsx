'use client';

import { Check, ChevronsUpDown, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@shared/ui/dropdown-menu';
import { files, notebooks as notebooksClient } from '@platform/tauri/client';
import { NotebookIcon, type Notebook } from '@features/memo';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@features/i18n';

async function enrichNotebookMissingState(notebooks: Notebook[]): Promise<Notebook[]> {
  if (notebooks.every((notebook) => Object.prototype.hasOwnProperty.call(notebook, 'missing'))) {
    return notebooks;
  }

  return Promise.all(
    notebooks.map(async (notebook) => {
      if (Object.prototype.hasOwnProperty.call(notebook, 'missing')) {
        return notebook;
      }
      try {
        const tree = await files.getTree(notebook.path);
        return { ...notebook, missing: tree === null };
      } catch {
        return { ...notebook, missing: true };
      }
    })
  );
}

interface NotebookSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelect: (notebook: Notebook) => void;
  onEdit: (notebook: Notebook) => void;
  onDelete: (notebook: Notebook) => void;
  /**
   * Called each time the dropdown opens. Parent uses it to refetch the
   * notebook list so newly created / imported notebooks show up immediately.
   * Receives the fresh list (already filtered to non-empty) or `null`.
   */
  onRefresh: (notebooks: Notebook[]) => void;
  /** Width passed to the dropdown content; usually derived from the memo list column. */
  dropdownWidth: number;
}

/**
 * Bottom-bar trigger + dropdown for switching, creating, editing and deleting
 * notebooks. The dropdown refreshes the notebook list every time it opens, so
 * notebooks created elsewhere (file watcher, import, etc.) appear without a
 * stale-cache surprise.
 *
 * Row style: 单行, 统一 h-6 w-6 字母头像 + truncate 名字 + 默认徽章 + hover 出现的编辑/删除 + 选中态 Check。
 * 单选语义: 点行 = 选中 (通过 onSelect 回调给上层 store, 不在内部维护多选状态)。
 */
export function NotebookSwitcher({
  open,
  onOpenChange,
  notebooks,
  selectedNotebook,
  onSelect,
  onEdit,
  onDelete,
  onRefresh,
  dropdownWidth,
}: NotebookSwitcherProps) {
  const { t } = useI18n();
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // Refresh the notebook list each time the popup opens so newly
          // created or imported notebooks show up immediately.
          notebooksClient.getAll().then(async (nbList) => {
            if (nbList && nbList.length > 0) {
              onRefresh(await enrichNotebookMissingState(nbList));
            }
          });
        }
        onOpenChange(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-[26px] flex px-1 bg-[var(--primary)] items-center hover:opacity-90 gap-1"
          aria-label={t('status.switchNotebook')}
        >
          <span className="pl-2 h-full py-0 text-[var(--primary-foreground)] flex items-center overflow-hidden whitespace-nowrap">
            {t('status.notebook')}
          </span>
          <NotebookIcon
            icon={selectedNotebook?.icon}
            name={selectedNotebook?.name}
            className="h-4 w-4 rounded bg-[color-mix(in_oklch,var(--primary-foreground)_10%,transparent)] text-[12px] font-semibold text-[var(--primary-foreground)]"
          />
          <ChevronsUpDown className="text-[var(--primary-foreground)] w-3 h-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={2}
        className="flex flex-col max-h-[500px] overflow-hidden px-1 py-1 ml-2 bg-[var(--popover)]"
        style={{ width: Math.max(160, dropdownWidth - 24) }}
      >
        <DropdownMenuLabel className="shrink-0 px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {t('status.notebookList')}
        </DropdownMenuLabel>
        <div className="flex-1 min-h-0 overflow-y-auto pb-1 space-y-0.5">
          {notebooks.length === 0 ? (
            <div className="px-3 py-8 text-xs text-center text-[var(--muted-foreground)]">
              {t('status.noNotebooks')}
            </div>
          ) : (
            notebooks.map((notebook) => {
              const isActive = selectedNotebook?.id === notebook.id;
              const isMissing = Boolean(notebook.missing);
              const notebookTitleClassName = cn(
                'text-sm font-medium',
                isMissing ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'
              );
              return (
                <DropdownMenuItem
                  key={notebook.id}
                  onClick={() => {
                    if (isMissing) {
                      toast.warning(t('status.invalidNotebookPath'));
                      return;
                    }
                    onSelect(notebook);
                  }}
                  className={cn(
                    'group relative flex items-center gap-2 cursor-pointer rounded-md px-2 py-1.5 pr-14 transition-colors',
                    'hover:bg-[var(--accent)]'
                  )}
                >
                  {/* 小号字母头像: h-6 w-6 + 11px 字 + rounded-md。 */}
                  <NotebookIcon
                    icon={notebook.icon}
                    name={notebook.name}
                    className="h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
                  />
                  <div className="flex-1 min-w-0 flex items-center gap-1.5">
                    <span className="min-w-0 truncate">
                      <span className={notebookTitleClassName}>{notebook.name}</span>
                      {isMissing && (
                        <>
                          <span className={notebookTitleClassName}> </span>
                          <span className={notebookTitleClassName}>{t('status.invalid')}</span>
                        </>
                      )}
                    </span>
                  </div>
                  {/* 右侧操作区: 选中态 Check (常驻) + 编辑 / 删除 (hover 出现)。
                      单选语义: 点行 = 选中, 由 DropdownMenuItem 的 onClick 走 onSelect。 */}
                  {isActive && (
                    <div className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center transition-opacity group-hover:opacity-0">
                      <Check className="h-4 w-4 text-[var(--primary)]" />
                    </div>
                  )}
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(notebook);
                      }}
                      className="flex h-6 w-6 items-center justify-center rounded bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
                      aria-label={t('status.editNotebook')}
                    >
                      <Pencil className="h-3 w-3" />
                    </span>
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(notebook);
                      }}
                      className="flex h-6 w-6 items-center justify-center rounded bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--destructive)] cursor-pointer"
                      aria-label={t('status.deleteNotebook')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  </div>
                </DropdownMenuItem>
              );
            })
          )}
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              // Defer to next tick so the dropdown finishes closing
              // before the modal opens.
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('flowix:open-create-notebook'));
              }, 0);
            }}
            className={cn(
              'group flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              'text-[var(--muted-foreground)] hover:bg-[var(--muted)]'
            )}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">{t('status.newNotebook')}</span>
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
