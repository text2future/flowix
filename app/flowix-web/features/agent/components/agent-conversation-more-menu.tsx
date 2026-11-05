'use client';

import { ConversationActionItems } from './conversation-action-items';
import { removeAgentConversation } from '@features/agent/use-cases/remove-conversation';

import { useEffect, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { AgentMessageFontSwitcher, useAgentMessageFontSwitch } from '@features/agent/components/agent-message-font-switcher';
import {
  isFavoriteConversation,
  subscribeToFavoriteConversationChanges,
  toggleFavoriteConversation,
} from '@features/agent/conversation-favorites';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';



/** Shared Agent conversation actions used by both dedicated and fullscreen embedded conversations. */
export function AgentConversationMoreMenu({
  instance,
  iconButtonClass,
  onRename,
}: {
  instance: AgentConversationInstance;
  iconButtonClass: string;
  onRename: () => void;
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('document.agent.moreActions')}
          title={t('document.agent.moreActions')}
          className={`${iconButtonClass} [-webkit-app-region:no-drag]`}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[202px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <AgentConversationMoreMenuItems instance={instance} onRename={onRename} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AgentConversationMoreMenuItems({
  instance,
  onRename,
}: {
  instance: AgentConversationInstance;
  onRename: () => void;
}) {
  const { t } = useI18n();
  const fontSwitch = useAgentMessageFontSwitch();
  const [isFavorite, setIsFavorite] = useState(() => isFavoriteConversation(instance.instanceId));

  useEffect(() => {
    setIsFavorite(isFavoriteConversation(instance.instanceId));
    return subscribeToFavoriteConversationChanges(() => {
      setIsFavorite(isFavoriteConversation(instance.instanceId));
    });
  }, [instance.instanceId]);

  const removeConversation = async (action: 'archive' | 'delete') => {
    if (action === 'delete' && !window.confirm(t('agent.chat.conversation.deleteConfirm'))) return;
    try {
      await removeAgentConversation(instance, action);
      toast.success(t(action === 'archive' ? 'status.agent.archiveSuccess' : 'status.agent.deleteSuccess'));
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(action === 'archive' ? 'status.agent.archiveFailed' : 'status.agent.deleteFailed'));
    }
  };

  return (
    <>
      <AgentMessageFontSwitcher
        fontMode={fontSwitch.fontMode}
        sizeMode={fontSwitch.sizeMode}
        downloadingMode={fontSwitch.downloadingMode}
        onSelect={fontSwitch.selectFontMode}
      />
      <ConversationActionItems
        favorite={isFavorite}
        onOpen={() => void openWorkspaceSurface({ index: 1, target: { kind: 'agent-conversation', instanceId: instance.instanceId } }).catch((error) =>
          toast.error(error instanceof Error ? error.message : String(error)))}
        onFavorite={() => setIsFavorite(toggleFavoriteConversation(instance.instanceId).has(instance.instanceId))}
        onRename={onRename}
        onArchive={() => void removeConversation('archive')}
        onDelete={() => void removeConversation('delete')}
      />
    </>
  );
}
