'use client';

import { CheckSquare, CircleDashed, Square } from "@phosphor-icons/react";
import { type MemoItem } from '../../../lib/store';
import { cn } from '../../../lib/utils';

export interface MemoTodoListEntry {
  content: string;
  status: string;
  memoId: string;
  priority?: string;
  timeRange?: string;
  owner?: string;
  assignee?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface MemoCardTodoProps {
  memo: MemoItem;
  todo: MemoTodoListEntry;
  todoKey: string;
  selectedTodoKey: string | null;
  onSelect: (memo: MemoItem, todoKey: string) => void;
}

function isTodoCompleted(status: string) {
  return status === 'completed' || status === 'done';
}

function getTodoStatusIcon(todo: MemoTodoListEntry | null) {
  if (!todo) {
    return { type: 'empty' as const, Icon: CircleDashed, className: 'text-[var(--muted-foreground)]' };
  }

  if (isTodoCompleted(todo.status)) {
    return { type: 'completed' as const, Icon: CheckSquare, className: 'text-[var(--foreground)] opacity-55' };
  }

  return { type: 'pending' as const, Icon: Square, className: 'text-[var(--muted-foreground)]' };
}

export function MemoCardTodo({
  memo,
  todo,
  todoKey,
  selectedTodoKey,
  onSelect,
}: MemoCardTodoProps) {
  const status = getTodoStatusIcon(todo);
  const { Icon } = status;
  const completed = isTodoCompleted(todo.status);
  const isSelected = todoKey === selectedTodoKey;

  return (
    <div
      onClick={() => onSelect(memo, todoKey)}
      className={cn(
        "group flex items-center gap-2 py-2 px-3 cursor-pointer transition-all rounded-lg",
        isSelected ? 'bg-[var(--accent)]' : 'hover:bg-[var(--accent)]'
      )}
    >
      <Icon className={cn("w-4 h-4 shrink-0", status.className)} weight="regular" />

      <div className="flex-1 min-w-0">
        <div className={cn(
          "text-sm text-[var(--foreground)] truncate",
          completed && "line-through opacity-55"
        )}>
          {todo.content}
        </div>
      </div>

      {todo.priority ? (
        <span className="text-xs text-[var(--muted-foreground)] shrink-0 max-w-[72px] truncate">
          {todo.priority}
        </span>
      ) : null}
    </div>
  );
}
