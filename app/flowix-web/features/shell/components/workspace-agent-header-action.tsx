'use client';

import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';
import { columnAtIndex } from '@features/workspace/public/session-api';
import { createAndOpenAgentConversation, createAndOpenAgentConversationWithReference, type AgentConversationReference } from '@features/agent/public/new-conversation-api';
import { AgentIcon } from '@features/agent/public/icon-api';
import { useNewConversationAgentSelection } from '@features/agent/public/shell-api';
import { useShellSelectedNotebook } from '@features/memo/public/note-creation-api';
import { getAgentType } from '@/lib/agent-types';
import { useI18n } from '@/lib/i18n';
import type { AgentTypeKey } from '@/types/agent';
import { useCollectionAgentType } from '@features/collection/public/agent-api';

export function WorkspaceAgentHeaderAction({
  host,
  notebookId: collectionNotebookId,
  reference,
  iconButtonClass,
}: {
  host: WorkspaceColumnId;
  notebookId?: string | null;
  reference?: AgentConversationReference | null;
  iconButtonClass: string;
}) {
  const { t } = useI18n();
  const notebook = useShellSelectedNotebook();
  const selection = useNewConversationAgentSelection();
  const selectedAgentType = useCollectionAgentType();
  const agentType: AgentTypeKey = selection.options.some((type) => type.id === selectedAgentType)
    ? selectedAgentType
    : selection.options[0]?.id ?? selectedAgentType;
  const agentName = getAgentType(agentType).name;
  const notebookId = collectionNotebookId ?? notebook?.id ?? null;
  const canCreate = Boolean(notebookId && selection.options.length > 0);

  return (
    <button
      type="button"
      className={iconButtonClass}
      aria-label={t('collection.createConversation', { name: agentName })}
      title={t('collection.createConversation', { name: agentName })}
      disabled={!canCreate}
      onClick={() => {
        if (!canCreate || !notebookId) return;
        const destination = columnAtIndex(0) === host ? 1 : 0;
        if (reference) {
          createAndOpenAgentConversationWithReference(agentType, notebookId, reference, destination);
        } else {
          createAndOpenAgentConversation(agentType, notebookId, destination);
        }
      }}
    >
      <AgentIcon typeKey={agentType} alt="" className="h-4 w-4" />
    </button>
  );
}
