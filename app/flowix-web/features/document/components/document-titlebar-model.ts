import type { FileDisplayIdentity } from '@/lib/file-display-registry';
import type { DocumentEditorMode } from '@features/document/store/document-editor-view-store';
import { canonicalPath, notebookRelativeDirectoryPath } from '@/lib/path';

/** Snapshot of the displayed file; commands never resolve a different active session. */
export interface DocumentTitlebarTarget {
  fileIdentity: FileDisplayIdentity;
  scopePath: string | null;
  notebookId: string | null;
  relativePath: string | null;
  indexable: boolean;
  isOutsideCurrentNotebook: boolean;
}

interface TitlebarDocumentSession {
  fileIdentity: FileDisplayIdentity;
  scopePath: string | null;
  notebookId?: string | null;
  relativePath?: string | null;
  indexable?: boolean;
}

export function resolveDocumentTitlebarTarget(
  fileIdentity: FileDisplayIdentity,
  session: TitlebarDocumentSession | null,
  currentNotebookPath: string | null,
): DocumentTitlebarTarget {
  const matchingSession = session?.fileIdentity.displayId === fileIdentity.displayId
    && canonicalPath(session.fileIdentity.path) === canonicalPath(fileIdentity.path)
    ? session : null;
  return {
    fileIdentity,
    scopePath: matchingSession ? matchingSession.scopePath : currentNotebookPath,
    notebookId: matchingSession?.notebookId ?? null,
    relativePath: matchingSession?.relativePath ?? null,
    indexable: matchingSession?.indexable === true,
    isOutsideCurrentNotebook: !currentNotebookPath
      || notebookRelativeDirectoryPath(currentNotebookPath, fileIdentity.path) === null,
  };
}

/** Shared titlebar action button classes used by document and Agent titlebars. */
export const DOCUMENT_TITLEBAR_ICON_BUTTON_MAC =
  'w-8 h-8 flex enabled:!cursor-pointer disabled:!cursor-not-allowed items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-xl transition-colors bg-[color-mix(in_srgb,var(--bg-titlebar)_72%,transparent)] border border-[var(--border)]';
export const DOCUMENT_TITLEBAR_ICON_BUTTON_WIN =
  'w-8 h-8 flex enabled:!cursor-pointer disabled:!cursor-not-allowed items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg transition-colors';
/** macOS variant without the outer frame (no bg/border), used by the browser-column expand button. */
export const DOCUMENT_TITLEBAR_ICON_BUTTON_MAC_FRAMELESS =
  'w-8 h-8 flex enabled:!cursor-pointer disabled:!cursor-not-allowed items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-xl transition-colors';

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
  document: {
    target: DocumentTitlebarTarget | null;
  };
  sidebar: {
    hidden: boolean;
    noteNavigationVisible: boolean;
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
    onCopyLink: () => void;
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
  folderCollectionViewType?: {
    /** `work_documents` collections are non-switchable; the menu only offers table/media. */
    current: 'table' | 'media_library' | 'work_documents';
    onSelect: (type: 'table' | 'media_library') => void;
    isDefaultFolder: boolean;
    onToggleDefaultFolder: () => void;
  };
  /**
   * 当前 Work 面是集合时给出集合体地址：有文档/媒体操作菜单时将显示标题/头图并入该菜单；
   * 文件夹入口没有其它操作菜单时，标题栏单独渲染集合显示菜单。
   */
  collectionDisplay?: { indexPath: string } | null;
}
