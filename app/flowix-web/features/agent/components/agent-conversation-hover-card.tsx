'use client';

import type { ReactElement } from 'react';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { getAgentConversationRuntimeCwd } from '@features/agent/conversation-presentation';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { formatTimeAgo } from '@/lib/format-time-ago';
import { useI18n } from '@/lib/i18n';
import { openNoteByNotebookPath, openNoteByPhysicalPath } from '@features/memo/public/note-navigation-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { toast } from '@/lib/toast';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@shared/ui/hover-card';

function ConversationPreviewCard({ instance }: { instance: AgentConversationInstance }) {
  const { t } = useI18n();
  const projection = useAgentSessionStore((state) => (
    instance.threadId ? state.threadProjections[instance.threadId] : undefined
  ));
  const title = instance.title?.trim() || t('common.untitled');
  const source = instance.source;
  const sourcePath = source.relativePath?.trim() || source.documentPath?.trim() || '';
  const sourceSegments = sourcePath.split(/[\\/]/).filter(Boolean);
  const sourceFileName = sourceSegments[sourceSegments.length - 1] || sourcePath;
  const sourceDocumentName = sourceFileName.replace(/\.md$/i, '') || sourceFileName;
  const sourceFolderName = sourceSegments.length > 1 ? sourceSegments[sourceSegments.length - 2] : '';
  const sourceLabel = sourceFolderName ? `${sourceFolderName}/${sourceDocumentName}` : sourceDocumentName;
  const cwd = instance.frozenCwd?.trim() || getAgentConversationRuntimeCwd(instance) || '';
  const canOpenSource = Boolean(
    (source.notebookId && source.relativePath?.trim()) || source.documentPath?.trim(),
  );
  const loadedTurns = projection?.messages.filter((message) => message.role === 'user').length ?? 0;
  const turnsLabel = !instance.threadId
    ? t('memo.fileTree.conversationPreview.turns', { count: 0, more: '' })
    : projection?.pagination.initialStatus === 'ready'
      ? t('memo.fileTree.conversationPreview.turns', {
        count: loadedTurns,
        more: projection.pagination.hasMoreHistory ? '+' : '',
      })
      : t('memo.fileTree.conversationPreview.loading');

  const openSource = () => {
    if (!canOpenSource) return;
    const open = source.notebookId && source.relativePath
      ? openNoteByNotebookPath(source.notebookId, source.relativePath)
      : source.documentPath
        ? openNoteByPhysicalPath(source.documentPath).catch(() => openWorkspaceSurface({
          index: 0,
          target: { kind: 'external', path: source.documentPath!, scopePath: null, transitionId: null },
        }).then(() => undefined))
        : Promise.resolve();
    void open.catch(() => toast.error(t('status.agent.originUnavailable')));
  };

  return (
    <div className="w-[300px] max-w-[calc(100vw-24px)] rounded-xl border border-[var(--border-popup)] bg-[var(--popover)] p-3 text-[var(--popover-foreground)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <div className="flex min-w-0 items-start gap-2">
        <AgentIcon typeKey={instance.agentType} alt="" className="mt-0.5 h-4 w-4 shrink-0 object-contain" />
        <span className="min-w-0 flex-1 line-clamp-2 break-words text-sm font-normal leading-5" title={title}>{title}</span>
        <time
          className="shrink-0 text-xs leading-5 text-[var(--muted-foreground)]"
          dateTime={new Date(instance.updatedAt).toISOString()}
        >
          {formatTimeAgo(instance.updatedAt, t, { compact: true })}
        </time>
      </div>
      <div className="mt-0 pt-2">
        <div className="flex min-w-0 gap-1 text-xs" title={cwd || undefined}>
          <span className="shrink-0 text-[var(--muted-foreground)]">{t('memo.fileTree.conversationPreview.workspace')}</span>
          <span className="min-w-0 truncate text-left text-[var(--foreground)] [direction:rtl]">
            {cwd || t('memo.fileTree.conversationPreview.noWorkspace')}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
          <span>{turnsLabel}</span>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs">
          {canOpenSource ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                openSource();
              }}
              className="min-w-0 truncate text-left text-[var(--primary)] hover:underline"
              title={sourcePath}
            >
              {sourceLabel}
            </button>
          ) : (
            <span className="truncate text-[var(--muted-foreground)]">{t('memo.fileTree.conversationPreview.noDocument')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentConversationHoverCard({
  instance,
  children,
}: {
  instance: AgentConversationInstance;
  children: ReactElement;
}) {
  return (
    <HoverCard
      openDelay={350}
      closeDelay={120}
      onOpenChange={(open) => {
        if (!open || !instance.threadId) return;
        const projection = useAgentSessionStore.getState().threadProjections[instance.threadId];
        if (projection?.pagination.initialStatus !== 'ready') {
          void useAgentSessionStore.getState().loadMessages(instance.agentType, instance.threadId);
        }
      }}
    >
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={0} className="border-0 bg-transparent p-0 shadow-none">
        <ConversationPreviewCard instance={instance} />
      </HoverCardContent>
    </HoverCard>
  );
}
