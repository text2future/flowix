'use client';

import { MoreHorizontal } from 'lucide-react';
import { PushPin } from "@phosphor-icons/react";
import { BookmarkSimpleIcon, BookmarkIcon, TrashIcon } from "@phosphor-icons/react";
import type { MemoItem } from '../../../lib/store';
import { cn } from '../../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../../../components/ui/dropdown-menu';

interface MemoCardProps {
  memo: MemoItem;
  tagMap: Record<string, string>;
  selectedMemo: MemoItem | null;
  openDropdown: string | null;
  onOpenDropdown: (id: string | null) => void;
  onSelect: (memo: MemoItem) => void;
  onOpenWindow: (memoId: string) => void;
  onFavoriteToggle: (memo: MemoItem) => void;
  onDelete: (memo: MemoItem) => void;
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    const months = Math.floor(days / 30);
    return `${months}个月前`;
  }
  if (days > 0) return `${days}天前`;
  if (hours > 0) return `${hours}小时前`;
  if (minutes > 0) return `${minutes}分钟前`;
  return '刚刚';
}

export function MemoCard({
  memo,
  tagMap,
  selectedMemo,
  openDropdown,
  onOpenDropdown,
  onSelect,
  onOpenWindow,
  onFavoriteToggle,
  onDelete,
}: MemoCardProps) {
  const selectedIdentifier = selectedMemo?.id || null;

  return (
    <div
      onClick={() => onSelect(memo)}
      onDoubleClick={() => onOpenWindow(memo.id)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", memo.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDragEnd={(e) => {
        const draggedMemoId = e.dataTransfer.getData("text/plain") || memo.id;
        onOpenWindow(draggedMemoId);
      }}
      className={cn(
        "group relative py-3 px-3 cursor-pointer transition-all rounded-xl",
        memo.id === selectedIdentifier ? 'bg-[var(--accent)]' : 'group-hover:bg-[var(--accent)]'
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="space-y-2">
            <h3 className="text-sm text-[var(--foreground)] line-clamp-2 mr-3">
              {memo.filename || '未命名的笔记'}
            </h3>
            {memo.preview ? (
              <p className="text-sm text-[var(--foreground)] opacity-50 line-clamp-2">
                {memo.preview}
              </p>
            ) : (
              <p className="text-sm text-[var(--foreground)] opacity-50 line-clamp-2">
                记录自己的想法
              </p>
            )}
          </div>
          <div className="flex w-full pt-2 items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              {memo.favorited && <PushPin weight="fill" className="w-3.5 h-3.5 text-black" />}
              {memo.tags && memo.tags.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {memo.tags.slice(0, 2).map((tagId) => (
                    <span
                      key={tagId}
                      className="inline-flex items-center px-1 py-0 text-xs rounded-[6px] border border-gray-300 text-[var(--muted-foreground)]"
                    >
                      #{tagMap[tagId] || tagId}
                    </span>
                  ))}
                  {memo.tags.length > 2 && (
                    <span className="text-xs text-[var(--muted-foreground)]">+{memo.tags.length - 2}</span>
                  )}
                </div>
              )}
            </div>
            <span className="text-xs text-[var(--muted-foreground)] shrink-0">
              {formatTimeAgo(memo.createdAt)}
            </span>
          </div>
        </div>
        <div className="absolute items-center gap-1 z-100 right-3 shrink-0">
          <DropdownMenu open={openDropdown === memo.id} onOpenChange={(open) => open ? onOpenDropdown(memo.id) : onOpenDropdown(null)}>
            <DropdownMenuTrigger asChild>
              <button
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--muted)] transition-opacity"
                onClick={(e) => { e.stopPropagation(); }}
              >
                <MoreHorizontal className="w-4 h-4 text-[var(--muted-foreground)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="p-1">
              <DropdownMenuItem onClick={async () => {
                onOpenDropdown(null);
                onFavoriteToggle(memo);
              }}>
                {memo.favorited ? <><BookmarkIcon weight="fill" className="w-4 h-4 mr-2" /> 取消收藏</> : <><BookmarkSimpleIcon className="w-4 h-4 mr-2" /> 收藏</>}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { onOpenDropdown(null); onDelete(memo); }}>
                <TrashIcon className="w-4 h-4 mr-2" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}