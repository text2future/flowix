'use client';

import { memo, useEffect, useState, type ReactNode } from 'react';
import { displayTitleFromFilename } from '@/lib/utils';
import { MoreHorizontal } from 'lucide-react';
import { CheckSquareIcon, PushPin } from '@phosphor-icons/react';
import { MEMO_COLOR_HEX, type MemoColor, type MemoItem } from '@features/memo';
import { cn } from '@/lib/utils';
import { getAgentType } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n, type I18nParams } from '@features/i18n';
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
  runningAgentType?: AgentTypeKey;
  thumbnail: string | null;
  thumbnailFailed: boolean;
  onThumbnailFailed: () => void;
  emptyPreviewLabel: string;
}

interface MemoCardShellProps {
  memo: MemoItem;
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

function formatTimeAgo(
  timestamp: number,
  t: (key: import('@features/i18n').I18nKey, params?: I18nParams) => string,
): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    const months = Math.floor(days / 30);
    return t('memo.time.monthsAgo', { m: months } satisfies I18nParams);
  }
  if (days > 0) return t('memo.time.daysAgo', { d: days } satisfies I18nParams);
  if (hours > 0) return t('memo.time.hoursAgo', { h: hours } satisfies I18nParams);
  if (minutes > 0) return t('memo.time.minutesAgo', { m: minutes } satisfies I18nParams);
  if (seconds > 0) return t('memo.time.secondsAgo', { s: seconds } satisfies I18nParams);
  return t('memo.time.justNow');
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
}: {
  hasTodos: boolean;
  runningAgentType?: AgentTypeKey;
  className?: string;
}) {
  // AI 仅在"运行中"才露出圆圈 loading; 非运行态不显示。
  const runningAgent = runningAgentType ? getAgentType(runningAgentType) : null;
  if (!runningAgent && !hasTodos) return null;
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center gap-0.5 text-[var(--muted-foreground)]', className)}
    >
      {runningAgent && (
        // 仅在 AI 运行中展示 star-four 图标, 主色高亮。
        <span className="memo-card__running-agent-icon">
          <img
            src={runningAgent.icon}
            alt=""
            draggable={false}
            className="h-full w-full object-contain"
          />
        </span>
      )}
      {hasTodos && (
        <CheckSquareIcon className="h-3.5 w-3.5" weight="regular" />
      )}
    </span>
  );
}

function ColorDots({ colors, limit }: { colors: MemoItem['colors']; limit?: number }) {
  const visibleColors = limit ? colors.slice(0, limit) : colors;
  if (visibleColors.length === 0) return null;
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-0.5">
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
  isDropdownOpen,
  moreLabel,
  onOpenDropdown,
  onFavoriteToggle,
  onDelete,
  onColorsChange,
}: Pick<
  MemoCardShellProps,
  'memo' | 'isDropdownOpen' | 'moreLabel' | 'onOpenDropdown' | 'onFavoriteToggle' | 'onDelete' | 'onColorsChange'
>) {
  return (
    <div className="absolute right-3 z-100 shrink-0 items-center gap-1">
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
            className="rounded p-1 opacity-0 transition-opacity hover:bg-[var(--muted)] group-hover:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4 text-[var(--muted-foreground)]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[180px] space-y-1 px-1 py-1.5">
          <MemoCardActions
            memo={memo}
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
          onDoubleClick={() => onOpenInWindow?.(memo)}
          className={cn(
            'group memo-card relative cursor-pointer rounded-xl px-3 py-3 transition-all',
            isSelected && 'bg-[var(--accent)]',
          )}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {children}
            </div>
            <MemoCardMoreMenu
              memo={memo}
              isDropdownOpen={isDropdownOpen}
              moreLabel={moreLabel}
              onOpenDropdown={onOpenDropdown}
              onFavoriteToggle={onFavoriteToggle}
              onDelete={onDelete}
              onColorsChange={onColorsChange}
            />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-[180px] space-y-1 px-1 py-1.5">
        <MemoCardActions
          memo={memo}
          onFavoriteToggle={onFavoriteToggle}
          onDelete={onDelete}
          onColorsChange={onColorsChange}
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
}: MemoCardBodyProps) {
  return (
    <div className="flex h-5 min-w-0 items-center gap-1.5">
      <ColorDots colors={memo.colors} limit={1} />
      {runningAgentType && (
        <AgentTodoIcons
          hasTodos={false}
          runningAgentType={runningAgentType}
        />
      )}
      {memo.favorited && (
        <PushPin weight="fill" className="h-3.5 w-3.5 shrink-0 text-[var(--foreground)]" />
      )}
      <h3 className="mr-3 min-w-0 truncate text-sm font-medium text-[var(--foreground)]">
        {title}
      </h3>
      {hasTodos && (
        <CheckSquareIcon
          className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)] transition-opacity group-hover:opacity-0"
          weight="regular"
        />
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
  thumbnail,
  thumbnailFailed,
  onThumbnailFailed,
  emptyPreviewLabel,
}: MemoCardBodyProps) {
  return (
    <>
      <div className="space-y-2">
        <h3 className="mr-3 line-clamp-2 text-sm leading-[20px] text-[var(--foreground)]">
          {memo.colors.length > 0 && (
            <span className="mr-1.5 inline-flex items-center align-middle">
              <ColorDots colors={memo.colors} />
            </span>
          )}
          <AgentTodoIcons
            hasTodos={false}
            runningAgentType={runningAgentType}
            className="mr-0.5"
          />
          <span className="min-w-0">{title}</span>
        </h3>
        {thumbnail && !thumbnailFailed ? (
          <div className="h-16 w-[114px] overflow-hidden rounded-md bg-[var(--muted)]">
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
        <div className="flex flex-wrap items-center gap-2">
          {(memo.favorited || hasTodos) && (
            <span className="inline-flex shrink-0 items-center gap-1">
              {memo.favorited && (
                <PushPin weight="fill" className="h-3.5 w-3.5 text-[var(--foreground)]" />
              )}
              {hasTodos && (
                <CheckSquareIcon
                  className="h-3.5 w-3.5 text-[var(--muted-foreground)]"
                  weight="regular"
                />
              )}
            </span>
          )}
          {memo.tags && memo.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {memo.tags.slice(0, 2).map((tagId) => (
                <span
                  key={tagId}
                  className="inline-flex items-center rounded-[6px] border border-[var(--border)] px-1 py-0 text-xs text-[var(--muted-foreground)]"
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
        <span className="shrink-0 text-xs tabular-nums text-[var(--muted-foreground)]">
          {timeLabel}
        </span>
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
  const bodyProps: MemoCardBodyProps = {
    memo,
    tagMap,
    title,
    timeLabel,
    hasAgents,
    hasTodos,
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
