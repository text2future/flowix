'use client';

import { Check, ChevronsUpDown, Pencil, Trash2 } from 'lucide-react';
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
 *
 * Row style: 单行, 与 agent-panel/inputbox-add 的「可访问文件」列表保持一致
 * (h-6 w-6 字母头像 + truncate 名字 + 默认徽章 + hover 出现的编辑/删除 + 选中态 Check)。
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
          className="h-6 flex px-1 bg-[var(--primary)] items-center hover:opacity-90 gap-1"
          aria-label="切换笔记本"
        >
          <span className="pl-2 h-full py-0 text-[var(--primary-foreground)] flex items-center overflow-hidden whitespace-nowrap">
            笔记本
          </span>
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[color-mix(in_oklch,var(--primary-foreground)_10%,transparent)] text-[12px] font-semibold text-[var(--primary-foreground)]">
            {getNotebookIconLetter(selectedNotebook?.name)}
          </span>
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
          笔记本列表
        </DropdownMenuLabel>
        <div className="flex-1 min-h-0 overflow-y-auto pb-1 space-y-0.5">
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
                    'group relative flex items-center gap-2 cursor-pointer rounded-md px-2 py-1.5 transition-colors',
                    'hover:bg-[var(--accent)]'
                  )}
                >
                  {/* 小号字母头像, 与 agent-panel/inputbox-add 的「可访问文件」列表
                      单行样式保持一致: h-6 w-6 + 11px 字 + rounded-md。 */}
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]">
                    {getNotebookIconLetter(notebook.name)}
                  </div>
                  <div className="flex-1 min-w-0 flex items-center gap-1.5">
                    <span className="text-sm font-medium text-[var(--foreground)] truncate">
                      {notebook.name}
                    </span>
                    {notebook.isDefault && (
                      <span className="shrink-0 inline-flex items-center leading-none h-5 rounded-lg px-1.5 text-[10px] bg-[var(--accent)] text-[var(--primary)]">
                        默认
                      </span>
                    )}
                  </div>
                  {/* 右侧操作区: 选中态 Check (常驻) + 编辑 / 删除 (hover 出现)。
                      单选语义: 点行 = 选中, 由 DropdownMenuItem 的 onClick 走 onSelect。 */}
                  {isActive && (
                    <Check className="shrink-0 h-4 w-4 text-[var(--primary)] transition-opacity group-hover:opacity-0" />
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
                      aria-label="编辑笔记本"
                    >
                      <Pencil className="h-3 w-3" />
                    </span>
                    {!notebook.isDefault && (
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(notebook);
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--destructive)] cursor-pointer"
                        aria-label="删除笔记本"
                      >
                        <Trash2 className="h-3 w-3" />
                      </span>
                    )}
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
            className="flex items-center justify-center cursor-pointer rounded-md border border-[var(--border)] w-full py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--accent)]"
          >
            <span>新建笔记本</span>
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
