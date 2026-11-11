import { canonicalDirectoryPath, canonicalPath, samePath } from '@/lib/path';
import type { DocTreeItem } from '@platform/tauri/client';

interface NotebookTreeMoveFeedback {
  paths: readonly string[];
  targetDirectoryPath: string;
  status: 'moving' | 'success';
}

export interface NotebookTreeRowPresentationInput {
  item: DocTreeItem;
  activeFilePath: string | null;
  selectedFolderPath: string | null;
  selectedConversationId: string | null;
  selectedFilePaths: readonly string[];
  selectedFilePathSet: ReadonlySet<string>;
  expandedPaths: ReadonlySet<string>;
  loadingDirectories?: ReadonlySet<string>;
  directoryErrors?: ReadonlySet<string>;
  dragOverFolderPath: string | null;
  moveFeedback: NotebookTreeMoveFeedback | null;
}

export interface NotebookTreeRowPresentation {
  expanded: boolean;
  isLoadingChildren: boolean;
  childrenError: boolean;
  active: boolean;
  selected: boolean;
  isDropTarget: boolean;
  moveStatus: NotebookTreeMoveFeedback['status'] | undefined;
}

/** Derives row state shared by pinned and ordinary file-tree entries. */
export function getNotebookTreeRowPresentation({
  item,
  activeFilePath,
  selectedFolderPath,
  selectedConversationId,
  selectedFilePaths,
  selectedFilePathSet,
  expandedPaths,
  loadingDirectories,
  directoryErrors,
  dragOverFolderPath,
  moveFeedback,
}: NotebookTreeRowPresentationInput): NotebookTreeRowPresentation {
  const itemPath = canonicalPath(item.fullPath);
  const isFolder = item.type === 'folder';
  const active = !selectedConversationId && selectedFilePaths.length === 0 && (isFolder
    ? Boolean(selectedFolderPath) && itemPath === canonicalPath(selectedFolderPath ?? '')
    : !selectedFolderPath && Boolean(activeFilePath) && itemPath === canonicalPath(activeFilePath ?? ''));
  const selected = selectedFilePathSet.has(itemPath);
  const isDropTarget = isFolder
    && dragOverFolderPath !== null
    && canonicalDirectoryPath(item.fullPath) === canonicalDirectoryPath(dragOverFolderPath);
  const isMovingTarget = isFolder
    && moveFeedback !== null
    && samePath(item.fullPath, moveFeedback.targetDirectoryPath);
  const isMovingSource = moveFeedback !== null
    && moveFeedback.paths.some((path) => samePath(path, item.fullPath));

  return {
    expanded: isFolder && expandedPaths.has(itemPath),
    isLoadingChildren: loadingDirectories?.has(canonicalDirectoryPath(item.fullPath)) ?? false,
    childrenError: directoryErrors?.has(canonicalDirectoryPath(item.fullPath)) ?? false,
    active,
    selected,
    isDropTarget,
    moveStatus: isMovingTarget || isMovingSource ? moveFeedback?.status : undefined,
  };
}
