import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import type { AgentTypeKey } from '@/types/agent';
import { createShellNote, createShellNoteFromTemplate, useShellSelectedNotebook } from '@features/memo/public/note-creation-api';
import { createBrowserColumnAgentConversation, discardUnopenedBrowserColumnAgentConversation, useNewConversationAgentSelection } from '@features/agent/public/header-api';
import { openWorkspaceSurface } from '@features/workspace/public/session-opening-api';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

/** Creation targets the owning session, including after the columns exchange positions. */
export function useWorkspaceHeaderCreation(columnId: WorkspaceColumnId, overrides: {
  onCreateNote?: (templateId?: string) => void;
  onCreateAgentConversation?: (typeKey: AgentTypeKey) => void;
} = {}) {
  const { t } = useI18n();
  const notebook = useShellSelectedNotebook();
  const selection = useNewConversationAgentSelection();
  const canCreate = Boolean(notebook && !notebook.missing);
  const createNote = async (templateId?: string) => {
    if (!notebook || !canCreate) return;
    if (overrides.onCreateNote) { overrides.onCreateNote(templateId); return; }
    try {
      const created = templateId ? await createShellNoteFromTemplate(templateId, notebook.id) : await createShellNote(notebook.id);
      const result = await openWorkspaceSurface({ columnId: columnId,
        target: { kind: 'external', path: created.path, scopePath: notebook.path },
        options: { initialFocus: 'title', notebookId: notebook.id } });
      if (result.status === 'cancelled') toast.error(t('tabWindow.switchFailed'));
    } catch (error) { toast.error(error instanceof Error ? error.message : t(templateId ? 'memo.create.templateFailed' : 'memo.list.createFailed')); }
  };
  const createConversation = async (typeKey: AgentTypeKey) => {
    if (!notebook || !canCreate) return;
    if (overrides.onCreateAgentConversation) { overrides.onCreateAgentConversation(typeKey); return; }
    let instanceId: string | null = null;
    try {
      instanceId = createBrowserColumnAgentConversation(typeKey, notebook.id);
      const result = await openWorkspaceSurface({ columnId: columnId, target: { kind: 'agent-conversation', instanceId } });
      if (result.status === 'cancelled') discardUnopenedBrowserColumnAgentConversation(instanceId);
    } catch (error) {
      if (instanceId) discardUnopenedBrowserColumnAgentConversation(instanceId);
      toast.error(error instanceof Error ? error.message : t('tabWindow.switchFailed'));
    }
  };
  return { canCreate, options: selection.options, createNote, createConversation };
}
