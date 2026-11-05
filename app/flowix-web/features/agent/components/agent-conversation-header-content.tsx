'use client';

import { useCallback, useState, type ReactNode } from 'react';
import {
  FileTextIcon,
  LinkBreakIcon,
} from '@phosphor-icons/react';

import { useI18n } from '@/lib/i18n';
import {
  TITLEBAR_ICON_BUTTON_CLASS,
} from '@shared/ui/titlebar-icon-button';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { openNoteByNotebookPath, openNoteByPhysicalPath } from '@features/memo/public/note-navigation-api';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';
import { openWorkspaceSurface } from '@features/workspace/public/session-opening-api';
import { getAgentConversationPresentation } from '@features/agent/conversation-presentation';
import { toast } from '@/lib/toast';
import { AgentConversationMoreMenu } from '@features/agent/components/agent-conversation-more-menu';
import { AgentConversationIdentity } from '@features/agent/components/agent-conversation-identity';

export function AgentConversationHeaderContent({ instanceId, columnId, beforeMoreMenu }: { instanceId: string; columnId: WorkspaceColumnId; beforeMoreMenu?: ReactNode }) {
  const { t } = useI18n();
  const instance = useAgentSessionStore((state) => state.getInstance(instanceId));
  const [renameRequest, setRenameRequest] = useState(0);
  const presentation = instance
    ? getAgentConversationPresentation(instance, t('common.untitled'))
    : null;

  const onOpenSourceDocument = useCallback(() => {
    if (!instance || !presentation?.hasSourceDocument) return;
    const { source } = presentation;
    const open = source?.notebookId && source.relativePath
      ? openNoteByNotebookPath(source.notebookId, source.relativePath, null, { columnId })
      : source?.documentPath
        ? openNoteByPhysicalPath(source.documentPath, null, { columnId }).catch(() => openWorkspaceSurface({
          columnId: columnId,
          target: { kind: 'external', path: source.documentPath!, scopePath: null, transitionId: null },
        }).then(() => undefined))
        : Promise.resolve();
    void open.catch(() => toast.error(t('status.agent.originUnavailable')));
  }, [instance, presentation, columnId, t]);

  if (!instance || !presentation) return null;

  return (
    <div className="relative flex h-full min-w-0 flex-1 items-center gap-2 pl-1">
      <AgentConversationIdentity
        instanceId={instance.instanceId}
        title={presentation.title}
        typeKey={instance.agentType}
        threadId={instance.threadId}
        sessionId={instance.providerSessionId}
        cwd={presentation.runtimeCwd}
        renameRequest={renameRequest}
        className="h-full flex-1 pl-0"
      />
      <div className="ml-auto flex shrink-0 items-center gap-1 pr-2">
        {presentation.hasSourceDocument ? (
          <button
            type="button"
            onClick={onOpenSourceDocument}
            aria-label={t('document.agent.viewInNote')}
            title={t('document.agent.viewInNote')}
            className={`${TITLEBAR_ICON_BUTTON_CLASS} [-webkit-app-region:no-drag]`}
          >
            <FileTextIcon className="h-4 w-4" />
          </button>
        ) : (
          <span
            className="agent-thread-card__no-source"
            role="img"
            aria-label={t('document.agent.noSourceNote')}
            title={t('document.agent.noSourceNote')}
          >
            <LinkBreakIcon className="agent-thread-card__fullscreen-icon" aria-hidden="true" />
          </span>
        )}

        {beforeMoreMenu}
        <AgentConversationMoreMenu
          instance={instance}
          iconButtonClass={TITLEBAR_ICON_BUTTON_CLASS}
          onRename={() => setRenameRequest((request) => request + 1)}
        />
      </div>
    </div>
  );
}
