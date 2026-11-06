import type { CollectionIndexItem, PluginDescriptor } from '@platform/tauri/client';
import type { CollectionDisplayDescriptor } from '@/lib/collection-display-registry';

/** Public content targets have no dependency on a host store or React view. */
export interface FileBrowserContext {
  /** Only legacy tabs lack a notebook binding; bind them once when restored. */
  restoreNotebookContext?: boolean;
  /** File path whose notebookId/scopePath were resolved together by the native filesystem resolver. */
  notebookContextPath?: string;
  folderPath: string | null;
  notebookId: string | null;
  scopePath: string | null;
  fileTreeVisible: boolean;
  fileTreeWidth: number;
}

export interface FileBrowserTarget extends FileBrowserContext {
  kind: 'file-browser';
  activeFilePath: string | null;
  collectionDisplay?: CollectionDisplayDescriptor;
  collectionType?: CollectionIndexItem['collectionType'];
  collectionUnavailableReason?: string;
}

export interface CollectionSurfaceTarget {
  kind: 'collection';
  displayId: string;
  notebookId: string;
  collectionId: string;
  viewId: string | null;
  collectionType: CollectionIndexItem['collectionType'];
  filePath: string;
  notebookPath: string;
  name: string;
  unavailableReason?: string;
}

/** Folder-scoped Collection surface before the folder's collection type is selected. */
export interface FolderCollectionSurfaceTarget {
  kind: 'folder-collection';
  folderPath: string;
  notebookId: string;
  notebookPath: string;
  folderName: string;
  viewMode?: 'work-documents';
}

export type WorkspaceContentTarget =
  | { kind: 'empty' }
  | CollectionSurfaceTarget
  | FolderCollectionSurfaceTarget
  | {
      kind: 'external';
      /** One-time tree reveal policy for this navigation; not document data. */
      treeReveal?: 'created-note';
      fileBrowser?: FileBrowserContext;
      path: string;
      scopePath: string | null;
      /** Compatibility input; navigation adapters own transition IDs. */
      transitionId?: number | null;
    }
  | { kind: 'table'; filePath: string; notebookPath: string | null; notebookId: string | null; unavailableReason?: string }
  | {
      kind: 'media';
      filePath: string;
      notebookId: string | null;
      notebookPath: string | null;
      resourceKind: 'image' | 'video';
    }
  | { kind: 'media-library'; filePath: string; notebookPath: string | null; notebookId: string | null; unavailableReason?: string }
  | {
      kind: 'agent-conversation';
      instanceId: string;
      /** A temporary empty draft should restore as an empty work column if it has vanished. */
      blankIfMissing?: true;
    }
  /** View identity only. Plugin run state and artifacts live in host stores. */
  | { kind: 'plugin-workbench'; plugin: PluginDescriptor }
  | { kind: 'web'; url: string };


export interface CollectionReferenceSurfaceTarget {
  kind: 'collection-reference';
  notebookId: string;
  collectionId: string;
  collectionKind?: CollectionIndexItem['collectionType'];
  viewId?: string | null;
  displayId?: string;
  relativePathHint?: string;
  filePath?: string;
}

export type WorkspaceSurfaceOpenTarget = WorkspaceContentTarget | FileBrowserTarget | CollectionReferenceSurfaceTarget;
/** Empty is a host state, not an open request. */
export type WorkWorkspaceSurfaceTarget = FileBrowserTarget | Exclude<WorkspaceContentTarget, { kind: 'empty' }> | CollectionReferenceSurfaceTarget;
export type BrowserWorkspaceSurfaceTarget = WorkWorkspaceSurfaceTarget;
