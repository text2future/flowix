'use client';

import { useEffect, useMemo, useState } from 'react';
import { StarFourIcon } from '@phosphor-icons/react';
import { ChevronRight } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { Button } from '@shared/ui/button';
import { AGENT_TYPES, getAgentType, isAgentTypeComingSoon } from '@/lib/agent-types';
import { cn } from '@/lib/utils';
import type { AgentTypeKey } from '@/types/agent';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { useChatStore } from '@features/agent/store/chat-store';
import {
  selectIsAgentConversationRunning,
  useAgentConversationStore,
  type AgentConversationInstance,
} from '@features/agent/store/agent-conversation-store';
import { useDocumentStore } from '@features/document';
import { openNoteByMemoId } from '@platform/open-target';
import { windows } from '@platform/tauri/client';
import { getAgentRuntimeStatusText } from '@features/agent/components/agent-runtime-status-list';
import { openAgentSetup } from '@features/agent/agent-setup';
import { useI18n } from '@features/i18n';

export function AgentRuntimeStatusMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [runningSubmenuType, setRunningSubmenuType] = useState<AgentTypeKey | null>(null);
  const statusByType = useAgentRuntimeStore((s) => s.statusByType);
  const isChecking = useAgentRuntimeStore((s) => s.isChecking);
  const refreshIfStale = useAgentRuntimeStore((s) => s.refreshIfStale);
  const instancesMap = useAgentConversationStore((s) => s.instances);
  const hasRunning = useMemo(
    () =>
      Object.values(instancesMap).some(selectIsAgentConversationRunning),
    [instancesMap],
  );
  const instancesByType = useMemo(() => {
    const map: Partial<Record<AgentTypeKey, AgentConversationInstance[]>> = {};
    for (const instance of Object.values(instancesMap)) {
      map[instance.agentType] = [...(map[instance.agentType] ?? []), instance];
    }
    for (const key of Object.keys(map) as AgentTypeKey[]) {
      map[key]?.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return map;
  }, [instancesMap]);

  useEffect(() => {
    if (open) {
      void refreshIfStale();
    } else {
      setRunningSubmenuType(null);
    }
  }, [open, refreshIfStale]);

  const openRunningInstance = async (instance: AgentConversationInstance) => {
    const threadId = instance.threadId;
    if (threadId) {
      useChatStore.getState().setActiveAgentThread(instance.agentType, threadId);
    }

    const source = instance.source;
    if (source.memoId) {
      await openNoteByMemoId(source.memoId);
      setOpen(false);
      return;
    }

    if (source.documentPath) {
      await useDocumentStore.getState().openExternalDocument(source.documentPath);
      setOpen(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} className="h-full self-stretch">
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-full self-stretch flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          aria-label="Agent runtime status"
          title="Agent runtime status"
        >
          <StarFourIcon
            className={cn(
              'w-3.5 h-3.5',
              hasRunning ? 'text-[var(--primary)]' : undefined,
            )}
            weight="regular"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={2}
        className="w-[12rem] overflow-visible p-1 bg-[var(--popover)]"
      >
        <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          Agents
        </DropdownMenuLabel>
        <div className="space-y-0.5">
          {AGENT_TYPES.map((type) => {
            const status = statusByType[type.key];
            const comingSoon = isAgentTypeComingSoon(type.key);
            const unavailable = comingSoon || status?.available === false;
            const statusText = getAgentRuntimeStatusText({ typeKey: type.key, status, isChecking, t });
            const canSetup = !comingSoon && status?.available === false;
            const canShowRunningSubmenu = !comingSoon && status?.available !== false;
            const instances = instancesByType[type.key] ?? [];

            return (
              <div
                key={type.key}
                className="relative"
                onMouseEnter={() => {
                  if (canShowRunningSubmenu) setRunningSubmenuType(type.key);
                }}
                onMouseLeave={() => {
                  if (runningSubmenuType === type.key) setRunningSubmenuType(null);
                }}
              >
                <button
                  type="button"
                  onFocus={() => {
                    if (canShowRunningSubmenu) setRunningSubmenuType(type.key);
                  }}
                  onClick={() => {
                    if (canSetup) void openAgentSetup(type.key).finally(() => setOpen(false));
                  }}
                  disabled={!canSetup}
                  title={comingSoon ? statusText : unavailable ? status?.reason ?? `${type.name} is unavailable` : type.desc}
                  className={cn(
                    'group flex h-8 w-full cursor-default items-center gap-0.5 rounded-md px-2 text-left outline-none transition-colors',
                    'hover:bg-[var(--muted)] focus:bg-[var(--muted)]',
                    canSetup && 'cursor-pointer',
                    !canSetup && 'disabled:opacity-100'
                  )}
                >
                  <span className="mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] p-0.5">
                    <img
                      src={type.icon}
                      alt=""
                      className={cn(
                        'h-full w-full object-contain',
                        unavailable && 'grayscale opacity-60'
                      )}
                      draggable={false}
                    />
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-sm',
                      unavailable ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'
                    )}
                  >
                    {type.name}
                  </span>
                  <span className="shrink-0 truncate text-[11px] text-[var(--muted-foreground)]">
                    {statusText}
                  </span>
                  {canShowRunningSubmenu && (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)] opacity-60 group-hover:opacity-100" />
                  )}
                </button>

                {canShowRunningSubmenu && runningSubmenuType === type.key && (
                  <div
                    className={cn(
                      'absolute right-full bottom-0 z-[1501] w-[17rem]',
                      'rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-lg',
                      'animate-in fade-in-0 zoom-in-95'
                    )}
                  >
                    <div className="px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                      {t('status.agent.conversations')}
                    </div>
                    {instances.length === 0 ? (
                      <div className="px-2 py-3 text-center text-sm text-[var(--muted-foreground)]">
                        {t('status.agent.noConversations')}
                      </div>
                    ) : (
                      <div className="max-h-[240px] space-y-0.5 overflow-y-auto">
                        {instances.map((instance) => {
                          const canOpen = Boolean(instance.source.documentPath || instance.source.memoId);
                          return (
                            <button
                              key={instance.run?.runId ?? instance.instanceId}
                              type="button"
                              disabled={!canOpen}
                              onClick={() => {
                                if (canOpen) void openRunningInstance(instance);
                              }}
                              title={canOpen ? t('status.agent.openRun') : t('status.agent.originUnavailable')}
                              className={cn(
                                'group/run flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors',
                                canOpen ? 'cursor-pointer hover:bg-[var(--muted)] focus:bg-[var(--muted)]' : 'cursor-default opacity-70'
                              )}
                            >
                              <span
                                className={cn(
                                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border bg-[var(--background)] p-0.5',
                                  selectIsAgentConversationRunning(instance)
                                    ? 'agent-runtime-submenu__icon--running border-transparent'
                                    : 'border-[var(--border)]',
                                )}
                              >
                                <img
                                  src={getAgentType(instance.agentType).icon}
                                  alt=""
                                  className="h-full w-full object-contain"
                                  draggable={false}
                                />
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm text-[var(--agent-foreground)]">
                                {instance.title?.trim() || t('common.untitled')}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void windows.openPreferences('agents').finally(() => setOpen(false));
          }}
          className="mt-1 w-full rounded-md"
        >
          {t('status.agent.manage')}
        </Button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
