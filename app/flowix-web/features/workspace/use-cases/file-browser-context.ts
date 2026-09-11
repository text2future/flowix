import { getSelectedWorkspaceNotebookId } from '@features/memo/public/workspace-api';
import { getWorkspaceAgentResourceFolders } from '@features/agent/public/workspace-api';
import { resolveFileBrowserRoot, type FileBrowserContext } from '../store/file-browser-target';

/** Capture ownership once, independently of whichever notebook is selected later. */
export function captureFileBrowserContext(
  filePath: string | null,
  scopePath: string | null = null,
  folderPath: string | null = null,
): FileBrowserContext {
  const notebookId = getSelectedWorkspaceNotebookId();
  const resourceRoot = resolveFileBrowserRoot(
    filePath,
    getWorkspaceAgentResourceFolders(notebookId),
  );
  return {
    notebookId, folderPath, scopePath: scopePath ?? resourceRoot,
    fileTreeVisible: true, fileTreeWidth: 220,
  };
}
