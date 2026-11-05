import { Ellipsis, FilePlus2, MessageCirclePlus } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';
import type { AgentTypeKey } from '@/types/agent';
import { useColumnEnvironment } from './column-environment';
import { useWorkspaceHeaderCreation } from '../hooks/use-workspace-header-creation';

export function WorkspaceHeaderFallbackMenu({ columnId, iconButtonClass, canCreate, onCreateNote, onCreateAgentConversation, onOpenInWorkColumn }: {
  columnId: WorkspaceColumnId; iconButtonClass: string; canCreate?: boolean;
  onCreateNote?: (templateId?: string) => void;
  onCreateAgentConversation?: (typeKey: AgentTypeKey) => void;
  onOpenInWorkColumn?: () => void;
}) {
  const { t } = useI18n();
  const environment = useColumnEnvironment();
  const creation = useWorkspaceHeaderCreation(columnId, { onCreateNote, onCreateAgentConversation });
  const enabled = canCreate ?? creation.canCreate;
  return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={iconButtonClass}
    aria-label={t('document.titlebar.moreTooltip')} title={t('document.titlebar.moreTooltip')}><Ellipsis className="h-4 w-4" /></button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-[210px] rounded-xl p-1">
      {onOpenInWorkColumn && <DropdownMenuItem disabled={environment?.index === 0} onClick={onOpenInWorkColumn}>{t('tabWindow.context.openInWorkColumn')}</DropdownMenuItem>}
      <DropdownMenuItem disabled={!enabled} onClick={() => void creation.createNote()}><FilePlus2 className="mr-2 h-4 w-4" />{t('tabWindow.context.newNote')}</DropdownMenuItem>
      {creation.options.map((type) => <DropdownMenuItem key={type.id} disabled={!enabled} onClick={() => void creation.createConversation(type.id)}>
        <MessageCirclePlus className="mr-2 h-4 w-4" />{type.nameKey ? t(type.nameKey as Parameters<typeof t>[0]) : type.name}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
