'use client';

import { memo, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ListTodo, Loader2 } from 'lucide-react';
import { PushPin } from '@phosphor-icons/react';
import { NOTE_COLOR_HEX } from '@features/memo/store/note-store';
import {
  noteListItemRelativePath,
  type NoteColor,
  type NoteListItem,
} from '@/types/note-item';
import { cn, displayTitleFromFilename } from '@/lib/utils';
import { getAgentType } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { formatTimeAgo } from '@/lib/format-time-ago';
import { AgentIcon } from '@features/agent/public/icon-api';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@shared/ui/context-menu';
import { MemoCardActions } from '@features/memo/components/memo-card-actions';
import { resolveNoteThumbnailSrc } from '@/lib/note-thumbnail';
import { useNoteContext, type NoteContext } from '@features/memo/hooks/use-note-context';
import { TagIcon } from '@shared/ui/tag-icon';
import { joinNotebookMemoPath } from '@/lib/path';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { renameMarkdownTitle } from '@features/document/public/file-operations-api';
import { replaceExternalDocumentPath } from '@features/workspace/public/note-navigation-api';
import { toast } from '@/lib/toast';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { NotebookCopyContextMenu } from '@features/memo/components/notebook-copy-context-menu';
import { fileTreeRenameFailureKey } from './file-tree-failure';

interface MemoCardProps {
  memo: NoteListItem;
  tagMap: Record<string, string>;
  isSelected: boolean;
  onSelect: (memo: NoteListItem) => void;
  onOpenInWindow?: (memo: NoteListItem) => void;
  onFavoriteToggle: (memo: NoteListItem) => void;
  onDelete: (memo: NoteListItem) => void;
  onColorsChange?: (memo: NoteListItem, colors: NoteColor[]) => void;
  onKeepAliveChange?: (memo: NoteListItem, active: boolean) => void;
  runningAgentType?: AgentTypeKey;
}

interface MemoCardBodyProps {
  memo: NoteListItem;
  tagMap: Record<string, string>;
  title: string;
  timeLabel: string;
  hasAgents: boolean;
  hasTodos: boolean;
  runningAgentType?: AgentTypeKey;
  thumbnail: string | null;
  thumbnailFailed: boolean;
  onThumbnailFailed: () => void;
  description: string;
}

interface MemoCardShellProps {
  memo: NoteListItem;
  /** 由卡片主体解析一次后下发，避免每张卡重复订阅笔记本状态。 */
  noteContext: NoteContext;
  isSelected: boolean;
  children: ReactNode;
  onSelect: (memo: NoteListItem) => void;
  onOpenInWindow?: (memo: NoteListItem) => void;
  onFavoriteToggle: (memo: NoteListItem) => void;
  onDelete: (memo: NoteListItem) => void;
  onColorsChange?: (memo: NoteListItem, colors: NoteColor[]) => void;
  onKeepAliveChange?: (memo: NoteListItem, active: boolean) => void;
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
            typeKey={runningAgent.id}
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

function ColorDots({ colors, limit, className }: { colors: NoteListItem['colors']; limit?: number; className?: string }) {
  const visibleColors = limit ? colors.slice(0, limit) : colors;
  if (visibleColors.length === 0) return null;
  return (
    <span aria-hidden={true} className={cn('inline-flex shrink-0 items-center gap-0.5', className)}>
      {visibleColors.map((color) => (
        <span
          key={color}
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: NOTE_COLOR_HEX[color] }}
        />
      ))}
    </span>
  );
}

function MemoCardShell({
  memo,
  noteContext,
  isSelected,
  children,
  onSelect,
  onOpenInWindow,
  onFavoriteToggle,
  onDelete,
  onColorsChange,
  onKeepAliveChange,
}: MemoCardShellProps) {
  const { t } = useI18n();
  const { notebook, documentPath } = noteContext;
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const keepsRowAlive = contextMenuOpen || renameOpen || renameSaving;
  useEffect(() => {
    if (!keepsRowAlive) return;
    onKeepAliveChange?.(memo, true);
    return () => onKeepAliveChange?.(memo, false);
  }, [memo, keepsRowAlive, onKeepAliveChange]);

  const openRename = () => {
    setRenameDraft(displayTitleFromFilename(memo.filename));
    setRenameOpen(true);
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = renameDraft.trim();
    if (!title || !notebook?.path) return;

    const relativePath = noteListItemRelativePath(memo);
    const path = joinNotebookMemoPath(notebook.path, relativePath);
    if (!path) return;
    const identity = ensureFileDisplayIdentity(path);
    try {
      setRenameSaving(true);
      const result = await renameMarkdownTitle({
        path,
        title,
        scopePath: notebook.path,
        notebook,
        displayId: identity.displayId,
        onPathChanged: (oldPath, newPath) => replaceExternalDocumentPath(identity.displayId, oldPath, newPath),
      });
      if (result?.changed) {
        toast.success(t('memo.fileTree.renamed', { name: title }));
      }
      setRenameOpen(false);
    } catch (error) {
      toast.error(t(fileTreeRenameFailureKey(error)));
    } finally {
      setRenameSaving(false);
    }
  };

  const filePath = documentPath ?? noteListItemRelativePath(memo);

  const card = (
    <div
      onClick={() => onSelect(memo)}
      className={cn(
        'group memo-card relative min-w-0 w-full cursor-pointer rounded-lg px-2 transition-colors duration-150',
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

  return (
    <>
      <ContextMenu onOpenChange={setContextMenuOpen}>
        <ContextMenuTrigger asChild>
          {card}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <MemoCardActions
            memo={memo}
            filePath={filePath}
            onFavoriteToggle={onFavoriteToggle}
            onRename={openRename}
            onDelete={onDelete}
            onColorsChange={onColorsChange}
            onOpenInSplit={onOpenInWindow}
            hideCopyActions
            copyMenuBeforeReveal={<NotebookCopyContextMenu path={filePath} isNote />}
            Item={ContextMenuItem}
          />
        </ContextMenuContent>
      </ContextMenu>
      <Dialog open={renameOpen} onOpenChange={(open) => !renameSaving && setRenameOpen(open)}>
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader>
            <DialogTitle>{t('memo.fileTree.rename')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(event) => void submitRename(event)} className="space-y-4" aria-busy={renameSaving}>
            <Input
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              disabled={renameSaving}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenameOpen(false)} disabled={renameSaving}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={renameSaving || !renameDraft.trim()}>
                {renameSaving && <Loader2 className="flowix-spin" aria-hidden="true" />}
                {renameSaving ? t('memo.fileTree.renaming') : t('document.version.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
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
  description,
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
        {thumbnail && !thumbnailFailed ? (
          <div className="relative h-16 w-[114px] overflow-hidden rounded-md border border-[color-mix(in_oklch,var(--border)_70%,transparent)] bg-[var(--muted)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[transform,box-shadow] group-hover:scale-[1.01] group-hover:shadow-[0_2px_6px_rgba(0,0,0,0.08)]">
            <img
              src={thumbnail}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={onThumbnailFailed}
              className="h-full w-full rounded-md object-cover"
            />
          </div>
        ) : null}
        {description && <p className="line-clamp-2 text-sm">
          <span className="text-[var(--foreground)] opacity-50">{description}</span>
        </p>}
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
  onKeepAliveChange,
}: MemoCardProps) {
  const { t } = useI18n();
  const noteContext = useNoteContext(memo);
  // 缩略图可能是文档相对路径，需要笔记自身的绝对路径才能落到具体文件。
  const thumbnail = resolveNoteThumbnailSrc(memo.thumbnail, noteContext.documentPath);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const hasAgents = (memo.agents?.length ?? 0) > 0;
  const hasTodos = (memo.todos?.length ?? 0) > 0;
  const timeLabel = formatTimeAgo(memo.updatedAt || memo.createdAt, t);
  const fileTitle = displayTitleFromFilename(memo.filename || memo.relativePath).trim();
  const propertyTitle = typeof memo.properties.name === 'string' ? memo.properties.name.trim() : '';
  const title = fileTitle || propertyTitle || t('memo.untitled');
  const propertyDescription = typeof memo.properties.description === 'string' ? memo.properties.description.trim() : '';
  const description = propertyDescription || memo.preview.trim() || t('memo.list.emptyDescription');
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
    description,
  };

  useEffect(() => {
    setThumbnailFailed(false);
  }, [thumbnail]);

  return (
    <MemoCardShell
      memo={memo}
      noteContext={noteContext}
      isSelected={isSelected}
      onSelect={onSelect}
      onOpenInWindow={onOpenInWindow}
      onFavoriteToggle={onFavoriteToggle}
      onDelete={onDelete}
      onColorsChange={onColorsChange}
      onKeepAliveChange={onKeepAliveChange}
    >
      <DetailedMemoCardBody {...bodyProps} />
    </MemoCardShell>
  );
}

export const MemoCard = memo(MemoCardImpl);
