'use client';

import { Infinity, ListTodo, SlidersHorizontal } from 'lucide-react';
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
    <div className="h-6 shrink-0 flex items-center text-xs text-gray-500 border-t border-black/5 bg-white">
      <div className="h-full flex items-center gap-1">
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
      <button
        type="button"
        className="h-full inline-flex items-center gap-1 px-1.5 text-gray-400 hover:bg-black/5 hover:text-gray-600"
        aria-label={`待办 ${todoCount}`}
        onClick={onOpenTodos}
      >
        <ListTodo className="w-3.5 h-3.5 shrink-0" />
        <span>待办</span>
        <span>{todoCount}</span>
      </button>
      {charCount > 0 && <span className="text-gray-400">字 {charCount}</span>}
      <div className="flex-1" />
      <button
        onClick={onToggleAgentPanel}
        className="h-full flex items-center gap-1 px-1.5 py-0 hover:bg-black/5 mr-1"
      >
        <Infinity className="w-3.5 h-3.5" />
        <span>AI Chat</span>
      </button>
      <button
        type="button"
        onClick={onOpenPreferences}
        className="h-full flex items-center justify-center px-1.5 py-0 hover:bg-black/5 mr-1 text-gray-500 hover:text-gray-700"
        aria-label="偏好"
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
