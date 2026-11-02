import { useEffect, useState, type ReactElement } from 'react';
import { ArrowLeftRight, Columns2, SquarePen, SwatchBook } from 'lucide-react';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { orderNoteTemplates } from '@/lib/note-template-order';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuTrigger } from '@shared/ui/context-menu';
import { swapWorkspaceColumnContent, useCanSwapWorkspaceColumnContent, toggleBrowserColumn, useBrowserColumnVisible } from '@features/workspace/public/browser-column-api';
import { AgentIcon, createBrowserColumnAgentConversation, discardUnopenedBrowserColumnAgentConversation, requestNewConversationAgentSelection, useNewConversationAgentSelection } from '@features/agent/public/shell-api';
import { createShellNote, createShellNoteFromTemplate, listShellNoteTemplates, useShellSelectedNotebook, type NoteTemplate } from '@features/memo/public/shell-api';
import { openWorkspaceSurface } from '@features/workspace/public/session-opening-api';

const itemClass = 'h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const labelClass = 'px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]';

/** Shared context menu for the Work and Browser column title bars. */
export function WorkspaceColumnContextMenu({ children, isWindows, onCreateNote, onCreateAgentConversation }: {
  children: ReactElement;
  isWindows: boolean;
  onCreateNote?: (templateId?: string) => void;
  onCreateAgentConversation?: (typeKey: AgentTypeKey) => void;
}) {
  const { t } = useI18n();
  const browserColumnVisible = useBrowserColumnVisible();
  const canSwap = useCanSwapWorkspaceColumnContent();
  const [swapping, setSwapping] = useState(false);
  const selectedNotebook = useShellSelectedNotebook();
  const conversationSelection = useNewConversationAgentSelection();
  const [menuOpen, setMenuOpen] = useState(false);
  const [noteTemplates, setNoteTemplates] = useState<NoteTemplate[]>([]);
  const canCreate = Boolean(selectedNotebook && !selectedNotebook.missing);

  useEffect(() => {
    if (!menuOpen) return;
    requestNewConversationAgentSelection();
    void listShellNoteTemplates()
      .then((templates) => setNoteTemplates(orderNoteTemplates(templates).slice(0, 5)))
      .catch(() => setNoteTemplates([]));
  }, [menuOpen]);

  const createNote = async (templateId?: string) => {
    if (!selectedNotebook || !canCreate) return;
    if (onCreateNote) {
      onCreateNote(templateId);
      return;
    }
    try {
      const created = templateId
        ? await createShellNoteFromTemplate(templateId, selectedNotebook.id)
        : await createShellNote(selectedNotebook.id);
      await openWorkspaceSurface({ host: 'main-third', target: { kind: 'external', path: created.path, scopePath: selectedNotebook.path }, options: { initialFocus: 'title', notebookId: selectedNotebook.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(templateId ? 'memo.create.templateFailed' : 'memo.list.createFailed'));
    }
  };

  const createConversation = (typeKey: AgentTypeKey) => {
    if (!selectedNotebook) return;
    if (onCreateAgentConversation) {
      onCreateAgentConversation(typeKey);
      return;
    }
    const instanceId = createBrowserColumnAgentConversation(typeKey, selectedNotebook.id);
    void openWorkspaceSurface({ host: 'main-third', target: { kind: 'agent-conversation', instanceId } })
      .then((result) => {
        if (result.status === 'cancelled') discardUnopenedBrowserColumnAgentConversation(instanceId);
      }).catch((error: unknown) => {
        discardUnopenedBrowserColumnAgentConversation(instanceId);
        toast.error(error instanceof Error ? error.message : t('tabWindow.switchFailed'));
      });
  };

  const swapContent = async () => {
    setSwapping(true);
    try {
      if (!await swapWorkspaceColumnContent()) toast.error(t('tabWindow.switchFailed'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('tabWindow.switchFailed'));
    } finally {
      setSwapping(false);
    }
  };

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild data-workspace-column-context-menu={isWindows ? 'windows' : undefined}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-[200px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <ContextMenuItem onClick={toggleBrowserColumn} className={itemClass}>
          <Columns2 className="mr-2 h-4 w-4" aria-hidden="true" />
          <span className="leading-5">{t(browserColumnVisible ? 'tabWindow.closeColumn' : 'tabWindow.expandColumn')}</span>
        </ContextMenuItem>
        <ContextMenuItem disabled={!canSwap || swapping} onClick={() => void swapContent()} className={itemClass}>
          <ArrowLeftRight className="mr-2 h-4 w-4" aria-hidden="true" />
          <span className="leading-5">{t('tabWindow.swapPositions')}</span>
        </ContextMenuItem>
        <ContextMenuLabel className={labelClass}>{t('memo.create.documents')}</ContextMenuLabel>
        <ContextMenuItem disabled={!canCreate} onClick={() => void createNote()} className={itemClass}>
          <SquarePen className="mr-2 h-4 w-4" aria-hidden="true" />
          <span className="leading-5">{t('memo.create.note')}</span>
        </ContextMenuItem>
        {noteTemplates.map((template) => (
          <ContextMenuItem key={template.id} disabled={!canCreate} onClick={() => void createNote(template.id)} className={itemClass}>
            <SwatchBook className="mr-2 h-4 w-4" aria-hidden="true" />
            <span className="min-w-0 truncate leading-5">{template.name}</span>
          </ContextMenuItem>
        ))}
        {conversationSelection.options.length > 0 && <>
          <ContextMenuLabel className={labelClass}>{t('memo.create.conversations')}</ContextMenuLabel>
          {conversationSelection.options.map((type) => (
            <ContextMenuItem
              key={type.id}
              disabled={!canCreate}
              onClick={() => createConversation(type.id)}
              className={`${itemClass} group agent-conversation-new-agent-item`}
            >
              <AgentIcon typeKey={type.id} alt="" className="mr-2 h-4 w-4 shrink-0 object-contain" />
              <span className="min-w-0 flex-1 truncate leading-5">
                {type.nameKey ? t(type.nameKey as Parameters<typeof t>[0]) : type.name}
              </span>
              {type.runtimeKind === 'external-cli' && <span className="ml-auto shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)] group-data-[highlighted]:text-[var(--primary-foreground)]">{t('agent.chat.localRuntime')}</span>}
            </ContextMenuItem>
          ))}
        </>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
