'use client';

import { Hash, ListTodo, SlidersHorizontal } from 'lucide-react';
import { Tooltip } from '@shared/ui/tooltip';
import type { Notebook } from '@features/memo';
import { NotebookSwitcher } from '@features/shell/components/status-bar/notebook-switcher';
import { AgentRuntimeStatusMenu } from '@features/shell/components/status-bar/agent-runtime-status-menu';
import { ProductUpdatePill } from '@features/shell/components/status-bar/product-update-pill';
import { useI18n } from '@features/i18n';

interface StatusBarProps {
  /** Current width of the memo list column; used to size the notebook dropdown. */
  memoColWidth: number;
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  notebookPopupOpen: boolean;
  setNotebookPopupOpen: (open: boolean) => void;
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onRefreshNotebooks: (notebooks: Notebook[]) => void;
  todoCount: number;
  onOpenTodos: () => void;
  charCount: number;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: () => void;
}

/**
 * Bottom status bar for the main window.
 *
 * Layout (two columns):
 *   [NotebookSwitcher] | [Todos] [char count]   …flex spacer…   [Note Nav] [AI Chat] [⚙]
 *                       ↑ top border
 *
 * The left column is the notebook switcher (fixed width by its own button
 * content); the right column takes the remaining width and carries the top
 * border so the switcher's primary-colored block reads as a standalone first
 * column.
 *
 * Renders no chrome of its own — it assumes it lives in a `h-[26px]` flex strip.
 */
export function StatusBar({
  memoColWidth,
  notebooks,
  selectedNotebook,
  notebookPopupOpen,
  setNotebookPopupOpen,
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
  onRefreshNotebooks,
  todoCount,
  onOpenTodos,
  charCount,
  onToggleNoteNavigation,
  onOpenPreferences,
}: StatusBarProps) {
  const { t } = useI18n();
  return (
    <div className="flex h-[26px] shrink-0 select-none items-stretch bg-[var(--statusbar-bg)] text-xs text-[var(--muted-foreground)]">
      {/* Left column: notebook switcher (fixed width by its own button content). */}
      <div className="shrink-0 flex items-center">
        <NotebookSwitcher
          open={notebookPopupOpen}
          onOpenChange={setNotebookPopupOpen}
          notebooks={notebooks}
          selectedNotebook={selectedNotebook}
          onSelect={onSelectNotebook}
          onEdit={onEditNotebook}
          onDelete={onDeleteNotebook}
          onRefresh={onRefreshNotebooks}
          dropdownWidth={memoColWidth}
        />
      </div>
      {/* Right column: full-width content area; carries the top border. */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 pl-1.5 border-t border-[var(--divider)]">
        <button
          type="button"
          className="h-full inline-flex items-center gap-1 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          aria-label={`${t('status.todos')} ${todoCount}`}
          onClick={onOpenTodos}
        >
          <ListTodo className="w-3.5 h-3.5 shrink-0" />
          <span>{t('status.todos')}</span>
          <span>{todoCount}</span>
        </button>
        {charCount > 0 && <span className="text-[var(--muted-foreground)]">{t('status.characters')} {charCount}</span>}
        <div className="flex-1" />
        <ProductUpdatePill />
        <Tooltip content={t('shell.statusBar.noteNavTooltip')}>
          <button
            type="button"
            onClick={onToggleNoteNavigation}
            className="h-full flex items-center gap-1 px-1.5 py-0 hover:bg-[var(--muted)]"
            aria-label={t('shell.statusBar.noteNav')}
          >
            <Hash className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <AgentRuntimeStatusMenu />
        <Tooltip content={t('status.preferences')} shortcut="menu.open" side="top">
          <button
            type="button"
            onClick={onOpenPreferences}
            className="mr-1.5 h-full flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            aria-label={t('status.preferences')}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
