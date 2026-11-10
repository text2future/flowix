import { useEffect, useState, type ReactElement } from 'react';
import { ChevronDown, ChevronUp, ChevronsLeftRightEllipsis, Columns2, GalleryHorizontalEnd, SquarePen, SwatchBook, Table2 } from 'lucide-react';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { orderNoteTemplates } from '@/lib/note-template-order';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuTrigger } from '@shared/ui/context-menu';
import { swapColumnContents, useCanSwapColumnContents, toggleBrowserColumn, useBrowserColumnVisible } from '@features/workspace/public/browser-column-api';
import { AgentIcon, requestNewConversationAgentSelection } from '@features/agent/public/header-api';
import { listShellNoteTemplates, MEMO_CREATE_VIEW_OPTIONS, type NoteTemplate, useShellSelectedNotebook } from '@features/memo/public/note-creation-api';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';
import { useWorkspaceHeaderCreation } from '../hooks/use-workspace-header-creation';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

const itemClass = 'h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]';
const labelClass = 'px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]';

/** Shared context menu for the Work and Browser column title bars. */
export function WorkspaceColumnContextMenu({ children, isWindows, onCreateNote, onCreateAgentConversation, columnId = 'column-1' }: {
  columnId?: WorkspaceColumnId;
  children: ReactElement;
  isWindows: boolean;
  onCreateNote?: (templateId?: string) => void;
  onCreateAgentConversation?: (typeKey: AgentTypeKey) => void;
}) {
  const { t } = useI18n();
  const browserColumnVisible = useBrowserColumnVisible();
  const canSwap = useCanSwapColumnContents();
  const creation = useWorkspaceHeaderCreation(columnId, { onCreateNote, onCreateAgentConversation });
  const notebook = useShellSelectedNotebook();
  const [menuOpen, setMenuOpen] = useState(false);
  const [noteTemplates, setNoteTemplates] = useState<NoteTemplate[]>([]);
  const [viewsExpanded, setViewsExpanded] = useState(false);
  const canCreate = creation.canCreate;

  useEffect(() => {
    if (!menuOpen) {
      setViewsExpanded(false);
      return;
    }
    requestNewConversationAgentSelection();
    void listShellNoteTemplates()
      .then((templates) => setNoteTemplates(orderNoteTemplates(templates).slice(0, 5)))
      .catch(() => setNoteTemplates([]));
  }, [menuOpen]);

  const openViewCreateDialog = (kind: 'table' | 'media-library' | 'work-documents', viewType?: TableViewType) => {
    if (!notebook || notebook.missing) return;
    window.dispatchEvent(new CustomEvent('flowix:open-create-notebook-document-dialog', {
      detail: { notebookId: notebook.id, kind, viewType },
    }));
  };


  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        asChild
        data-workspace-column-context-menu={isWindows ? 'windows' : undefined}
        data-workspace-column-context-menu-trigger=""
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-[200px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <ContextMenuItem onClick={toggleBrowserColumn} className={itemClass}>
          <Columns2 className="mr-2 h-4 w-4" aria-hidden="true" />
          <span className="leading-5">{t(browserColumnVisible ? 'tabWindow.closeColumn' : 'tabWindow.expandColumn')}</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canSwap}
          onClick={() => { if (!swapColumnContents()) toast.error(t('tabWindow.switchFailed')); }}
          className={itemClass}
        >
          <ChevronsLeftRightEllipsis className="mr-2 h-4 w-4" aria-hidden="true" />
          <span className="leading-5">{t('tabWindow.swapPositions')}</span>
        </ContextMenuItem>
        <ContextMenuLabel className={labelClass}>{t('memo.create.documents')}</ContextMenuLabel>
        <ContextMenuItem disabled={!canCreate} onClick={() => void creation.createNote()} className={itemClass}>
          <SquarePen className="mr-2 h-4 w-4" aria-hidden="true" />
          <span className="leading-5">{t('memo.create.note')}</span>
        </ContextMenuItem>
        {noteTemplates.map((template) => (
          <ContextMenuItem key={template.id} disabled={!canCreate} onClick={() => void creation.createNote(template.id)} className={itemClass}>
            <SwatchBook className="mr-2 h-4 w-4" aria-hidden="true" />
            <span className="min-w-0 truncate leading-5">{template.name}</span>
          </ContextMenuItem>
        ))}
        {creation.options.length > 0 && <>
          <ContextMenuLabel className={labelClass}>{t('memo.create.conversations')}</ContextMenuLabel>
          {creation.options.map((type) => (
            <ContextMenuItem
              key={type.id}
              disabled={!canCreate}
              onClick={() => void creation.createConversation(type.id)}
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
        <ContextMenuLabel className={labelClass}>{t('memo.create.newView')}</ContextMenuLabel>
        {(viewsExpanded ? MEMO_CREATE_VIEW_OPTIONS : MEMO_CREATE_VIEW_OPTIONS.slice(0, 1)).map(({ type, labelKey }) => (
          <ContextMenuItem
            key={type}
            disabled={!canCreate}
            onClick={() => openViewCreateDialog('table', type)}
            className={`${itemClass} group`}
          >
            {type === 'table' ? <Table2 className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" /> : <span className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 flex-1 truncate leading-5">{t(labelKey)}</span>
            <span className="ml-auto shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)] group-data-[highlighted]:text-[var(--primary-foreground)]">
              {t('memo.create.note')}
            </span>
          </ContextMenuItem>
        ))}
        {viewsExpanded && <>
          <ContextMenuItem disabled={!canCreate} onClick={() => openViewCreateDialog('media-library')} className={`${itemClass} group`}>
            <GalleryHorizontalEnd className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate leading-5">{t('memo.create.mediaLibraryMenuLabel')}</span>
            <span className="ml-auto shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)] group-data-[highlighted]:text-[var(--primary-foreground)]">
              {t('memo.create.assetShort')}
            </span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!notebook || Boolean(notebook.missing)} onClick={() => openViewCreateDialog('work-documents')} className={`${itemClass} group`}>
            <span className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate leading-5">{t('memo.create.workDocumentsMenuLabel')}</span>
            <span className="ml-auto shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)] group-data-[highlighted]:text-[var(--primary-foreground)]">
              {t('memo.create.assetShort')}
            </span>
          </ContextMenuItem>
        </>}
        <ContextMenuItem
          keepOpenOnClick
          onClick={() => setViewsExpanded((expanded) => !expanded)}
          title={t(viewsExpanded ? 'memo.create.collapseViews' : 'memo.create.expandViews')}
          className="group h-5 justify-center rounded-lg px-2 py-0 text-[var(--muted-foreground)] hover:text-[color-mix(in_oklch,var(--brand)_65%,white)]"
        >
          {viewsExpanded
            ? <ChevronUp className="h-4 w-4" aria-hidden="true" />
            : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          <span className="sr-only">{t(viewsExpanded ? 'memo.create.collapseViews' : 'memo.create.expandViews')}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
