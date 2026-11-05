import { useWorkspaceSessionNavigation } from '@features/workspace/public/session-navigation-api';
import { canOpenBrowserColumnTargetInWorkColumn, type BrowserColumnEntry } from '@features/workspace/public/browser-column-api';
import type { BrowserColumnSurfaceChrome } from '@features/surface/public/shell-api';
import { browserCollectionIndexPath } from '@features/surface/public/shell-api';
import { AgentConversationHeaderContent } from '@features/agent/public/header-api';
import { resolveWorkspaceFileSurfaceKind, type WorkspaceSurfaceKind, type WorkspaceSurfaceCapability } from '@features/workspace/public/surface-api';
import type { AgentTypeKey } from '@/types/agent';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { WorkspaceHeader } from './workspace-header';
import { WorkspaceHeaderContentActions } from './workspace-header-content-actions';
import { WorkspaceHeaderFallbackMenu } from './workspace-header-fallback-menu';
import { WorkspaceDocumentHeaderActions, BrowserColumnMediaActions } from './browser-column-surface-actions';

export interface BrowserColumnHeaderProps {
  current: BrowserColumnEntry | null;
  webAddressBarVisible?: boolean;
  onToggleWebAddressBar?: () => void;
  activeSurfaceChrome: BrowserColumnSurfaceChrome;
  runtimeTitle?: string | null;
  runtimeIcon?: string | null;
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

/** Secondary-session adapter; physical position does not select content features. */
export function BrowserColumnHeader(props: BrowserColumnHeaderProps) {
  const { t } = useI18n();
  const { current } = props;
  const navigation = useWorkspaceSessionNavigation('column-2');
  const agentInstanceId = current?.target.kind === 'agent_conversation' ? current.target.instanceId : null;
  const collectionPath = browserCollectionIndexPath(current);
  const target = current?.target.kind === 'file-browser' ? current.target : null;
  const path = target?.activeFilePath ?? null;
  const sourceKind: WorkspaceSurfaceKind = path ? `file-${resolveWorkspaceFileSurfaceKind(path)}`
    : current?.target.kind === 'web' ? 'web' : current?.target.kind === 'agent_conversation' ? 'agent-conversation'
      : current?.target.kind === 'media' ? 'media' : current?.target.kind === 'plugin-workbench' ? 'plugin-workbench'
        : collectionPath ? 'collection' : 'file-browser';
  const collection = collectionPath ? {
    indexPath: collectionPath,
    notebookId: current?.target.kind === 'folder-collection' ? current.target.notebookId : target?.notebookId,
    notebookPath: current?.target.kind === 'folder-collection' ? current.target.notebookPath : target?.scopePath,
  } : null;
  const mediaTarget = current?.target.kind === 'media'
    ? { filePath: current.target.filePath, notebookPath: current.target.notebookPath, notebookId: current.target.notebookId }
    : path && props.activeSurfaceChrome === 'media' ? { filePath: path, notebookPath: target?.scopePath ?? null, notebookId: target?.notebookId ?? null } : null;
  const navigate = async (direction: 'back' | 'forward') => {
    try { if (await navigation[direction]() === null) toast.error(t('tabWindow.switchFailed')); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('tabWindow.switchFailed')); }
  };
  return <WorkspaceHeader columnId="column-2"
    isWindows={typeof navigator !== 'undefined' && /Windows|Win32/.test(navigator.userAgent + navigator.platform)}
    presentation={{ chrome: props.activeSurfaceChrome, backgroundColor: props.headerBackgroundColor,
      contentKind: props.surfaceContentKind ?? sourceKind, sourceKind, capabilities: props.surfaceCapabilities,
      collection: Boolean(collection), identity: { title: props.runtimeTitle, icon: props.runtimeIcon },
      indexable: sourceKind === 'file-markdown' && Boolean(target?.notebookId && target.scopePath
        && path && notebookRelativeDirectoryPath(target.scopePath, path) !== null) }}
    sidebar={{ hidden: false, noteNavigationVisible: false, onToggle: () => {} }}
    navigation={{ ...navigation, onNavigateBack: () => void navigate('back'), onNavigateForward: () => void navigate('forward') }}
    agent={agentInstanceId ? (beforeMoreMenu) => <AgentConversationHeaderContent beforeMoreMenu={beforeMoreMenu} columnId="column-2" key={agentInstanceId} instanceId={agentInstanceId} /> : undefined}
    webAddressBarVisible={props.webAddressBarVisible}
    onToggleWebAddressBar={current?.target.kind === 'web' ? props.onToggleWebAddressBar : undefined}
    onCloseColumn={props.onCloseColumn} onCreateNote={props.onCreateNote} onCreateAgentConversation={props.onCreateAgentConversation}
    actions={(header, iconButtonClass) => current?.target.kind === 'agent_conversation' ? null
      : mediaTarget ? <BrowserColumnMediaActions {...mediaTarget} collectionPath={collectionPath} iconButtonClass={iconButtonClass} />
      : path && target ? <WorkspaceDocumentHeaderActions columnId="column-2" key={`${current?.id}:${path}`}
        path={path} scopePath={target.scopePath} notebookId={target.notebookId} header={header}
        collectionPath={collectionPath} surfaceId={current!.id} onToggleMemoEditorMode={props.onToggleMemoEditorMode}
        iconButtonClass={iconButtonClass} />
      : <WorkspaceHeaderContentActions collection={collection} iconButtonClass={iconButtonClass}
        fallback={current?.target.kind === 'web' ? undefined : <WorkspaceHeaderFallbackMenu columnId="column-2"
          iconButtonClass={iconButtonClass} canCreate={props.canCreate} onCreateNote={props.onCreateNote}
          onCreateAgentConversation={props.onCreateAgentConversation}
          onOpenInWorkColumn={current && canOpenBrowserColumnTargetInWorkColumn(current.target)
            ? () => void props.onOpenInWorkColumn(current.id) : undefined} />} />}
  />;
}
