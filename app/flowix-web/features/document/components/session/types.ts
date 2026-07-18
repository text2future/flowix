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
