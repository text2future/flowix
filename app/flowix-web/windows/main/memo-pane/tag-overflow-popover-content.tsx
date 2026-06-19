'use client';

import type { PointerEvent, RefObject } from 'react';
import {
  ArrowLineUpIcon,
  DotsSixIcon,
  EyeIcon,
  EyeSlashIcon,
  HashIcon,
} from '@phosphor-icons/react';

import { cn } from '../../../lib/utils';
import { PopoverContent } from '../../../components/ui/popover';
import { Tooltip } from '../../../components/ui/tooltip';

export interface TagOption {
  id: string;
  name: string;
}

export interface TagDragGhost {
  id: string;
  rect: DOMRect;
  currentY: number;
  offsetY: number;
}

interface TagOverflowPopoverContentProps {
  tagOptions: TagOption[];
  selectedTagId: string | null;
  hiddenTagIdSet: Set<string>;
  draggingTagId: string | null;
  dropTarget: { id: string; position: 'before' | 'after' } | null;
  dragGhost: TagDragGhost | null;
  popoverRowRefs: RefObject<Map<string, HTMLDivElement>>;
  onRowPointerDown: (event: PointerEvent<HTMLDivElement>, tagId: string) => void;
  onTagSelect: (tagId: string) => void;
  onPinTagToTop: (tagId: string) => void;
  onToggleTagHidden: (tagId: string) => void;
}

export function TagOverflowPopoverContent({
  tagOptions,
  selectedTagId,
  hiddenTagIdSet,
  draggingTagId,
  dropTarget,
  dragGhost,
  popoverRowRefs,
  onRowPointerDown,
  onTagSelect,
  onPinTagToTop,
  onToggleTagHidden,
}: TagOverflowPopoverContentProps) {
  return (
    <PopoverContent
      side="right"
      align="start"
      sideOffset={8}
      className="w-[240px] max-h-[480px] overflow-hidden rounded-lg bg-[var(--card)] p-0 shadow-xl"
    >
      <div className="max-h-[480px] space-y-1 overflow-y-auto p-1.5">
        {tagOptions.map((tag) => {
          const isSelected = selectedTagId === tag.id;
          const isDragging = draggingTagId === tag.id;
          const isHidden = hiddenTagIdSet.has(tag.id);
          const isDropBefore =
            dropTarget?.id === tag.id && dropTarget.position === 'before' && !isDragging;
          const isDropAfter =
            dropTarget?.id === tag.id && dropTarget.position === 'after' && !isDragging;

          return (
            <div
              key={tag.id}
              ref={(node) => {
                if (node) {
                  popoverRowRefs.current.set(tag.id, node);
                } else {
                  popoverRowRefs.current.delete(tag.id);
                }
              }}
              role="button"
              tabIndex={0}
              onPointerDown={(event) => onRowPointerDown(event, tag.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onTagSelect(tag.id);
                }
              }}
              className={cn(
                'group relative flex h-8 w-full cursor-grab select-none items-center gap-2 rounded-md pl-1.5 pr-1 text-left text-sm transition-colors active:cursor-grabbing',
                isSelected && !isDragging
                  ? 'bg-[var(--accent)] text-[var(--primary)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
                isDragging && 'opacity-50',
                isHidden && !isDragging && 'opacity-70',
              )}
              title={tag.name}
            >
              <span
                aria-hidden
                className="flex h-5 w-4 shrink-0 items-center justify-center text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary)] group-hover:opacity-100"
              >
                <DotsSixIcon className="h-3.5 w-3.5" weight="bold" />
              </span>
              <HashIcon
                className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]"
                weight="bold"
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  isHidden && 'text-[var(--muted-foreground)]',
                )}
              >
                {tag.name}
              </span>
              {isSelected && !isDragging && (
                <span className="ml-1 shrink-0 text-xs text-[var(--primary)]">已选</span>
              )}
              <Tooltip content="置顶">
                <button
                  type="button"
                  aria-label={`置顶 ${tag.name}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPinTagToTop(tag.id);
                  }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 transition-colors hover:bg-[var(--accent)] hover:text-[var(--primary)] group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <ArrowLineUpIcon className="h-3.5 w-3.5" weight="bold" />
                </button>
              </Tooltip>
              <Tooltip content={isHidden ? '取消隐藏' : '隐藏'}>
                <button
                  type="button"
                  aria-label={isHidden ? `取消隐藏 ${tag.name}` : `隐藏 ${tag.name}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleTagHidden(tag.id);
                  }}
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--primary)] focus-visible:opacity-100',
                    isHidden ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                >
                  {isHidden ? (
                    <EyeSlashIcon className="h-3.5 w-3.5" weight="bold" />
                  ) : (
                    <EyeIcon className="h-3.5 w-3.5" />
                  )}
                </button>
              </Tooltip>
              {isDropBefore && (
                <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-[var(--primary)]" />
              )}
              {isDropAfter && (
                <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-[var(--primary)]" />
              )}
            </div>
          );
        })}
      </div>

      {dragGhost && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[1100] flex items-center gap-2 rounded-md border border-[var(--primary)] bg-[var(--card)] px-2 text-sm opacity-50 shadow-lg"
          style={{
            left: dragGhost.rect.left,
            top: dragGhost.currentY - dragGhost.offsetY,
            width: dragGhost.rect.width,
            height: dragGhost.rect.height,
          }}
        >
          <span className="flex h-5 w-4 shrink-0 items-center justify-center text-[var(--primary)]">
            <DotsSixIcon className="h-3.5 w-3.5" weight="bold" />
          </span>
          <HashIcon
            className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]"
            weight="bold"
          />
          <span className="min-w-0 flex-1 truncate">
            {tagOptions.find((tag) => tag.id === dragGhost.id)?.name ?? ''}
          </span>
        </div>
      )}
    </PopoverContent>
  );
}
