export interface LoadContentOptions {
  preservePending?: boolean;
  showLoading?: boolean;
}

export interface DocumentContainerState {
  // fullContent includes frontmatter + body markdown
  fullContent: string;
  isLoading: boolean;
  error: string | null;
  isScrolled: boolean;
  isNewlyCreated: boolean;
  charCount: number;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
  updatedAtDate: Date | null;
  isFavorited: boolean;
  frontmatterMeta: Record<string, unknown>;
}

export interface DocumentContainerProps {
  filePath: string;
  memoId?: string | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  transitionId?: number | null;
  onMetainfoData?: (data: {
    charCount: number;
    tokenCount: number;
    createdAt: string;
    updatedAt: string;
    memoPath: string | null;
    memoContent: string;
    isFavorited: boolean;
    frontmatterMeta: Record<string, unknown>;
  }) => void;
  onCharCountChange?: (count: number) => void;
  isExternalDocument?: boolean;
  // Controlled by main-layout so the titlebar button and Ctrl+F share one state.
  searchPanelOpen?: boolean;
  onSearchPanelOpenChange?: (open: boolean) => void;
  // Toolbar collapsed — owned by main-layout. Toggled by the toolbar's own
  // collapse/expand buttons; no focus-based show/hide.
  toolbarCollapsed?: boolean;
  onToolbarCollapsedChange?: (collapsed: boolean) => void;
  // Lifted so the titlebar (rendered above the content area) can render the
  // file path and the "保存为笔记" button. Container is the only place that
  // holds the import hook (it needs the editor's contentRef + saveDoc), so
  // we publish the api upward via this callback. Pass `null` to clear.
  onExternalImportApiChange?: (api: { isSaving: boolean; save: () => void } | null) => void;
}

export const initialDocumentContainerState: DocumentContainerState = {
  fullContent: '',
  isLoading: false,
  error: null,
  isScrolled: false,
  isNewlyCreated: false,
  charCount: 0,
  tokenCount: 0,
  createdAt: '',
  updatedAt: '',
  updatedAtDate: null,
  isFavorited: false,
  frontmatterMeta: {},
};
