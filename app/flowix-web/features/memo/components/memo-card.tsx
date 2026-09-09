'use client';

import { memo, useEffect, useState, type ReactNode } from 'react';
import { displayTitleFromFilename } from '@/lib/utils';
import { ListTodo, MoreHorizontal } from 'lucide-react';
import { PushPin } from '@phosphor-icons/react';
import { MEMO_COLOR_HEX, type MemoColor, type MemoItem } from '@features/memo';
import { cn } from '@/lib/utils';
import { getAgentType } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { formatTimeAgo } from '@/lib/format-time-ago';
import { AgentIcon } from '@features/agent/components/agent-icon';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@shared/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@shared/ui/context-menu';
import { MemoCardActions } from '@features/memo/components/memo-card-actions';
import { assetUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';
import type { MemoCardVariant } from '@/lib/constants';

interface MemoCardProps {
  memo: MemoItem;
  variant?: MemoCardVariant;
  tagMap: Record<string, string>;
  isSelected: boolean;
  isDropdownOpen: boolean;
  onOpenDropdown: (id: string | null) => void;
  onSelect: (memo: MemoItem) => void;
  onOpenInWindow?: (memo: MemoItem) => void;
  onFavoriteToggle: (memo: MemoItem) => void;
  onDelete: (memo: MemoItem) => void;
  onColorsChange?: (memo: MemoItem, colors: MemoColor[]) => void;
  runningAgentType?: AgentTypeKey;
}

interface MemoCardBodyProps {
  memo: MemoItem;
  tagMap: Record<string, string>;
  title: string;
  timeLabel: string;
  hasAgents: boolean;
  hasTodos: boolean;
  relativeDirectory: string;
  runningAgentType?: AgentTypeKey;
  thumbnail: string | null;
  thumbnailFailed: boolean;
  onThumbnailFailed: () => void;
  emptyPreviewLabel: string;
}

interface MemoCardShellProps {
  memo: MemoItem;
  variant: MemoCardVariant;
  isSelected: boolean;
  isDropdownOpen: boolean;
  moreLabel: string;
  children: ReactNode;
  onOpenDropdown: (id: string | null) => void;
  onSelect: (memo: MemoItem) => void;
  onOpenInWindow?: (memo: MemoItem) => void;
  onFavoriteToggle: (memo: MemoItem) => void;
  onDelete: (memo: MemoItem) => void;
  onColorsChange?: (memo: MemoItem, colors: MemoColor[]) => void;
}

function thumbnailSrc(thumbnail: string | null | undefined): string | null {
  if (!thumbnail) return null;
  const storageKey = decodeStorageKey(thumbnail);
  return storageKey ? assetUrl(storageKey) : thumbnail;
}

function AgentTodoIcons({
  hasTodos,
  runningAgentType,
  className,
  lineCenter = false,
}: {
  hasTodos: boolean;
  runningAgentType?: AgentTypeKey;
  className?: string;
  /** 大卡(detailed)：徽章保持原尺寸，在标题行高内垂直居中（小卡 flex 居中不受影响）。 */
  lineCenter?: boolean;
}) {
  // AI 仅在"运行中"才露出圆圈 loading; 非运行态不显示。
  const runningAgent = runningAgentType ? getAgentType(runningAgentType) : null;
  if (!runningAgent && !hasTodos) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-[var(--muted-foreground)]',
        lineCenter && 'memo-card__agent-icons--line-center',
        className,
      )}
    >
      {runningAgent && (
        // 仅在 AI 运行中展示 star-four 图标, 主色高亮。
        <span className="memo-card__running-agent-icon">
          <AgentIcon
            typeKey={runningAgent.key}
            alt=""
            className="h-full w-full object-contain"
          />
        </span>
      )}
      {hasTodos && (
        <ListTodo className="h-3.5 w-3.5" />
      )}
    </span>
  );
}

function ColorDots({ colors, limit, className }: { colors: MemoItem['colors']; limit?: number; className?: string }) {
  const visibleColors = limit ? colors.slice(0, limit) : colors;
  if (visibleColors.length === 0) return null;
  return (
    <span aria-hidden={true} className={cn('inline-flex shrink-0 items-center gap-0.5', className)}>
      {visibleColors.map((color) => (
        <span
          key={color}
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: MEMO_COLOR_HEX[color] }}
        />
      ))}
    </span>
  );
}

function MemoCardMoreMenu({
  memo,
  variant,
  isDropdownOpen,
  moreLabel,
  onOpenDropdown,
  onOpenInWindow,
  onFavoriteToggle,
  onDelete,
  onColorsChange,
}: Pick<
  MemoCardShellProps,
  'memo' | 'variant' | 'isDropdownOpen' | 'moreLabel' | 'onOpenDropdown' | 'onOpenInWindow' | 'onFavoriteToggle' | 'onDelete' | 'onColorsChange'
>) {
  return (
    <div className="absolute right-3 top-2 z-100 shrink-0 items-center gap-1">
      <DropdownMenu
        open={isDropdownOpen}
        onOpenChange={(open) => onOpenDropdown(open ? memo.id : null)}
      >
        <DropdownMenuTrigger
          asChild
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label={moreLabel}
            className={cn(
              'rounded p-1 text-[var(--muted-foreground)] opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-[var(--foreground)]',
              variant === 'compact' && 'bg-[var(--accent)]',
            )}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
        >
          <MemoCardActions
            memo={memo}
            onOpenInSplit={
              onOpenInWindow
                ? (nextMemo) => {
                    onOpenDropdown(null);
                    onOpenInWindow(nextMemo);
                  }
                : undefined
            }
            onFavoriteToggle={(nextMemo) => {
              onOpenDropdown(null);
              onFavoriteToggle(nextMemo);
            }}
            onDelete={(nextMemo) => {
              onOpenDropdown(null);
              onDelete(nextMemo);
            }}
            onColorsChange={
              onColorsChange
                ? (nextMemo, nextColors) => {
                    onOpenDropdown(null);
                    onColorsChange(nextMemo, nextColors);
                  }
                : undefined
            }
            Item={DropdownMenuItem}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function MemoCardShell({
  memo,
  variant,
  isSelected,
  isDropdownOpen,
  moreLabel,
  children,
  onOpenDropdown,
  onSelect,
  onOpenInWindow,
  onFavoriteToggle,
  onDelete,
  onColorsChange,
}: MemoCardShellProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onClick={() => onSelect(memo)}
          className={cn(
            'group memo-card relative min-w-0 w-full cursor-pointer rounded-lg px-2 transition-all',
            variant === 'compact' ? 'py-[9px]' : 'py-3',
            variant === 'compact' && !isSelected && 'hover:bg-[var(--muted)]',
            isSelected && 'bg-[var(--accent)]',
          )}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {children}
            </div>
          </div>
          <MemoCardMoreMenu
            memo={memo}
            variant={variant}
            isDropdownOpen={isDropdownOpen}
            moreLabel={moreLabel}
            onOpenDropdown={onOpenDropdown}
            onOpenInWindow={onOpenInWindow}
            onFavoriteToggle={onFavoriteToggle}
            onDelete={onDelete}
            onColorsChange={onColorsChange}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <MemoCardActions
          memo={memo}
          onFavoriteToggle={onFavoriteToggle}
          onDelete={onDelete}
          onColorsChange={onColorsChange}
          onOpenInSplit={onOpenInWindow}
          Item={ContextMenuItem}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CompactMemoCardBody({
  memo,
  title,
  hasTodos,
  runningAgentType,
  relativeDirectory,
}: MemoCardBodyProps) {
  return (
    <div className="flex h-5 w-full min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
      {runningAgentType && (
        <AgentTodoIcons
          hasTodos={false}
          runningAgentType={runningAgentType}
        />
      )}
      {memo.favorited && (
        <PushPin weight="fill" className="h-3.5 w-3.5 shrink-0 text-[var(--foreground)]" />
      )}
      <h3 className="w-0 min-w-0 flex-1 truncate text-sm font-normal text-[var(--foreground)]">
        {title}
      </h3>
      {relativeDirectory && (
        <span className="max-w-[35%] truncate text-[11px] text-[var(--muted-foreground)]" title={relativeDirectory}>
          {relativeDirectory}
        </span>
      )}
      <ColorDots colors={memo.colors} limit={1} className="mr-1" />
      {hasTodos && (
        <ListTodo className="mr-1 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)] transition-opacity group-hover:opacity-0" />
      )}
    </div>
  );
}

function DetailedMemoCardBody({
  memo,
  tagMap,
  title,
  timeLabel,
  hasTodos,
  runningAgentType,
  relativeDirectory,
  thumbnail,
  thumbnailFailed,
  onThumbnailFailed,
  emptyPreviewLabel,
}: MemoCardBodyProps) {
  return (
    <>
      <div className="space-y-2">
        <h3 className="mr-3 min-w-0 max-w-full overflow-hidden line-clamp-2 text-sm leading-[20px] text-[var(--foreground)]">
          {memo.colors.length > 0 && (
            <span className="mr-1.5 inline-flex items-center align-middle">
              <ColorDots colors={memo.colors} />
            </span>
          )}
          <AgentTodoIcons
            hasTodos={false}
            runningAgentType={runningAgentType}
            lineCenter
            className="mr-0.5"
          />
          <span className="min-w-0">{title}</span>
        </h3>
        {relativeDirectory && (
          <p className="truncate text-xs text-[var(--muted-foreground)]" title={relativeDirectory}>
            {relativeDirectory}
          </p>
        )}
        {thumbnail && !thumbnailFailed ? (
          <div className="relative h-16 w-[114px] overflow-hidden rounded-md border border-[color-mix(in_oklch,var(--border)_70%,transparent)] bg-[var(--muted)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[transform,box-shadow] group-hover:scale-[1.01] group-hover:shadow-[0_2px_6px_rgba(0,0,0,0.08)]">
            <img
              src={thumbnail}
              alt=""
              loading="lazy"
              draggable={false}
              onError={onThumbnailFailed}
              className="h-full w-full rounded-md object-cover"
            />
          </div>
        ) : null}
        <p className="line-clamp-2 text-sm text-[var(--foreground)] opacity-50">
          {memo.preview || emptyPreviewLabel}
        </p>
      </div>
      <div className="flex w-full items-center justify-between gap-2 pt-2">
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs tabular-nums text-[var(--muted-foreground)]">
            {timeLabel}
          </span>
          {(memo.favorited || hasTodos) && (
            <span className="inline-flex items-center gap-1">
              {memo.favorited && (
                <PushPin weight="fill" className="h-3.5 w-3.5 text-[var(--foreground)]" />
              )}
              {hasTodos && (
                <ListTodo className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
              )}
            </span>
          )}
        </div>
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden">
          {memo.tags && memo.tags.length > 0 && (
            <>
              {memo.tags.slice(0, 2).map((tagId) => {
                const tagLabel = tagMap[tagId] || tagId;

                return (
                  <span
                    key={tagId}
                    title={`#${tagLabel}`}
                    className="inline-flex min-w-0 max-w-full items-center rounded-[6px] border border-[var(--border)] px-1 py-0 text-xs text-[var(--muted-foreground)]"
                  >
                    <span className="min-w-0 truncate">#{tagLabel}</span>
                  </span>
                );
              })}
              {memo.tags.length > 2 && (
                <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
                  +{memo.tags.length - 2}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function MemoCardImpl({
  memo,
  variant = 'detailed',
  tagMap,
  isSelected,
  isDropdownOpen,
  onOpenDropdown,
  onSelect,
  onOpenInWindow,
  onFavoriteToggle,
  onDelete,
  onColorsChange,
  runningAgentType,
}: MemoCardProps) {
  const { t } = useI18n();
  const thumbnail = thumbnailSrc(memo.thumbnail);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const hasAgents = (memo.agents?.length ?? 0) > 0;
  const hasTodos = (memo.todos?.length ?? 0) > 0;
  const timeLabel = formatTimeAgo(memo.updatedAt || memo.createdAt, t);
  const title = displayTitleFromFilename(memo.filename) || t('memo.untitled');
  const relativePath = memo.relativePath || memo.filename;
  const relativeDirectory = relativePath.includes('/')
    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
    : '';
  const bodyProps: MemoCardBodyProps = {
    memo,
    tagMap,
    title,
    timeLabel,
    hasAgents,
    hasTodos,
    relativeDirectory,
    runningAgentType,
    thumbnail,
    thumbnailFailed,
    onThumbnailFailed: () => setThumbnailFailed(true),
    emptyPreviewLabel: t('memo.empty.preview'),
  };

  useEffect(() => {
    setThumbnailFailed(false);
  }, [thumbnail]);

  return (
    <MemoCardShell
      memo={memo}
      variant={variant}
      isSelected={isSelected}
      isDropdownOpen={isDropdownOpen}
      moreLabel={t('document.titlebar.moreTooltip')}
      onOpenDropdown={onOpenDropdown}
      onSelect={onSelect}
      onOpenInWindow={onOpenInWindow}
      onFavoriteToggle={onFavoriteToggle}
      onDelete={onDelete}
      onColorsChange={onColorsChange}
    >
      {variant === 'compact' ? (
        <CompactMemoCardBody {...bodyProps} />
      ) : (
        <DetailedMemoCardBody {...bodyProps} />
      )}
    </MemoCardShell>
  );
}

export const MemoCard = memo(MemoCardImpl);
