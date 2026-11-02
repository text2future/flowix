'use client';

import { resolveWorkspaceHeaderModel } from '@features/workspace/public/header-api';

import { useCallback, useState } from 'react';
import {
  FileTextIcon,
  LinkBreakIcon,
} from '@phosphor-icons/react';

import { useI18n } from '@/lib/i18n';
import { isWindowsPlatform } from '@features/shortcuts';
import {
  TITLEBAR_ICON_BUTTON_CLASS,
  TITLEBAR_ICON_BUTTON_FRAMELESS_CLASS,
} from '@shared/ui/titlebar-icon-button';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { openNoteByNotebookPath, openNoteByPhysicalPath } from '@features/memo/public/note-navigation-api';
import { openWorkspaceSurface } from '@features/workspace/public/session-opening-api';
import { getAgentConversationPresentation } from '@features/agent/conversation-presentation';
import { toast } from '@/lib/toast';
import { WorkColumnTitlebar } from '@features/shell/components/work-column-titlebar';
import { WorkColumnTitlebarNavigation } from '@features/shell/components/work-column-titlebar-navigation';
import { WorkColumnBrowserExpandButton } from '@features/shell/public/work-column-api';
import { AgentConversationMoreMenu } from '@features/agent/components/agent-conversation-more-menu';
import { AgentConversationIdentity } from '@features/agent/components/agent-conversation-identity';

function AgentConversationHeader({ instanceId }: { instanceId: string }) {
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
      ? openNoteByNotebookPath(source.notebookId, source.relativePath)
      : source?.documentPath
        ? openNoteByPhysicalPath(source.documentPath).catch(() => openWorkspaceSurface({
          host: 'main-third',
          target: { kind: 'external', path: source.documentPath!, scopePath: null, transitionId: null },
        }).then(() => undefined))
        : Promise.resolve();
    void open.catch(() => toast.error(t('status.agent.originUnavailable')));
  }, [instance, presentation, t]);

  if (!instance || !presentation) return null;
  const actionButtonClass = TITLEBAR_ICON_BUTTON_CLASS;

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
            className={`${actionButtonClass} [-webkit-app-region:no-drag]`}
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
        <WorkColumnBrowserExpandButton
          iconButtonClass={TITLEBAR_ICON_BUTTON_FRAMELESS_CLASS}
        />
        <AgentConversationMoreMenu
          instance={instance}
          iconButtonClass={actionButtonClass}
          onRename={() => setRenameRequest((request) => request + 1)}
        />
      </div>
    </div>
  );
}

export function AgentConversationTitlebar({
  reserveWindowsControls = true,
  instanceId,
  isMiddleColumnCollapsed,
  isSidebarVisible,
  onExpandSidebar,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
}: {
  instanceId: string;
  reserveWindowsControls?: boolean;
  isMiddleColumnCollapsed: boolean;
  isSidebarVisible: boolean;
  onExpandSidebar: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
}) {
  const isWindows = isWindowsPlatform();

  return (
    <WorkColumnTitlebar
      isWindows={isWindows}
      reserveWindowsControls={reserveWindowsControls}
      showTrafficLightSpacer={isMiddleColumnCollapsed && !isSidebarVisible}
      className="agent-conversation-titlebar"
      header={resolveWorkspaceHeaderModel({ chrome: 'agent' })}
    >
      <WorkColumnTitlebarNavigation
        sidebar={{ hidden: isMiddleColumnCollapsed, onToggle: onExpandSidebar }}
        navigation={{ canNavigateBack, canNavigateForward, onNavigateBack, onNavigateForward }}
      />
      <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch">
        <AgentConversationHeader instanceId={instanceId} />
      </div>
    </WorkColumnTitlebar>
  );
}
