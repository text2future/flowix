'use client';

import { useEffect, useMemo, useState } from 'react';
import { StarFourIcon } from '@phosphor-icons/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { Button } from '@shared/ui/button';
import { AGENT_TYPES, isAgentTypeComingSoon } from '@/lib/agent-types';
import { cn } from '@/lib/utils';
import type { AgentTypeKey } from '@/types/agent';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import {
  selectIsAgentConversationRunning,
  useAgentConversationStore,
} from '@features/agent/store/agent-conversation-store';
import { windows } from '@platform/tauri/client';
import { getAgentRuntimeStatusText } from '@features/agent/components/agent-runtime-status-list';
import { openAgentSetup } from '@features/agent/agent-setup';
import { useI18n } from '@features/i18n';
import { AgentConversationOverlay } from '@features/shell/components/status-bar/agent-conversation-overlay';

export function AgentRuntimeStatusMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [conversationOverlayType, setConversationOverlayType] = useState<AgentTypeKey | null>(null);
  const statusByType = useAgentRuntimeStore((s) => s.statusByType);
  const isChecking = useAgentRuntimeStore((s) => s.isChecking);
  const refreshIfStale = useAgentRuntimeStore((s) => s.refreshIfStale);
  const instancesMap = useAgentConversationStore((s) => s.instances);
  const hasRunning = useMemo(
    () =>
      Object.values(instancesMap).some(selectIsAgentConversationRunning),
    [instancesMap],
  );
  useEffect(() => {
    if (open) {
      void refreshIfStale();
    }
  }, [open, refreshIfStale]);

  return (
    <>
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
          className="w-[13.6rem] p-1 bg-[var(--popover)]"
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

              return (
                <div key={type.key}>
                  <button
                    type="button"
                    onClick={() => {
                      if (canSetup) {
                        void openAgentSetup(type.key).finally(() => setOpen(false));
                        return;
                      }
                      if (!comingSoon && status?.available !== false) {
                        setOpen(false);
                        setConversationOverlayType(type.key);
                      }
                    }}
                    disabled={comingSoon}
                    title={comingSoon ? statusText : unavailable ? status?.reason ?? `${type.name} is unavailable` : type.desc}
                    className={cn(
                      'flex h-8 w-full cursor-default items-center gap-0.5 rounded-md px-2 text-left outline-none transition-colors',
                      'hover:bg-[var(--muted)] focus:bg-[var(--muted)]',
                      !comingSoon && 'cursor-pointer',
                      comingSoon && 'disabled:opacity-100'
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
                  </button>
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
      {conversationOverlayType && (
        <AgentConversationOverlay
          initialAgentType={conversationOverlayType}
          onClose={() => setConversationOverlayType(null)}
        />
      )}
    </>
  );
}
