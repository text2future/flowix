import { resolveWorkspaceHeaderModel } from '@features/workspace/public/header-api';
import { useSessionAddressBar } from '@features/workspace/public/session-header-api';
import { openWorkspaceSurface } from '@features/workspace/public/session-opening-api';
import { resolveWorkspaceFileSurfaceKind } from '@features/workspace/public/surface-api';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';

import {
  resolveDocumentTitlebarTarget,
  type DocumentEditorMode,
  type DocumentTitlebarProps,
} from '@features/document/public/shell-api';
import {
  resolveWorkColumnRuntimePresentation,
  collectionIndexPath,
  useWorkspaceSurfacePresentation,
  resolveDocumentBreadcrumb,
  type WorkColumnPresentation,
} from '@features/surface/public/shell-api';
import type { Notebook } from '@features/memo/public/shell-api';
import type {
  useShellDocumentViewModel,
} from '@features/document/public/shell-api';

type ActiveExternalSession = ReturnType<typeof useShellDocumentViewModel>['activeExternalSession'];
type RuntimePresentation = ReturnType<typeof useWorkspaceSurfacePresentation>;
type WorkCapabilities = ReturnType<typeof resolveWorkColumnRuntimePresentation>['capabilities'];
type WorkHeaderStyle = ReturnType<typeof resolveWorkColumnRuntimePresentation>['chrome'];

export interface UseDocumentTitlebarPropsInput {
  workColumnPresentation: WorkColumnPresentation;
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
  handleCopyLink: () => void;
  handleCopyFullText: () => void;
  handleExportMarkdown: () => void;
  handleSaveAsTemplate: () => void;
  handleExportWord: () => void;
  handleExportPdf: () => void;
  handleDeleteExternalFile: (expectedFilePath: string, notebookPath: string | null) => Promise<void>;
  mediaActions: DocumentTitlebarProps['mediaActions'];
  activeExternalSession: ActiveExternalSession;
  selectedNotebook: Notebook | null;
  /** Fallback ownership lookup: some surfaces (file tree, access space) carry no scopePath. */
  notebooks?: readonly { path: string }[];
}

/**
 * Assembles the `DocumentTitlebarProps` object shared by the Windows and Mac
 * document titlebars, including session address state and collection context.
 */
export function useDocumentTitlebarProps(input: UseDocumentTitlebarPropsInput): DocumentTitlebarProps {
  const {
    workColumnPresentation,
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
    handleCopyLink,
    handleCopyFullText,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
    handleExportPdf,
    handleDeleteExternalFile,
    mediaActions,
    activeExternalSession,
    selectedNotebook,
    notebooks = [],
  } = input;
  const { t } = useI18n();
  const workWebSurfaceId = workColumnPresentation.content.status === 'surface'
    && workColumnPresentation.content.surface.kind === 'web'
    ? workColumnPresentation.content.surface.instanceKey : null;
  const addressBar = useSessionAddressBar('column-1', workWebSurfaceId);
  const collectionPath = collectionIndexPath(workColumnPresentation.content.status === 'surface'
    ? workColumnPresentation.content.surface : null);

  const source = workColumnPresentation.content.status === 'surface' ? workColumnPresentation.content.surface : null;
  const fileBrowser = source?.kind === 'file-browser' && source.fileIdentity ? source : null;
  const relativePath = fileBrowser?.scopePath && fileBrowser.activeFilePath
    ? notebookRelativeDirectoryPath(fileBrowser.scopePath, fileBrowser.activeFilePath) : null;
  const header = resolveWorkspaceHeaderModel({
    chrome: workHeaderStyle, contentKind: workRuntimePresentation.contentKind ?? workColumnPresentation.contentKind,
    sourceKind: fileBrowser?.activeFilePath ? `file-${resolveWorkspaceFileSurfaceKind(fileBrowser.activeFilePath)}`
      : source?.kind === 'md' ? 'file-markdown' : source?.kind === 'html-file' ? 'file-html' : null,
    capabilities: workCapabilities,
  });

  const documentTarget = workColumnPresentation.header.kind === 'document'
    && workColumnPresentation.header.document.externalFilePath
    && source && 'fileIdentity' in source && source.fileIdentity
    ? resolveDocumentTitlebarTarget(source.fileIdentity, fileBrowser ? {
        fileIdentity: source.fileIdentity, scopePath: fileBrowser.scopePath,
        notebookId: fileBrowser.notebookId, relativePath,
        indexable: header.contentKind === 'file-markdown' && Boolean(fileBrowser.notebookId) && relativePath !== null,
      } : activeExternalSession, selectedNotebook?.path ?? null)
    : null;

  /** Path breadcrumb for the document header: notebook/repository root first,
   * then the folders leading to the file. Markdown notes only report content
   * capabilities (never a title), so the breadcrumb also drives the header
   * identity here. Collections keep their own tabbed shell instead. */
  const breadcrumbFilePath = documentTarget?.fileIdentity.path
    ?? (workColumnPresentation.header.kind === 'document'
      ? workColumnPresentation.header.document.externalFilePath : null);
  /** The selected notebook is only a root candidate when the file really lives inside it. */
  const selectedNotebookRoot = selectedNotebook?.path && breadcrumbFilePath
    && notebookRelativeDirectoryPath(selectedNotebook.path, breadcrumbFilePath) !== null
    ? selectedNotebook.path
    : null;
  const breadcrumb = resolveDocumentBreadcrumb({
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
  });

  return {
    headerBackgroundColor: workRuntimePresentation.headerBackgroundColor,
    breadcrumb,
    /** 面包屑文件夹弹层选中的文件在当前栏打开：换文档，不动栏本身。 */
    onBreadcrumbFileOpen: (filePath: string, scopePath: string) => {
      void openWorkspaceSurface({
        columnId: 'column-1',
        target: { kind: 'external', path: filePath, scopePath, transitionId: null },
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
      onCopyLink: handleCopyLink,
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
    } : null,
  };
}
