import { useWorkspaceSessionNavigation } from '@features/workspace/public/session-navigation-api';
import { getWorkspaceAgentRepositories } from '@features/agent/public/workspace-api';
import { canOpenBrowserTargetInMainColumn, openBrowserContentInMainColumn, selectBrowserColumnFile, type BrowserColumnEntry } from '@features/workspace/public/browser-column-api';
import type { BrowserColumnSurfaceChrome } from '@features/surface/public/shell-api';
import { browserCollectionIndexPath, markRepositoryBreadcrumbItems, resolveDocumentBreadcrumb } from '@features/surface/public/shell-api';
import { useShellNotebooks } from '@features/memo/public/shell-api';
import { useShellSelectedNotebook } from '@features/memo/public/note-creation-api';
import { AgentConversationHeaderContent } from '@features/agent/public/header-api';
import { resolveWorkspaceFileSurfaceKind, type FileBrowserContext, type WorkspaceSurfaceKind, type WorkspaceSurfaceCapability } from '@features/workspace/public/surface-api';
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
  /** Resolved file-browser ownership/scope shared with the rendered surface. */
  resolvedFileBrowserContext?: FileBrowserContext | null;
  onToggleMemoEditorMode: (surfaceId: string) => void | Promise<void>;
  onCloseColumn?: () => void;
  onCreateNote: (templateId?: string) => void;
  onCreateAgentConversation: (typeKey: AgentTypeKey) => void;
}

/** Secondary-session adapter; physical position does not select content features. */
export function BrowserColumnHeader(props: BrowserColumnHeaderProps) {
  const { t } = useI18n();
  const { current } = props;
  const navigation = useWorkspaceSessionNavigation('column-2');
  const notebooks = useShellNotebooks();
  const selectedNotebook = useShellSelectedNotebook();
  const agentInstanceId = current?.target.kind === 'agent-conversation' ? current.target.instanceId : null;
  const collectionPath = browserCollectionIndexPath(current);
  const target = current?.target.kind === 'file-browser' ? {
    ...current.target,
    ...(props.resolvedFileBrowserContext ?? {}),
  } : null;
  const path = target?.activeFilePath ?? null;
  const notebookPath = target?.notebookId
    ? notebooks.find((notebook) => notebook.id === target.notebookId)?.path
      ?? (selectedNotebook?.id === target.notebookId ? selectedNotebook.path : null)
    : null;
  const notebookRelativePath = notebookPath && path ? notebookRelativeDirectoryPath(notebookPath, path) : null;
  const sourceKind: WorkspaceSurfaceKind = path ? `file-${resolveWorkspaceFileSurfaceKind(path)}`
    : current?.target.kind === 'web' ? 'web' : current?.target.kind === 'agent-conversation' ? 'agent-conversation'
      : current?.target.kind === 'media' ? 'media' : current?.target.kind === 'plugin-workbench' ? 'plugin-workbench'
        : collectionPath ? 'collection' : 'file-browser';
  const collection = collectionPath ? {
    isFolder: current?.target.kind === 'folder-collection',
    indexPath: collectionPath,
    notebookId: current?.target.kind === 'folder-collection' ? current.target.notebookId : target?.notebookId,
    notebookPath: current?.target.kind === 'folder-collection' ? current.target.notebookPath : target?.scopePath,
    collectionPath: current?.target.kind === 'folder-collection' ? current.target.folderPath : collectionPath,
    collectionId: current?.target.kind === 'folder-collection' ? null : target?.collectionDisplay?.collectionId ?? null,
    name: current?.target.kind === 'folder-collection' ? current.target.folderName : props.runtimeTitle ?? null,
  } : null;
  const mediaTarget = current?.target.kind === 'media'
    ? { filePath: current.target.filePath, notebookPath: current.target.notebookPath, notebookId: current.target.notebookId }
    : path && props.activeSurfaceChrome === 'media' ? { filePath: path, notebookPath: target?.scopePath ?? null, notebookId: target?.notebookId ?? null } : null;
  // Same resolution chain as the work column (see resolveDocumentBreadcrumb):
  // the file-browser target often carries no scopePath, so ownership is derived
  // from the notebook list before falling back to the tree root.
  const repositoryPaths = getWorkspaceAgentRepositories(target?.notebookId ?? selectedNotebook?.id ?? null)
    .map((repository) => repository.path);
  const breadcrumb = markRepositoryBreadcrumbItems(resolveDocumentBreadcrumb({
    filePath: path,
    collectionIndexPath: collectionPath,
    scopeRoots: [target?.scopePath],
    notebookRoots: notebooks.map((notebook) => notebook.path),
    treeRoot: target?.folderPath,
  }), repositoryPaths);
  const navigate = async (direction: 'back' | 'forward') => {
    try { if (await navigation[direction]() === null) toast.error(t('tabWindow.switchFailed')); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('tabWindow.switchFailed')); }
  };
  return <WorkspaceHeader columnId="column-2"
    isWindows={typeof navigator !== 'undefined' && /Windows|Win32/.test(navigator.userAgent + navigator.platform)}
    presentation={{ chrome: props.activeSurfaceChrome, backgroundColor: props.headerBackgroundColor,
      contentKind: props.surfaceContentKind ?? sourceKind, sourceKind, capabilities: props.surfaceCapabilities,
      collection: Boolean(collection), identity: { title: props.runtimeTitle, icon: props.runtimeIcon },
      indexable: sourceKind === 'file-markdown' && Boolean(target?.notebookId && notebookRelativePath !== null) }}
    sidebar={{ hidden: false, onToggle: () => {} }}
    breadcrumb={breadcrumb}
    onBreadcrumbFileOpen={(filePath, rootPath) => {
      if (!current || current.target.kind !== 'file-browser') return;
      void selectBrowserColumnFile(current.id, filePath, rootPath).catch(() => {
        toast.error(t('memo.fileTree.openFailed'));
      });
    }}
    navigation={{ ...navigation, onNavigateBack: () => void navigate('back'), onNavigateForward: () => void navigate('forward') }}
    agent={agentInstanceId ? (beforeMoreMenu) => <AgentConversationHeaderContent beforeMoreMenu={beforeMoreMenu} columnId="column-2" key={agentInstanceId} instanceId={agentInstanceId} /> : undefined}
    webAddressBarVisible={props.webAddressBarVisible}
    onToggleWebAddressBar={current?.target.kind === 'web' ? props.onToggleWebAddressBar : undefined}
    onCloseColumn={props.onCloseColumn} onCreateNote={props.onCreateNote} onCreateAgentConversation={props.onCreateAgentConversation}
    actions={(header, iconButtonClass) => current?.target.kind === 'agent-conversation' ? null
      : mediaTarget ? <BrowserColumnMediaActions {...mediaTarget} collectionPath={collectionPath} iconButtonClass={iconButtonClass} />
      : path && target ? <WorkspaceDocumentHeaderActions columnId="column-2" key={`${current?.id}:${path}`}
        path={path} scopePath={target.scopePath} notebookId={target.notebookId} header={header}
        collectionPath={collectionPath} surfaceId={current!.id} onToggleMemoEditorMode={props.onToggleMemoEditorMode}
        iconButtonClass={iconButtonClass} />
      : <>
        <WorkspaceHeaderContentActions collection={collection} collectionHost={collection ? 'column-2' : undefined}
          notebookId={target?.notebookId} iconButtonClass={iconButtonClass} />
        {current && !collection && current.target.kind !== 'web' && <WorkspaceHeaderFallbackMenu columnId="column-2"
          iconButtonClass={iconButtonClass} onCreateNote={props.onCreateNote}
          onCreateAgentConversation={props.onCreateAgentConversation}
          onOpenInMainColumn={canOpenBrowserTargetInMainColumn(current.target)
            ? () => void openBrowserContentInMainColumn(current.id) : undefined} />}
      </>}
  />;
}
