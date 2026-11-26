'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { useTitleEditCaret } from '@shared/hooks/use-title-edit-caret';
import { getAgentType } from '@/lib/agent-types';
import { useAgentDataStore } from '@features/agent/store/agent-data-store';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { BadgeHoverCard } from '@features/agent/thread-card/badge-hover-card';
import { computeAgentThreadCardBadgeData } from '@features/agent/thread-card/runtime/run-status-presenter';
import { createRuntimeInfoRequester } from '@features/agent/thread-card/runtime/runtime-info-requester';
import { getResolvedExternalSessionId } from '@features/agent/services/external-agent-runtime-service';
import { getAgentConversationRuntimeCwd } from '@features/agent/conversation-presentation';

export interface AgentConversationIdentityProps {
  instanceId: string | null;
  title: string;
  typeKey: AgentTypeKey;
  threadId?: string | null;
  sessionId?: string | null;
  cwd?: string;
  renameRequest?: number;
  className?: string;
}

/** Shared Agent icon, runtime badge, conversation title, and title editing. */
export function AgentConversationIdentity({
  instanceId,
  title: fallbackTitle,
  typeKey: fallbackTypeKey,
  threadId: fallbackThreadId,
  sessionId: fallbackSessionId,
  cwd: fallbackCwd,
  renameRequest = 0,
  className = '',
}: AgentConversationIdentityProps) {
  const { t } = useI18n();
  const instance = useAgentSessionStore((state) =>
    instanceId ? state.getInstance(instanceId) : null,
  );
  const threadId = instance?.threadId ?? fallbackThreadId ?? null;
  const projection = useAgentSessionStore((state) =>
    threadId ? state.threadProjections[threadId] : undefined,
  );
  const codexModel = useAgentDataStore((state) => state.agents.codex.user.model?.id ?? 'inherit');
  const piCodeMode = useAgentDataStore((state) => (state.agents.pi.user.mode ?? 'code') === 'code');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const lastRenameRequest = useRef(renameRequest);
  const { inputRef: titleInputRef, captureCaret } = useTitleEditCaret(isEditingTitle);

  const typeKey = instance?.agentType ?? fallbackTypeKey;
  const title = instance?.title?.trim() || fallbackTitle || t('common.untitled');
  const productThreadId = threadId ?? '';
  const sessionId = instance?.providerSessionId ?? fallbackSessionId ?? (
    productThreadId ? getResolvedExternalSessionId(productThreadId) : null
  );
  const cwd = getAgentConversationRuntimeCwd(instance) ?? fallbackCwd;
  const agent = getAgentType(typeKey);

  const badgeData = useMemo(() => computeAgentThreadCardBadgeData({
    threadState: projection ? {
      lastRun: projection.runs.lastRun,
      activeRunId: projection.runs.activeRunId,
      runs: projection.runs.runs,
    } : undefined,
    codexModel,
    typeKey,
  }), [codexModel, projection, typeKey]);

  useEffect(() => {
    if (lastRenameRequest.current === renameRequest) return;
    lastRenameRequest.current = renameRequest;
    setTitleDraft(title);
    setIsEditingTitle(true);
  }, [renameRequest, title]);

  const commitTitle = () => {
    const nextTitle = titleDraft.trim();
    if (nextTitle && nextTitle !== title && instanceId) {
      void useAgentSessionStore.getState().renameAgentConversation({
        instanceId,
        threadId,
        title: nextTitle,
        typeKey,
      });
    }
    setIsEditingTitle(false);
  };

  return (
    <div className={`agent-conversation-identity ${className}`.trim()} data-tauri-drag-region>
      <span className="agent-conversation-identity__badge-anchor">
        <BadgeHoverCard
          threadId={productThreadId || undefined}
          sessionId={sessionId ?? undefined}
          runId={badgeData.runId}
          model={badgeData.model}
          usage={badgeData.usage}
          onRequestRuntimeInfo={createRuntimeInfoRequester(
            typeKey,
            () => {
              const current = instanceId
                ? useAgentSessionStore.getState().getInstance(instanceId)
                : null;
              return current?.threadId ?? fallbackThreadId;
            },
            () => {
              const current = instanceId
                ? useAgentSessionStore.getState().getInstance(instanceId)
                : null;
              const currentThreadId = current?.threadId ?? fallbackThreadId;
              return current?.providerSessionId ?? fallbackSessionId ?? (
                currentThreadId ? getResolvedExternalSessionId(currentThreadId) : null
              );
            },
          )}
          agentType={typeKey}
          piMode={typeKey === 'pi' ? (piCodeMode ? 'code' : 'writing') : undefined}
          cwd={cwd}
        />
        <span className="agent-type-badge shrink-0" aria-hidden="true" title={agent.desc}>
          <AgentIcon typeKey={agent.id} alt="" className="agent-type-badge__icon" />
        </span>
      </span>
      {isEditingTitle ? (
        <div className="agent-conversation-identity__title-wrap">
          <input
            ref={titleInputRef}
            value={titleDraft}
            aria-label={t('agent.chat.conversation.rename')}
            className="agent-conversation-identity__title-input"
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                commitTitle();
              }
              if (event.key === 'Escape') setIsEditingTitle(false);
            }}
          />
        </div>
      ) : (
        <span
          className="agent-conversation-identity__title"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            captureCaret(event.currentTarget, event.clientX, event.clientY);
            setTitleDraft(title);
            setIsEditingTitle(true);
          }}
        >
          {title}
        </span>
      )}
    </div>
  );
}
