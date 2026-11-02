import { useWorkspaceSessionNavigation } from '@features/workspace/public/session-navigation-api';
import { useSessionHostEnvironment } from './session-host-environment';
import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { WorkColumnBrowserExpandButton } from './work-column-browser-expand-button';
import { ChevronLeft, ChevronRight, Ellipsis, Link2, FilePlus2, MessageCirclePlus } from 'lucide-react';
import { useState } from 'react';
import type { BrowserColumnEntry } from '@features/workspace/public/browser-column-api';
import { canOpenBrowserColumnTargetInWorkColumn } from '@features/workspace/public/browser-column-api';
import { AgentConversationIdentity, AgentConversationMoreMenu, useBrowserColumnAgentHeaderModel, useNewConversationAgentSelection } from '@features/agent/public/shell-api';
import { AgentThreadCardFullscreenExitButton, AgentThreadCardFullscreenIdentity, AgentThreadCardFullscreenMoreMenu } from '@features/document/public/shell-api';
import type { BrowserColumnSurfaceChrome } from '@features/surface/public/shell-api';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { SidebarToggleIconRight } from '@shared/icons/sidebar-toggle-icon';
import { useNotebookNoteIcon } from '@features/memo/public/shell-api';
import { classifyFileContent } from '@features/content/public/content-api';
import { toast } from '@/lib/toast';
import { BrowserContentIcon } from './browser-content-icon';
import { WorkspaceHeaderShell } from './workspace-header-shell';
import { WorkspaceHeaderIdentity } from './workspace-header-identity';
import { useWorkspaceHeader } from '../hooks/use-workspace-header';
import { BrowserColumnDocumentActions, BrowserColumnMediaActions } from './browser-column-surface-actions';
import { resolveWorkspaceFileSurfaceKind, type WorkspaceSurfaceKind, type WorkspaceSurfaceCapability } from '@features/workspace/public/surface-api';
import { browserCollectionIndexPath } from '@features/surface/public/shell-api';
import { CollectionDisplayMenuItems } from '@features/collection/public/title-api';
import { WorkspaceColumnContextMenu } from './workspace-column-context-menu';
import { DOCUMENT_TITLEBAR_ICON_BUTTON_MAC, DOCUMENT_TITLEBAR_ICON_BUTTON_WIN } from '@features/document/public/shell-api';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@shared/ui/dropdown-menu';

export interface BrowserColumnHeaderProps {
  current: BrowserColumnEntry | null;
  webAddressBarVisible?: boolean;
  onToggleWebAddressBar?: () => void;
  activeSurfaceChrome: BrowserColumnSurfaceChrome;
  headerBackgroundColor?: string | null;
  surfaceCapabilities?: readonly WorkspaceSurfaceCapability[];
  surfaceContentKind?: WorkspaceSurfaceKind;
  onToggleMemoEditorMode: (surfaceId: string) => void | Promise<void>;
  onOpenInWorkColumn: (surfaceId: string) => void | Promise<void>;
  onCloseColumn?: () => void;
  isFocused: boolean;
  canCreate: boolean;
  onCreateNote: (templateId?: string) => void;
  onCreateAgentConversation: (typeKey: AgentTypeKey) => void;
}

export function BrowserColumnHeader(props: BrowserColumnHeaderProps) {
  const { t } = useI18n();
  const environment = useSessionHostEnvironment();
  const { canNavigateBack, canNavigateForward, back, forward } = useWorkspaceSessionNavigation('secondary-session');
  const { conversationInstances } = useBrowserColumnAgentHeaderModel();
  const selection = useNewConversationAgentSelection();
  const [renameRequest, setRenameRequest] = useState(0);
  const { current } = props;
  const noteIcon = useNotebookNoteIcon(current?.target.kind === 'file-browser' && current.target.activeFilePath && classifyFileContent(current.target.activeFilePath) === 'note'
    ? current.target.activeFilePath : null);
  const conversation = current?.target.kind === 'agent_conversation' ? conversationInstances[current.target.instanceId] : null;
  const mediaTarget = current?.target.kind === 'media'
    ? { filePath: current.target.filePath, notebookPath: current.target.notebookPath }
    : current?.target.kind === 'file-browser' && current.target.activeFilePath && props.activeSurfaceChrome === 'media'
      ? { filePath: current.target.activeFilePath, notebookPath: current.target.scopePath }
      : null;
  const collectionPath = browserCollectionIndexPath(current);
  const path = current?.target.kind === 'file-browser' ? current.target.activeFilePath : null;
  const sourceKind: WorkspaceSurfaceKind = path ? `file-${resolveWorkspaceFileSurfaceKind(path)}`
    : current?.target.kind === 'web' ? 'web' : current?.target.kind === 'agent_conversation' ? 'agent-conversation'
      : current?.target.kind === 'media' ? 'media' : collectionPath ? 'collection' : 'file-browser';
  const target = current?.target.kind === 'file-browser' ? current.target : null;
  const { fullscreen, model: header } = useWorkspaceHeader('browser-column', {
    chrome: props.activeSurfaceChrome, backgroundColor: props.headerBackgroundColor,
    contentKind: props.surfaceContentKind ?? sourceKind, sourceKind,
    capabilities: props.surfaceCapabilities, collection: Boolean(collectionPath),
    indexable: sourceKind === 'file-markdown' && Boolean(target?.notebookId && target.scopePath
      && path && notebookRelativeDirectoryPath(target.scopePath, path) !== null),
  });
  const title = fullscreen?.title || conversation?.title || current?.title || '';
  const windows = typeof navigator !== 'undefined' && /Windows|Win32/.test(navigator.userAgent + navigator.platform);
  const buttonClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-35 [-webkit-app-region:no-drag]';
  const actionButtonClass = `${windows ? DOCUMENT_TITLEBAR_ICON_BUTTON_WIN : DOCUMENT_TITLEBAR_ICON_BUTTON_MAC} [-webkit-app-region:no-drag]`;
  const navigate = async (direction: 'back' | 'forward') => {
    try { if (await (direction === 'back' ? back() : forward()) === null) toast.error(t('tabWindow.switchFailed')); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('tabWindow.switchFailed')); }
  };
  return <WorkspaceColumnContextMenu isWindows={windows} onCreateNote={props.onCreateNote} onCreateAgentConversation={props.onCreateAgentConversation}><WorkspaceHeaderShell as="header" data-browser-column-header isWindows={windows} header={header}
    data-thread-card-fullscreen={fullscreen ? '' : undefined} className={windows ? 'gap-1' : 'gap-1 pr-2'}>
    {environment?.host !== 'main-third' && <button type="button" className={buttonClass} aria-label={t('tabWindow.closeColumn')} onClick={props.onCloseColumn}><SidebarToggleIconRight className="h-4 w-4" variant="expanded" /></button>}
    {environment?.host === 'main-third' && environment.sidebarHidden && <button type="button" className={buttonClass}
      aria-label={t('document.titlebar.showSidebar')} onClick={environment.onToggleSidebar}>
      <SidebarToggleIcon className="h-4 w-4" variant="collapsed" />
    </button>}
    <button type="button" className={buttonClass} aria-label={t('document.titlebar.back')} disabled={!canNavigateBack} onClick={() => void navigate('back')}><ChevronLeft className="h-4 w-4" /></button>
    <button type="button" className={buttonClass} aria-label={t('document.titlebar.forward')} disabled={!canNavigateForward} onClick={() => void navigate('forward')}><ChevronRight className="h-4 w-4" /></button>
    <div className="flex min-w-0 flex-1 items-center gap-2" data-tauri-drag-region>
      {fullscreen ? <AgentThreadCardFullscreenIdentity host="browser-column" /> : conversation ? (
        <AgentConversationIdentity
          instanceId={conversation.instanceId}
          title={title}
          typeKey={conversation.agentType}
          threadId={conversation.threadId}
          sessionId={conversation.providerSessionId}
          renameRequest={renameRequest}
          className="min-w-0 flex-1"
        />
      ) : header.showIdentity && <WorkspaceHeaderIdentity title={title} icon={current && <BrowserContentIcon entry={current} noteIcon={noteIcon} />} />}
    </div>
    {environment?.host === 'main-third' && <WorkColumnBrowserExpandButton iconButtonClass={actionButtonClass} />}
    {header.showSurfaceActions && current?.target.kind === 'web' && <button
      type="button"
      className={actionButtonClass}
      aria-label={props.webAddressBarVisible ? '隐藏网址条' : '显示网址条'}
      title={props.webAddressBarVisible ? '隐藏网址条' : '显示网址条'}
      aria-expanded={Boolean(props.webAddressBarVisible)}
      onClick={props.onToggleWebAddressBar}
    ><Link2 className="h-4 w-4" /></button>}
    <AgentThreadCardFullscreenExitButton host="browser-column" className="agent-thread-card-fullscreen-exit-btn" />
    {fullscreen ? <AgentThreadCardFullscreenMoreMenu host="browser-column" iconButtonClass={actionButtonClass} />
      : conversation ? <AgentConversationMoreMenu instance={conversation} iconButtonClass={actionButtonClass} onRename={() => setRenameRequest((request) => request + 1)} />
        : mediaTarget ? <BrowserColumnMediaActions filePath={mediaTarget.filePath} notebookPath={mediaTarget.notebookPath} collectionPath={collectionPath} iconButtonClass={actionButtonClass} />
          : current?.target.kind === 'file-browser' && current.target.activeFilePath ? <BrowserColumnDocumentActions
            key={`${current.id}:${current.target.activeFilePath}`}
            path={current.target.activeFilePath}
            scopePath={current.target.scopePath}
            notebookId={current.target.notebookId}
            header={header}
            collectionPath={collectionPath}
            surfaceId={current.id}
            onToggleMemoEditorMode={props.onToggleMemoEditorMode}
            iconButtonClass={actionButtonClass}
          />
        : current?.target.kind === 'web' ? null : <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={actionButtonClass} aria-label={t('document.titlebar.moreTooltip')} title={t('document.titlebar.moreTooltip')}><Ellipsis className="h-4 w-4" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[210px] rounded-xl p-1">
                {current && <DropdownMenuItem disabled={environment?.host === 'main-third' || !canOpenBrowserColumnTargetInWorkColumn(current.target)} onClick={() => void props.onOpenInWorkColumn(current.id)}>{t('tabWindow.context.openInWorkColumn')}</DropdownMenuItem>}
                <DropdownMenuItem disabled={!props.canCreate} onClick={() => props.onCreateNote()}><FilePlus2 className="mr-2 h-4 w-4" />{t('tabWindow.context.newNote')}</DropdownMenuItem>
                {selection.options.map((type) => <DropdownMenuItem key={type.id} disabled={!props.canCreate} onClick={() => props.onCreateAgentConversation(type.id)}><MessageCirclePlus className="mr-2 h-4 w-4" />{type.nameKey ? t(type.nameKey as Parameters<typeof t>[0]) : type.name}</DropdownMenuItem>)}
                {collectionPath && <>
                  <DropdownMenuSeparator />
                  <CollectionDisplayMenuItems indexPath={collectionPath} />
                </>}
              </DropdownMenuContent>
            </DropdownMenu>}
  </WorkspaceHeaderShell></WorkspaceColumnContextMenu>;
}
