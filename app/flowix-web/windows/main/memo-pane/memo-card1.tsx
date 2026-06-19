'use client';

import { memo } from 'react';
import { displayTitleFromFilename } from '../../../lib/utils';
import { MoreHorizontal } from 'lucide-react';
import { PushPin } from "@phosphor-icons/react";
import { MEMO_COLOR_HEX, type MemoItem } from '../../../lib/store';
import { cn } from '../../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../../../components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '../../../components/ui/context-menu';
import { MemoCardActions } from './memo-card-actions';

interface MemoCardProps {
  memo: MemoItem;
  tagMap: Record<string, string>;
  selectedMemo: MemoItem | null;
  openDropdown: string | null;
  onOpenDropdown: (id: string | null) => void;
  onSelect: (memo: MemoItem) => void;
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

export function MemoCardImpl({
  memo,
  tagMap,
  selectedMemo,
  openDropdown,
  onOpenDropdown,
  onSelect,
  onFavoriteToggle,
  onDelete,
}: MemoCardProps) {
  const selectedIdentifier = selectedMemo?.id || null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onClick={() => onSelect(memo)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", memo.id);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onDragEnd={(e) => {
            // 拖动结束时不主动打开新窗口 — 双击 / 拖动打开独立窗口的 IPC
            // (window:openMemoWindow) 后端未注册, 触发过 "Command not found" 错误。
            // 当前没有可靠的"在新窗口打开 memo"通道, 这里保持 no-op, 避免静默报错。
            // 拖动期间数据已在 dragstart 写入 dataTransfer, 外部应用 (Finder/Explorer)
            // 仍可拿到 memo.id 当作 text/plain 接收。
            void e.dataTransfer.getData("text/plain");
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
                  {memo.colors.length > 0 && (
                    <span
                      aria-hidden="true"
                      className="mr-1.5 inline-flex items-center gap-0.5 align-middle"
                    >
                      {memo.colors.map((c) => (
                        <span
                          key={c}
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: MEMO_COLOR_HEX[c] }}
                        />
                      ))}
                    </span>
                  )}
                  <span className="min-w-0">
                    {displayTitleFromFilename(memo.filename) || '未命名的笔记'}
                  </span>
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
                  {memo.favorited && <PushPin weight="fill" className="w-3.5 h-3.5 text-[var(--foreground)]" />}
                  {memo.tags && memo.tags.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      {memo.tags.slice(0, 2).map((tagId) => (
                        <span
                          key={tagId}
                          className="inline-flex items-center px-1 py-0 text-xs rounded-[6px] border border-[var(--border)] text-[var(--muted-foreground)]"
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
                <DropdownMenuTrigger
                  asChild
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--muted)] transition-opacity"
                  >
                    <MoreHorizontal className="w-4 h-4 text-[var(--muted-foreground)]" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[180px] px-1 py-1.5 space-y-1">
                  <MemoCardActions
                    memo={memo}
                    onFavoriteToggle={(m) => { onOpenDropdown(null); onFavoriteToggle(m); }}
                    onDelete={(m) => { onOpenDropdown(null); onDelete(m); }}
                    Item={DropdownMenuItem}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-[180px] px-1 py-1.5 space-y-1">
        <MemoCardActions
          memo={memo}
          onFavoriteToggle={onFavoriteToggle}
          onDelete={onDelete}
          Item={ContextMenuItem}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * 列表里千张卡每次重渲是大头开销 ── React.memo 默认浅比较即可:
 * - memo: MemoItem 引用由 store 决定，setNotebooks / updateMemoMeta 等不变这张卡就不变
 * - tagMap / selectedMemo / openDropdown: 父组件稳定
 * - 4 个 handler: useCallback / useState setter 都是稳定引用
 *
 * 仅在该 memo 自身字段变化（如 upsertMemo / 收藏切换）时重渲，
 * 其他 999 张卡零成本跳过。
 */
export const MemoCard = memo(MemoCardImpl);
