import { resolveWorkspaceHeaderModel } from '@features/workspace/public/header-api';
import { useSessionAddressBar } from '@features/workspace/public/session-header-api';
import { resolveWorkspaceFileSurfaceKind } from '@features/workspace/public/surface-api';
import { notebookRelativeDirectoryPath } from '@/lib/path';

import {
  resolveDocumentTitlebarTarget,
  type DocumentEditorMode,
  type DocumentTitlebarProps,
} from '@features/document/public/shell-api';
import {
  resolveWorkColumnRuntimePresentation,
  collectionIndexPath,
  useWorkspaceSurfacePresentation,
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
  noteNavigationVisible: boolean;
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
    noteNavigationVisible,
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
  } = input;
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

  return {
    headerBackgroundColor: workRuntimePresentation.headerBackgroundColor,
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
      noteNavigationVisible,
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
