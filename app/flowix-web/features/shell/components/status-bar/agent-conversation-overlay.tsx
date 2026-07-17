'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutGrid, X } from 'lucide-react';
import type { AgentTypeKey } from '@/types/agent';
import { AGENT_TYPES, getAgentType, isAgentTypeComingSoon } from '@/lib/agent-types';
import { cn } from '@/lib/utils';
import { Kbd } from '@shared/ui/shortcut-kbd';
import {
  selectIsAgentConversationRunning,
  useAgentConversationStore,
  type AgentConversationInstance,
} from '@features/agent/store/agent-conversation-store';
import { useChatStore } from '@features/agent/store/chat-store';
import { useDocumentStore } from '@features/document';
import { useI18n } from '@features/i18n';
import { openNoteByMemoId } from '@platform/open-target';

interface AgentConversationOverlayProps {
  initialAgentType: AgentTypeKey;
  onClose: () => void;
}

type AgentConversationFilter = 'all' | AgentTypeKey;

export function AgentConversationOverlay({
  initialAgentType,
  onClose,
}: AgentConversationOverlayProps) {
  const { language, t } = useI18n();
  const [activeType, setActiveType] = useState<AgentConversationFilter>(initialAgentType);
  const instancesMap = useAgentConversationStore((state) => state.instances);
  const instancesByType = useMemo(() => {
    const result = {} as Record<AgentTypeKey, AgentConversationInstance[]>;
    for (const type of AGENT_TYPES) {
      result[type.key] = Object.values(instancesMap)
        .filter((instance) => instance.agentType === type.key)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return result;
  }, [instancesMap]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const formatDate = (timestamp: number) => new Intl.DateTimeFormat(
    language === 'zh-CN' ? 'zh-CN' : 'en-US',
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  ).format(new Date(timestamp));

  const openConversation = async (instance: AgentConversationInstance) => {
    const source = instance.source;
    if (!source.memoId && !source.documentPath) return;
    if (instance.threadId) {
      useChatStore.getState().setActiveAgentThread(instance.agentType, instance.threadId);
    }
    if (source.memoId) {
      await openNoteByMemoId(source.memoId);
      onClose();
      return;
    }
    if (source.documentPath) {
      await useDocumentStore.getState().openExternalDocument(source.documentPath);
      onClose();
    }
  };

  const activeInstances = useMemo(
    () => activeType === 'all'
      ? Object.values(instancesMap).sort((a, b) => b.updatedAt - a.updatedAt)
      : instancesByType[activeType],
    [activeType, instancesByType, instancesMap],
  );
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('status.agent.history.title')}
      className="fixed inset-0 z-[1700] bg-[color-mix(in_oklch,var(--card)_64%,transparent)] backdrop-blur-md animate-in fade-in-0"
    >
      <div className="absolute right-2 top-2 z-20 flex items-center gap-1">
        <Kbd chord="ESC" className="px-1.5 text-[var(--muted-foreground)]" />
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-8 py-8">
        <header className="relative mx-auto flex h-16 w-full max-w-xl shrink-0 items-center justify-center">
          <nav className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveType('all')}
              title={t('status.agent.history.all')}
              aria-label={t('status.agent.history.all')}
              aria-pressed={activeType === 'all'}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full border transition-all',
                activeType === 'all'
                  ? 'border-[color-mix(in_oklch,var(--primary)_50%,transparent)] bg-[color-mix(in_oklch,var(--card)_84%,transparent)]'
                  : 'border-transparent text-[var(--muted-foreground)] hover:bg-[color-mix(in_oklch,var(--card)_56%,transparent)] hover:text-[var(--foreground)]',
              )}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            {AGENT_TYPES.map((type) => {
              const active = type.key === activeType;
              const comingSoon = isAgentTypeComingSoon(type.key);
              return (
                <button
                  key={type.key}
                  type="button"
                  disabled={comingSoon}
                  onClick={() => setActiveType(type.key)}
                  title={type.name}
                  aria-label={type.name}
                  aria-pressed={active}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full border transition-all',
                    active
                      ? 'border-[color-mix(in_oklch,var(--primary)_50%,transparent)] bg-[color-mix(in_oklch,var(--card)_84%,transparent)]'
                      : 'border-transparent hover:bg-[color-mix(in_oklch,var(--card)_56%,transparent)]',
                    comingSoon && 'cursor-not-allowed opacity-35',
                  )}
                >
                  <img
                    src={type.icon}
                    alt=""
                    className="h-4 w-4 object-contain"
                    draggable={false}
                  />
                </button>
              );
            })}
          </nav>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto border-t border-[color-mix(in_oklch,var(--border)_72%,transparent)] py-6">
          <div className="mx-auto w-full max-w-xl">
            {activeInstances.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-sm text-[var(--muted-foreground)]">
                {t('status.agent.noConversations')}
              </div>
            ) : (
              <div>
                {activeInstances.map((instance) => {
                  const canOpen = Boolean(instance.source.memoId || instance.source.documentPath);
                  const running = selectIsAgentConversationRunning(instance);
                  return (
                    <button
                      key={instance.instanceId}
                      type="button"
                      disabled={!canOpen}
                      onClick={() => void openConversation(instance)}
                      title={canOpen ? t('status.agent.openRun') : t('status.agent.originUnavailable')}
                      className={cn(
                        'flex h-14 w-full items-center gap-3 rounded-xl border border-transparent bg-transparent px-4 text-left transition-colors',
                        canOpen
                          ? 'hover:border-[color-mix(in_oklch,var(--border)_76%,transparent)] hover:bg-[color-mix(in_oklch,var(--card)_76%,transparent)]'
                          : 'cursor-not-allowed opacity-55',
                      )}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center">
                        <img
                          src={getAgentType(instance.agentType).icon}
                          alt=""
                          className="h-3.5 w-3.5 object-contain"
                          draggable={false}
                        />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--foreground)]">
                        {instance.title?.trim() || t('common.untitled')}
                      </span>
                      {running && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary)]" />}
                      <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
                        {formatDate(instance.updatedAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>,
    document.body,
  );
}
