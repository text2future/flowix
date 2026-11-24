import type { FileDisplayIdentity } from '@/lib/file-display-registry';
import type { DocumentEditorMode } from '@features/document/store/document-editor-view-store';
import { samePath, notebookRelativeDirectoryPath } from '@/lib/path';

/** Snapshot of the displayed file; commands never resolve a different active session. */
export interface DocumentTitlebarTarget {
  fileIdentity: FileDisplayIdentity;
  scopePath: string | null;
  notebookId: string | null;
  relativePath: string | null;
  indexable: boolean;
  isOutsideCurrentNotebook: boolean;
  /** The displayed file is inside one of this notebook's configured repositories. */
  isRepository?: boolean;
}

interface TitlebarDocumentSession {
  fileIdentity: FileDisplayIdentity;
  scopePath: string | null;
  notebookId?: string | null;
  /** Actual notebook root; scopePath may be a narrower repository access scope. */
  notebookPath?: string | null;
  relativePath?: string | null;
  indexable?: boolean;
}

export function resolveDocumentTitlebarTarget(
  fileIdentity: FileDisplayIdentity,
  session: TitlebarDocumentSession | null,
  currentNotebookPath: string | null,
  repositoryPaths: readonly string[] = [],
): DocumentTitlebarTarget {
  const matchingSession = session?.fileIdentity.displayId === fileIdentity.displayId
    && samePath(session.fileIdentity.path, fileIdentity.path)
    ? session : null;
  const notebookPath = matchingSession?.notebookPath
    ?? (matchingSession?.notebookId ? null : currentNotebookPath);
  return {
    fileIdentity,
    scopePath: matchingSession ? matchingSession.scopePath : currentNotebookPath,
    notebookId: matchingSession?.notebookId ?? null,
    relativePath: matchingSession?.relativePath ?? null,
    indexable: matchingSession?.indexable === true,
    isOutsideCurrentNotebook: !notebookPath
      || notebookRelativeDirectoryPath(notebookPath, fileIdentity.path) === null,
    isRepository: repositoryPaths.some((repositoryPath) =>
      notebookRelativeDirectoryPath(repositoryPath, fileIdentity.path) !== null),
  };
}

/**
 * Path breadcrumb items shown in the document header; styled after the
 * file-browser breadcrumbs. Structurally identical to the workspace header's
 * own item type (a shell-private module, so the shape is mirrored here rather
 * than exported through a barrel for three fields).
 */
export interface DocumentTitlebarBreadcrumbItem {
  label: string;
  type?: 'folder' | 'file';
  /** Marks a registered repository root so its folder popover can show the repository icon. */
  isRepository?: boolean;
  /** Segment path; folder segments use it to open the file tree popover. */
  path?: string;
}

export interface DocumentTitlebarProps {
  webAddressBarVisible?: boolean;
  onToggleWebAddressBar?: () => void;
  reserveWindowsControls?: boolean;
  /** Surface-specific titlebar skin for non-editable document-like views. */
  surfaceChrome?: 'document' | 'media';
  headerBackgroundColor?: string | null;
  /** Show Markdown editor typography controls in the More menu. */
  showEditorFontSwitcher?: boolean;
  /** Show the document source/rich or HTML source/preview toggle in the More menu. */
  showEditorModeToggle?: boolean;
  editorMode?: DocumentEditorMode;
  onSetEditorMode?: (mode: DocumentEditorMode) => void;
  /** 文档路径面包屑（根段=笔记本/仓库目录名）；缺省时标题栏回退为普通标题。 */
  breadcrumb?: DocumentTitlebarBreadcrumbItem[] | null;
  /** 面包屑文件夹弹层选中文件后，在当前栏打开它（缺省则面包屑只展示）。 */
  onBreadcrumbFileOpen?: (filePath: string, rootPath: string) => void;
  document: {
    target: DocumentTitlebarTarget | null;
    /** File-browser editors own their buffer and commands independently of the primary document store. */
    isolated?: boolean;
  };
  sidebar: {
    hidden: boolean;
    onToggle: () => void;
  };
  navigation: {
    canNavigateBack: boolean;
    canNavigateForward: boolean;
    onNavigateBack: () => void;
    onNavigateForward: () => void;
    visible?: boolean;
    title?: string | null;
    icon?: string | null;
  };
  contentCapabilities: {
    copyFullText: boolean;
    memoColors: boolean;
    exportContent: boolean;
    saveAsTemplate: boolean;
    versionHistory: boolean;
  };
  actions: {
    onCopyFullText: () => void;
    onExportMarkdown: () => void;
    onSaveAsTemplate: () => void;
    onExportWord: () => void;
    onExportPdf: () => void;
    onDeleteExternalFile: () => void | Promise<void>;
  };
  mediaActions?: {
    onCopyLink: () => void | Promise<void>;
    onRevealInFileManager: () => void;
    onRequestDelete: () => void;
  };
  /**
   * 当前内容是集合时给出地址与所属笔记本；文档、媒体和文件夹菜单共享集合操作。
   * 文件夹入口没有其它操作菜单时，标题栏单独渲染集合菜单。
   */
  collectionDisplay?: {
    isFolder?: boolean;
    indexPath: string;
    notebookPath?: string | null;
    notebookId?: string | null;
    collectionPath?: string | null;
    collectionId?: string | null;
    name?: string | null;
    supportsNotes?: boolean;
  } | null;
}
