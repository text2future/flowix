'use client';

import { ChevronsUpDown, Folder, Pencil, Trash2 } from 'lucide-react';
import { pinyin } from 'pinyin-pro';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '../../../components/ui/dropdown-menu';
import { notebooks as notebooksClient } from '../../../lib/tauri/client';
import type { Notebook } from '../../../lib/store';
import { cn } from '../../../lib/utils';

function getLastPathSegments(path: string, count: number = 2): string {
  if (!path) return '';
  const cleaned = path.replace(/[\\/]+$/, '');
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return '';
  return segments.slice(-count).join('/');
}

function getNotebookIconLetter(name: string | undefined | null, fallback: string = 'N'): string {
  if (!name) return fallback;
  const trimmed = name.trim();
  if (!trimmed) return fallback;

  // ASCII letter/digit prefix → take it directly (e.g. "Apple" → "A", "123" → "1")
  const first = trimmed.charAt(0);
  if (/[A-Za-z0-9]/.test(first)) {
    return first.toUpperCase();
  }

  // CJK or other → use pinyin first letter (e.g. "默认" → "M", "我的笔记" → "W")
  const py = pinyin(trimmed, { pattern: 'first' }).trim();
  if (!py) return fallback;
  return py.charAt(0).toUpperCase();
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
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // Refresh the notebook list each time the popup opens so newly
          // created or imported notebooks show up immediately.
          notebooksClient.getAll().then((nbList) => {
            if (nbList && nbList.length > 0) {
              onRefresh(nbList);
            }
          });
        }
        onOpenChange(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-6 flex px-1 bg-[#4E62E5] items-center hover:bg-[#6B7CF0] gap-1"
          aria-label="切换笔记本"
        >
          <span className="pl-2 h-full py-0 text-white flex items-center overflow-hidden whitespace-nowrap">
            笔记本
          </span>
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-white/10 text-[12px] font-semibold text-white">
            {getNotebookIconLetter(selectedNotebook?.name)}
          </span>
          <ChevronsUpDown className="text-white w-3 h-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        className="flex flex-col max-h-[500px] overflow-hidden p-0 ml-2 bg-[var(--card)] !border-[var(--primary)]"
        style={{ width: Math.max(160, dropdownWidth - 16) }}
      >
        <DropdownMenuLabel className="shrink-0 px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          笔记本列表
        </DropdownMenuLabel>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 space-y-1.5">
          {notebooks.length === 0 ? (
            <div className="px-3 py-8 text-xs text-center text-[var(--muted-foreground)]">
              暂无笔记本
            </div>
          ) : (
            notebooks.map((notebook) => {
              const isActive = selectedNotebook?.id === notebook.id;
              return (
                <DropdownMenuItem
                  key={notebook.id}
                  onClick={() => onSelect(notebook)}
                  className={cn(
                    'group relative flex items-center gap-3 cursor-pointer rounded-lg px-1.5 py-[5px] transition-colors',
                    isActive ? 'bg-[var(--accent)]' : 'hover:bg-[var(--muted)]'
                  )}
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold bg-gray-200 text-gray-700">
                    {getNotebookIconLetter(notebook.name)}
                  </div>
                  <div className="flex-1 min-w-0 pr-12">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-[var(--foreground)] truncate">
                        {notebook.name}
                      </span>
                      {notebook.isDefault && (
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-[var(--accent)] text-[var(--primary)]">
                          默认
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-[var(--muted-foreground)] truncate">
                      <Folder className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {getLastPathSegments(notebook.path, 2)}
                      </span>
                    </div>
                  </div>
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(notebook);
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
                      aria-label="编辑笔记本"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </span>
                    {!notebook.isDefault && (
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(notebook);
                        }}
                        className="flex h-7 w-7 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-red-500 cursor-pointer"
                        aria-label="删除笔记本"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </div>
                </DropdownMenuItem>
              );
            })
          )}
        </div>
        <div className="shrink-0 p-2">
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              // Defer to next tick so the dropdown finishes closing
              // before the modal opens.
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('woop:open-create-notebook'));
              }, 0);
            }}
            className="flex items-center justify-center cursor-pointer rounded-md border border-[var(--border)] w-full py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--muted)]"
          >
            <span>新建笔记本</span>
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
