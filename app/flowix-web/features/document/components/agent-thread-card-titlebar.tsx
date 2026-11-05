import { useWorkspaceHeaderFullscreen } from '@features/workspace/public/header-api';
import { useEffect, useState } from 'react';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import type { WorkspaceColumnId } from '@features/workspace/public/host-api';
import { ICON_FULLSCREEN_EXIT_PATH } from '@features/agent/thread-card/agent-thread-card-icons';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { AgentConversationMoreMenu } from '@features/agent/components/agent-conversation-more-menu';
import { AgentConversationIdentity } from '@features/agent/components/agent-conversation-identity';

const AGENT_THREAD_CARD_FULLSCREEN_RENAME_EVENT =
  'flowix:agent-thread-card-fullscreen-rename';
const AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT =
  'flowix:agent-thread-card-request-fullscreen';

/** Fullscreen state is published by its owning card, scoped to one host. */
export type AgentThreadCardFullscreenHost = WorkspaceColumnId;

export function useAgentThreadCardFullscreenActive(host: AgentThreadCardFullscreenHost = 'column-1'): boolean {
  return useWorkspaceHeaderFullscreen(host) !== null;
}

export function useFullscreenAgentThreadCardInfo(host: AgentThreadCardFullscreenHost = 'column-1') {
  return useWorkspaceHeaderFullscreen(host);
}

/** The exit affordance for an embedded fullscreen Thread Card. */
export function AgentThreadCardFullscreenExitButton({
  className,
  host = 'column-1',
}: {
  className: string;
  host?: AgentThreadCardFullscreenHost;
}) {
  const { t } = useI18n();
  const active = useAgentThreadCardFullscreenActive(host);

  if (!active) return null;

  return (
    <Tooltip content={t('editor.threadCard.exitFullscreen')}>
      <button
        type="button"
        onClick={() => {
          window.dispatchEvent(new CustomEvent(AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT, {
            detail: { host, exitOthers: true },
          }));
        }}
        aria-label={t('editor.threadCard.exitFullscreen')}
        title={t('editor.threadCard.exitFullscreen')}
        className={`${className} [-webkit-app-region:no-drag]`}
      >
        <svg
          viewBox="0 0 256 256"
          aria-hidden="true"
          focusable="false"
          className="agent-thread-card__fullscreen-icon"
        >
          <path d={ICON_FULLSCREEN_EXIT_PATH} fill="currentColor" />
        </svg>
      </button>
    </Tooltip>
  );
}

/** Agent conversation menu rendered in the existing work-column titlebar slot. */
export function AgentThreadCardFullscreenMoreMenu({
  iconButtonClass,
  host = 'column-1',
}: {
  iconButtonClass: string;
  host?: AgentThreadCardFullscreenHost;
}) {
  const info = useFullscreenAgentThreadCardInfo(host);
  const storedInstance = useAgentSessionStore((state) =>
    info?.instanceId ? state.getInstance(info.instanceId) : null,
  );
  const instance: AgentConversationInstance | null = storedInstance ?? (
    info?.instanceId ? {
      instanceId: info.instanceId,
      agentType: info.typeKey,
      title: info.title,
      threadId: info.threadId,
      source: { kind: 'thread-card' },
      createdAt: 0,
      updatedAt: 0,
    } : null
  );

  if (!info || !instance) return null;

  return (
    <AgentConversationMoreMenu
      instance={instance}
      iconButtonClass={iconButtonClass}
      onRename={() => window.dispatchEvent(new CustomEvent(AGENT_THREAD_CARD_FULLSCREEN_RENAME_EVENT, {
        detail: { host, instanceId: instance.instanceId },
      }))}
    />
  );
}

/** Shared Agent identity displayed in a column titlebar while a conversation is fullscreen. */
export function AgentThreadCardFullscreenIdentity({
  host = 'column-1',
}: {
  host?: AgentThreadCardFullscreenHost;
} = {}) {
  const { t } = useI18n();
  const info = useFullscreenAgentThreadCardInfo(host);
  const [renameRequest, setRenameRequest] = useState(0);
  const instance = useAgentSessionStore((state) =>
    info?.instanceId ? state.getInstance(info.instanceId) : null,
  );

  useEffect(() => {
    const handleRename = (event: Event) => {
      const detail = (event as CustomEvent<{
        host?: AgentThreadCardFullscreenHost;
        instanceId?: string;
      }>).detail;
      if (detail?.host !== host || detail.instanceId !== info?.instanceId) return;
      setRenameRequest((request) => request + 1);
    };
    window.addEventListener(AGENT_THREAD_CARD_FULLSCREEN_RENAME_EVENT, handleRename);
    return () => window.removeEventListener(AGENT_THREAD_CARD_FULLSCREEN_RENAME_EVENT, handleRename);
  }, [host, info?.instanceId]);

  if (!info) return null;

  return (
    <AgentConversationIdentity
      instanceId={info.instanceId}
      title={instance?.title?.trim() || info.title || t('common.untitled')}
      typeKey={instance?.agentType ?? info.typeKey}
      threadId={instance?.threadId ?? info.threadId}
      sessionId={instance?.providerSessionId}
      renameRequest={renameRequest}
      className="ml-2 min-w-0"
    />
  );
}

