import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { getSelectedWorkspaceNotebookId, getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { getWorkspaceAgentResourceFolders } from '@features/agent/public/workspace-api';
import { resolveFileBrowserRoot, type FileBrowserContext } from '../store/file-browser-target';

/** Resolve file ownership at the workspace boundary, including restored content. */
export function resolveFileBrowserContext(
  filePath: string | null,
  context: FileBrowserContext,
): FileBrowserContext {
  const path = filePath ?? context.folderPath;
  const notebooks = getWorkspaceMemoState().notebooks;
  if (context.notebookContextPath) {
    const matchesFile = path && canonicalPath(path) === canonicalPath(context.notebookContextPath);
    const notebookExists = context.notebookId === null || notebooks.some(({ id }) => id === context.notebookId);
    if (matchesFile && notebookExists) {
      return { ...context, scopePath: context.scopePath ?? resolveFileBrowserRoot(
        path, getWorkspaceAgentResourceFolders(context.notebookId),
      ) };
    }
    // A binding belongs to one file. Never carry its notebook or scope to another file.
    context = { ...context, notebookContextPath: undefined, notebookId: null, scopePath: null };
  }
  const notebookRoot = resolveFileBrowserRoot(path, notebooks.map((notebook) => notebook.path));
  const owner = notebookRoot
    ? notebooks.find((notebook) => canonicalDirectoryPath(notebook.path) === canonicalDirectoryPath(notebookRoot))
    : undefined;
  const notebookId = owner?.id ?? context.notebookId;
  const scopePath = context.scopePath ?? notebookRoot ?? resolveFileBrowserRoot(
    path, getWorkspaceAgentResourceFolders(notebookId),
  );
  return { ...context, notebookId, scopePath };
}

/**
 * Notebook that owns a path purely by location.
 *
 * Unlike `resolveFileBrowserContext`, the selected notebook is never a fallback:
 * a file outside every notebook root has no owner. Callers use this for file
 * kinds whose ownership the backend does not resolve (anything but Markdown).
 */
export function notebookOwnerOfPath(path: string | null): { id: string; path: string } | null {
  if (!path) return null;
  const notebooks = getWorkspaceMemoState().notebooks;
  const root = resolveFileBrowserRoot(path, notebooks.map((notebook) => notebook.path));
  if (!root) return null;
  return notebooks.find((notebook) => canonicalDirectoryPath(notebook.path) === canonicalDirectoryPath(root)) ?? null;
}

/**
 * Same as `notebookOwnerOfPath`, but tolerates a not-yet-loaded notebook
 * registry — startup restoration can reach here before the registry IPC
 * lands, and an empty registry would silently answer "no owner".
 */
export async function notebookOwnerOfPathResolved(path: string | null): Promise<{ id: string; path: string } | null> {
  const owner = notebookOwnerOfPath(path);
  if (owner || !path) return owner;
  const state = getWorkspaceMemoState();
  if (state.notebooks.length > 0) return null;
  await state.loadNotebooks().catch(() => undefined);
  return notebookOwnerOfPath(path);
}

/** Capture ownership once, independently of whichever notebook is selected later. */
export function captureFileBrowserContext(
  filePath: string | null,
  scopePath: string | null = null,
  folderPath: string | null = null,
): FileBrowserContext {
  const notebookId = getSelectedWorkspaceNotebookId();
  return resolveFileBrowserContext(filePath, {
    notebookId, folderPath, scopePath,
    fileTreeVisible: true,
    fileTreeWidth: 220,
  });
}
