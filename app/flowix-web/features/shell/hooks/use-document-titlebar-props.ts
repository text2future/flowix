import { resolveWorkspaceHeaderModel } from '@features/workspace/public/header-api';
import { getWorkspaceAgentRepositories } from '@features/agent/public/workspace-api';
import { useSessionAddressBar } from '@features/workspace/public/session-header-api';
import { openSurfaceInColumn } from '@features/workspace/public/session-opening-api';
import { resolveWorkspaceFileSurfaceKind, type FileBrowserContext } from '@features/workspace/public/surface-api';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { collectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';

import {
  resolveDocumentTitlebarTarget,
  type DocumentEditorMode,
  type DocumentTitlebarProps,
} from '@features/document/public/shell-api';
import {
  resolveMainColumnRuntimePresentation,
  collectionIndexPath,
  markRepositoryBreadcrumbItems,
  useWorkspaceSurfacePresentation,
  resolveDocumentBreadcrumb,
  type MainColumnPresentation,
} from '@features/surface/public/shell-api';
import type { Notebook } from '@features/memo/public/shell-api';
import type {
  useShellDocumentViewModel,
} from '@features/document/public/shell-api';

type ActiveExternalSession = ReturnType<typeof useShellDocumentViewModel>['activeExternalSession'];
type RuntimePresentation = ReturnType<typeof useWorkspaceSurfacePresentation>;
type WorkCapabilities = ReturnType<typeof resolveMainColumnRuntimePresentation>['capabilities'];
type WorkHeaderStyle = ReturnType<typeof resolveMainColumnRuntimePresentation>['chrome'];

export interface UseDocumentTitlebarPropsInput {
  mainColumnPresentation: MainColumnPresentation;
  workRuntimePresentation: RuntimePresentation;
  workCapabilities: WorkCapabilities;
  workHeaderStyle: WorkHeaderStyle;
  browserColumnVisible: boolean;
  mainEditorMode: DocumentEditorMode;
  handleSetMainEditorMode: (mode: DocumentEditorMode) => void;
  isMemoListHidden: boolean;
  handleToggleMemoList: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  handleNavigateBack: () => void;
  handleNavigateForward: () => void;
  handleCopyFullText: () => void;
  handleExportMarkdown: () => void;
  handleSaveAsTemplate: () => void;
  handleExportWord: () => void;
  handleExportPdf: () => void;
  handleDeleteExternalFile: (expectedFilePath: string, notebookPath: string | null) => Promise<void>;
  mediaActions: DocumentTitlebarProps['mediaActions'];
  activeExternalSession: ActiveExternalSession;
  selectedNotebook: Notebook | null;
  /** File-browser context for the current Work target, if it owns one. */
  fileBrowserContext?: FileBrowserContext | null;
  /** Fallback ownership lookup: some surfaces (file tree, access space) carry no scopePath. */
  notebooks?: readonly { id?: string; path: string }[];
}

/**
 * Assembles the `DocumentTitlebarProps` object shared by the Windows and Mac
 * document titlebars, including session address state and collection context.
 */
export function useDocumentTitlebarProps(input: UseDocumentTitlebarPropsInput): DocumentTitlebarProps {
  const {
    mainColumnPresentation,
    workRuntimePresentation,
    workCapabilities,
    workHeaderStyle,
    browserColumnVisible,
    mainEditorMode,
    handleSetMainEditorMode,
    isMemoListHidden,
    handleToggleMemoList,
    canNavigateBack,
    canNavigateForward,
    handleNavigateBack,
    handleNavigateForward,
    handleCopyFullText,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
    handleExportPdf,
    handleDeleteExternalFile,
    mediaActions,
    activeExternalSession,
    selectedNotebook,
    fileBrowserContext = null,
    notebooks = [],
  } = input;
  const { t } = useI18n();
  const workWebSurfaceId = mainColumnPresentation.content.status === 'surface'
    && mainColumnPresentation.content.surface.kind === 'web'
    ? mainColumnPresentation.content.surface.instanceKey : null;
  const addressBar = useSessionAddressBar('column-1', workWebSurfaceId);
  const collectionPath = collectionIndexPath(mainColumnPresentation.content.status === 'surface'
    ? mainColumnPresentation.content.surface : null);

  const source = mainColumnPresentation.content.status === 'surface' ? mainColumnPresentation.content.surface : null;
  const collectionDisplayId = source && 'fileIdentity' in source && source.fileIdentity
    ? source.fileIdentity.displayId : null;
  const registeredCollectionId = collectionDisplayId
    ? collectionDisplayDescriptor(collectionDisplayId)?.collectionId ?? null
    : null;
  const collectionId = source?.kind === 'folder-collection' ? null
    : (source?.kind === 'file-browser' ? source.collectionDisplay?.collectionId
      : source?.kind === 'table-file' ? source.props.expectedCollectionId
        : source && 'expectedCollectionId' in source ? source.expectedCollectionId : undefined)
      ?? registeredCollectionId;
  const fileBrowser = source?.kind === 'file-browser' && source.fileIdentity ? source : null;
  const currentFileBrowserContext: FileBrowserContext | null = fileBrowser ?? fileBrowserContext;
  const notebookPathForId = (notebookId: string | null | undefined) => notebookId
    ? notebooks.find((notebook) => notebook.id === notebookId)?.path
      ?? (selectedNotebook?.id === notebookId ? selectedNotebook.path : null)
    : null;
  const titlebarSession = activeExternalSession ? {
    ...activeExternalSession,
    notebookPath: activeExternalSession.notebookPath ?? notebookPathForId(activeExternalSession.notebookId),
  } : null;
  const fileBrowserNotebookPath = notebookPathForId(fileBrowser?.notebookId);
  const relativePath = fileBrowserNotebookPath && fileBrowser?.activeFilePath
    ? notebookRelativeDirectoryPath(fileBrowserNotebookPath, fileBrowser.activeFilePath) : null;
  const header = resolveWorkspaceHeaderModel({
    chrome: workHeaderStyle, contentKind: workRuntimePresentation.contentKind ?? mainColumnPresentation.contentKind,
    sourceKind: fileBrowser?.activeFilePath ? `file-${resolveWorkspaceFileSurfaceKind(fileBrowser.activeFilePath)}`
      : source?.kind === 'md' ? 'file-markdown' : source?.kind === 'html-file' ? 'file-html' : null,
    capabilities: workCapabilities,
  });

  const breadcrumbRepositoryNotebookIds = [...new Set([
    currentFileBrowserContext?.notebookId,
    activeExternalSession?.notebookId,
    fileBrowser?.notebookId,
    selectedNotebook?.id,
  ].filter((id): id is string => Boolean(id)))];
  const repositoryPaths = breadcrumbRepositoryNotebookIds.flatMap((notebookId) =>
    getWorkspaceAgentRepositories(notebookId).map((repository) => repository.path));

  const documentTarget = mainColumnPresentation.header.kind === 'document'
    && mainColumnPresentation.header.document.externalFilePath
    && source && 'fileIdentity' in source && source.fileIdentity
    ? resolveDocumentTitlebarTarget(source.fileIdentity, fileBrowser ? {
        fileIdentity: source.fileIdentity, scopePath: fileBrowser.scopePath,
        notebookId: fileBrowser.notebookId, notebookPath: notebookPathForId(fileBrowser.notebookId), relativePath,
        indexable: header.contentKind === 'file-markdown' && Boolean(fileBrowser.notebookId) && relativePath !== null,
      } : titlebarSession, selectedNotebook?.path ?? null, repositoryPaths)
    : null;

  /** Path breadcrumb for the document header: notebook/repository root first,
   * then the folders leading to the file. Markdown notes only report content
   * capabilities (never a title), so the breadcrumb also drives the header
   * identity here. Collections keep their own tabbed shell instead. */
  const breadcrumbFilePath = documentTarget?.fileIdentity.path
    ?? (mainColumnPresentation.header.kind === 'document'
      ? mainColumnPresentation.header.document.externalFilePath : null);
  /** The selected notebook is only a root candidate when the file really lives inside it. */
  const selectedNotebookRoot = selectedNotebook?.path && breadcrumbFilePath
    && notebookRelativeDirectoryPath(selectedNotebook.path, breadcrumbFilePath) !== null
    ? selectedNotebook.path
    : null;
  const breadcrumb = markRepositoryBreadcrumbItems(resolveDocumentBreadcrumb({
    filePath: breadcrumbFilePath,
    collectionIndexPath: collectionPath,
    scopeRoots: [
      documentTarget?.scopePath,
      activeExternalSession?.scopePath,
      activeExternalSession?.notebookPath,
      fileBrowser?.scopePath,
      selectedNotebookRoot,
    ],
    notebookRoots: notebooks.map((notebook) => notebook.path),
    treeRoot: fileBrowser?.folderPath,
  }), repositoryPaths);

  return {
    headerBackgroundColor: workRuntimePresentation.headerBackgroundColor,
    breadcrumb,
    /** 面包屑文件夹弹层选中的文件在当前栏打开：换文档，不动栏本身。 */
    onBreadcrumbFileOpen: (filePath: string, rootPath: string) => {
      const scopePath = currentFileBrowserContext?.scopePath
        ?? activeExternalSession?.scopePath
        ?? documentTarget?.scopePath
        ?? rootPath;
      const notebookId = currentFileBrowserContext?.notebookId
        ?? activeExternalSession?.notebookId
        ?? documentTarget?.notebookId
        ?? null;
      const nextFileBrowserContext: FileBrowserContext = {
        notebookId,
        scopePath,
        folderPath: rootPath,
        fileTreeVisible: currentFileBrowserContext?.fileTreeVisible ?? true,
        fileTreeWidth: currentFileBrowserContext?.fileTreeWidth ?? 220,
      };
      void openSurfaceInColumn({
        columnId: 'column-1',
        target: { kind: 'external', path: filePath, scopePath, transitionId: null, fileBrowser: nextFileBrowserContext },
      }).catch(() => { toast.error(t('memo.fileTree.openFailed')); });
    },
    webAddressBarVisible: addressBar.visible,
    onToggleWebAddressBar: workWebSurfaceId ? addressBar.toggle : undefined,
    reserveWindowsControls: !browserColumnVisible,
    surfaceChrome: workHeaderStyle === 'media' ? 'media' as const : 'document' as const,
    showEditorFontSwitcher: header.showEditorFontSwitcher,
    showEditorModeToggle: header.showEditorModeToggle,
    editorMode: mainEditorMode,
    onSetEditorMode: handleSetMainEditorMode,
    document: {
      target: documentTarget,
      isolated: Boolean(fileBrowser),
    },
    sidebar: {
      hidden: isMemoListHidden,
      onToggle: handleToggleMemoList,
    },
    navigation: {
      canNavigateBack,
      canNavigateForward,
      onNavigateBack: handleNavigateBack,
      onNavigateForward: handleNavigateForward,
      title: workRuntimePresentation.title,
      icon: workRuntimePresentation.icon,
    },
    contentCapabilities: header.documentControls,
    actions: {
      onCopyFullText: handleCopyFullText,
      onExportMarkdown: handleExportMarkdown,
      onSaveAsTemplate: handleSaveAsTemplate,
      onExportWord: handleExportWord,
      onExportPdf: handleExportPdf,
      onDeleteExternalFile: () => {
        if (documentTarget) {
          void handleDeleteExternalFile(documentTarget.fileIdentity.path, documentTarget.scopePath);
        }
      },
    },
    mediaActions,
    collectionDisplay: collectionPath ? {
      indexPath: collectionPath,
      notebookId: source?.kind === 'table-file' ? source.props.notebookId
        : source && 'notebookId' in source ? source.notebookId : null,
      notebookPath: source?.kind === 'table-file' ? source.props.notebookPath
        : source && 'notebookPath' in source ? source.notebookPath
          : source?.kind === 'file-browser' ? source.scopePath : null,
      collectionPath: source?.kind === 'folder-collection' ? source.folderPath : collectionPath,
      collectionId,
      name: source?.kind === 'folder-collection' ? source.folderName : workRuntimePresentation.title,
    } : null,
  };
}
