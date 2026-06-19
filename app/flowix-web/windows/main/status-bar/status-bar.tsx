'use client';

import { Infinity, ListTodo, SlidersHorizontal } from 'lucide-react';
import { Tooltip } from '../../../components/ui/tooltip';
import type { Notebook } from '../../../lib/store';
import { NotebookSwitcher } from './notebook-switcher';

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
  onToggleAgentPanel: () => void;
  onOpenPreferences: () => void;
}

/**
 * Bottom status bar for the main window.
 *
 * Layout (left → right):
 *   [NotebookSwitcher] [Todos] [char count]   …flex spacer…   [AI Chat] [⚙]
 *
 * Renders no chrome of its own — it assumes it lives in a `h-6` flex strip.
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
  onToggleAgentPanel,
  onOpenPreferences,
}: StatusBarProps) {
  return (
    <div className="h-6 shrink-0 flex items-center text-xs text-[var(--muted-foreground)] border-t border-[var(--divider)] bg-[var(--statusbar-bg)]">
      <div className="h-full flex items-center gap-1.5">
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
        <button
          type="button"
          className="h-full inline-flex items-center gap-1 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          aria-label={`待办 ${todoCount}`}
          onClick={onOpenTodos}
        >
          <ListTodo className="w-3.5 h-3.5 shrink-0" />
          <span>待办</span>
          <span>{todoCount}</span>
        </button>
        {charCount > 0 && <span className="text-[var(--muted-foreground)]">字 {charCount}</span>}
      </div>
      <div className="flex-1" />
      <Tooltip content="AI 对话" shortcut="panel.agent.toggle">
        <button
          onClick={onToggleAgentPanel}
          className="h-full flex items-center gap-1 px-1.5 py-0 hover:bg-[var(--muted)] mr-1"
        >
          <Infinity className="w-3.5 h-3.5" />
          <span>AI 对话</span>
        </button>
      </Tooltip>
      <Tooltip content="偏好设置" shortcut="menu.open" side="top">
        <button
          type="button"
          onClick={onOpenPreferences}
          className="h-full flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)] mr-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          aria-label="偏好设置"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
