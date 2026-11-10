import type { Editor } from '@tiptap/core';
import type { FileDisplayIdentity } from '@/lib/file-display-registry';
import type { SurfaceLifecycle, WorkspaceColumnId } from '@features/workspace/public/surface-api';

export interface LoadContentOptions {
  preservePending?: boolean;
  showLoading?: boolean;
}

export type DocumentContentStatus =
  | { status: 'loading'; retainContent: boolean }
  | { status: 'ready' }
  | { status: 'missing-note'; path: string; retry: () => void | Promise<void> }
  | { status: 'error'; message: string; retry: () => void | Promise<void> };

export interface DocumentContainerState {
  isLoaded: boolean;
  isLoading: boolean;
  error: string | null;
  errorKind: 'missing-note' | 'error' | null;
  isScrolled: boolean;
  isNewlyCreated: boolean;
  createdAt: string;
  updatedAt: string;
  updatedAtDate: Date | null;
  isFavorited: boolean;
  frontmatterMeta: Record<string, unknown>;
}

export interface DocumentContainerProps {
  /** Runtime identity supplied by the owning open session or file surface. */
  fileIdentity: FileDisplayIdentity;
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
  isExternalDocument?: boolean;
  /** Authorized file-tree root for external code/text files. */
  externalScopePath?: string | null;
  /** Select the editor used to render an external document. Defaults to source code. */
  externalEditorMode?: 'code' | 'markdown';
  // Controlled by main-layout so the titlebar button and Ctrl+F share one state.
  searchPanelOpen?: boolean;
  onSearchPanelOpenChange?: (open: boolean) => void;
  /** Keep this editor out of the main workspace's singleton document session. */
  documentSessionMode?: 'main' | 'isolated';
  /** Explicit host supplied by the workspace surface protocol. */
  workspaceHost?: WorkspaceColumnId;
  /** Runtime surface identity used to bind one-shot Agent navigation requests. */
  navigationViewId?: string;
  /** Render the document without edit or metadata mutation controls. */
  readOnly?: boolean;
  /** One-shot focus requested by the memo creation/open transaction. */
  initialFocus?: 'title' | 'body';
  /** Expose the active rich-text editor to document-level exporters. */
  onEditorReady?: (editor: Editor | null) => void;
  /** Publish the loaded view's lifecycle; null releases this editor's registration. */
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  /** Publish the actual content read state to the owning surface adapter. */
  onContentStateChange?: (state: DocumentContentStatus) => void;
  /** Register the active editor flush used by tabbed hosts before switching. */
  onFlushReady?: (
    flush: ((options?: { silent?: boolean }) => Promise<boolean>) | null,
    discard?: (() => void) | null,
  ) => void;
}

export const initialDocumentContainerState: DocumentContainerState = {
  isLoaded: false,
  isLoading: false,
  error: null,
  errorKind: null,
  isScrolled: false,
  isNewlyCreated: false,
  createdAt: '',
  updatedAt: '',
  updatedAtDate: null,
  isFavorited: false,
  frontmatterMeta: {},
};
