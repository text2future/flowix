'use client';

import { memo, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { displayTitleFromFilename } from '@/lib/utils';
import { ChevronRight, ListTodo } from 'lucide-react';
import { PushPin } from '@phosphor-icons/react';
import { MEMO_COLORS, MEMO_COLOR_HEX, useMemoStore } from '@features/memo/store/memo-store';
import type { MemoColor, MemoItem } from '@/types/memo-item';
import { cn } from '@/lib/utils';
import { getAgentType } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { formatTimeAgo } from '@/lib/format-time-ago';
import { AgentIcon } from '@features/agent/components/agent-icon';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@shared/ui/context-menu';
import { getMemoColorLabel, MemoCardActions } from '@features/memo/components/memo-card-actions';
import { buildMemoCardContextMenuItems } from '@features/memo/menus/memo-card-context-menu';
import { assetUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';
import { TagIcon } from '@shared/ui/tag-icon';
import { memos as memosClient, product } from '@platform/tauri/client';
import { resolveMemoSessionPath } from '@features/memo/use-cases/open-memo-session';
import { toast } from '@/lib/toast';
import { canUseNativeContextMenu, logNativeContextMenuError, popupNativeContextMenu } from '@platform/tauri/native-context-menu';
import { loadNativeMenuIcons } from '@platform/tauri/native-menu-icons';

const MEMO_CARD_NATIVE_ICON_NAMES = [
  'split', 'pin', 'unpin', 'info', 'link', 'copy', 'folder-open', 'palette', 'delete',
] as const;

interface MemoCardProps {
  memo: MemoItem;
  tagMap: Record<string, string>;
  isSelected: boolean;
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
  children: ReactNode;
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

function memoFolderDisplayPath(memo: Pick<MemoItem, 'filename' | 'relativePath'>): string[] | null {
  const relativePath = (memo.relativePath?.trim() || memo.filename).replace(/\\/g, '/');
  const pathSegments = relativePath.split('/').filter((segment) => segment && segment !== '.');
  if (pathSegments.length < 2) return null;
  return pathSegments.slice(0, -1);
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

function MemoCardShell({
  memo,
  isSelected,
  children,
  onSelect,
  onOpenInWindow,
  onFavoriteToggle,
  onDelete,
  onColorsChange,
}: MemoCardShellProps) {
  const { t, language } = useI18n();

  useEffect(() => {
    if (!canUseNativeContextMenu()) return;
    void loadNativeMenuIcons(MEMO_CARD_NATIVE_ICON_NAMES)
      .catch((error) => logNativeContextMenuError('memo card icon preload', error));
  }, [memo.favorited]);

  const resolvePath = () => resolveMemoSessionPath(
    memo,
    useMemoStore.getState().selectedNotebook,
  );

  const writeClipboardText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    toast.success(t('document.command.copySuccess'));
  };

  const showNativeMenu = async (event: MouseEvent<HTMLDivElement>) => {
    if (!canUseNativeContextMenu()) return;
    event.preventDefault();
    event.stopPropagation();

    try {
      const loadedIcons = await loadNativeMenuIcons(MEMO_CARD_NATIVE_ICON_NAMES);
      await popupNativeContextMenu(event, buildMemoCardContextMenuItems({
        memo,
        icons: {
          split: loadedIcons.split!,
          pin: loadedIcons.pin!,
          unpin: loadedIcons.unpin!,
          info: loadedIcons.info!,
          link: loadedIcons.link!,
          copy: loadedIcons.copy!,
          folderOpen: loadedIcons['folder-open']!,
          palette: loadedIcons.palette!,
          delete: loadedIcons.delete!,
        },
        labels: {
          openInSplit: t('memo.action.openInSplit'),
          pin: t('memo.action.pin'),
          unpin: t('memo.action.unpin'),
          properties: t('document.action.properties'),
          copyLink: t('document.action.copyLink'),
          copyFullText: t('document.action.copyFullText'),
          reveal: t('memo.fileTree.reveal'),
          colorGroup: t('memo.list.filterColorGroup'),
          clearColor: t('document.color.clear'),
          delete: t('memo.action.delete'),
          colors: Object.fromEntries(MEMO_COLORS.map((color) => [color, getMemoColorLabel(color, language)])) as Record<MemoColor, string>,
        },
        onOpenInSplit: onOpenInWindow ? () => onOpenInWindow(memo) : undefined,
        onFavoriteToggle: () => onFavoriteToggle(memo),
        onOpenProperties: () => window.dispatchEvent(new CustomEvent('flowix:open-note-properties', {
          detail: { memoId: memo.id },
        })),
        onCopyLink: () => {
          const path = resolvePath();
          if (path) void writeClipboardText(path).catch(() => toast.error(t('document.command.copyFailed')));
        },
        onCopyFullText: () => {
          const path = resolvePath();
          if (!path) return;
          void memosClient.readDocument(path)
            .then((content) => writeClipboardText(content ?? ''))
            .catch(() => toast.error(t('document.command.copyFailed')));
        },
        onReveal: () => {
          const path = resolvePath();
          if (path) void product.revealInFileManager(path);
        },
        onColorsChange: onColorsChange ? (colors) => onColorsChange(memo, colors) : undefined,
        onDelete: () => onDelete(memo),
      }));
    } catch (error) {
      logNativeContextMenuError('memo card', error);
      toast.error(t('memo.fileTree.openFailed'));
    }
  };

  const card = (
    <div
      onClick={() => onSelect(memo)}
      onContextMenu={showNativeMenu}
      className={cn(
        'group memo-card relative min-w-0 w-full cursor-pointer rounded-lg px-2 transition-all',
        'py-3',
        isSelected && ['bg-[var(--accent)]', 'memo-card--selected'],
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {children}
        </div>
      </div>
    </div>
  );

  if (canUseNativeContextMenu()) return card;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {card}
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
  const folderDisplayPath = memoFolderDisplayPath(memo);

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
        <p className="line-clamp-2 text-sm">
          {folderDisplayPath && (
            <>
              {folderDisplayPath.map((segment, index) => (
                <span key={`${index}-${segment}`} className="text-[var(--muted-foreground)]">
                  {index > 0 && (
                    <ChevronRight
                      aria-hidden="true"
                      className="mx-0.5 inline-block h-3 w-3 align-[-2px] opacity-70"
                    />
                  )}
                  {segment}
                </span>
              ))}
              {' '}
            </>
          )}
          <span className="text-[var(--foreground)] opacity-50">
            {memo.preview || emptyPreviewLabel}
          </span>
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
                    <span className="min-w-0 truncate">
                      <TagIcon prefix />
                      {tagLabel}
                    </span>
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
  tagMap,
  isSelected,
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
      onSelect={onSelect}
      onOpenInWindow={onOpenInWindow}
      onFavoriteToggle={onFavoriteToggle}
      onDelete={onDelete}
      onColorsChange={onColorsChange}
    >
      <DetailedMemoCardBody {...bodyProps} />
    </MemoCardShell>
  );
}

export const MemoCard = memo(MemoCardImpl);
