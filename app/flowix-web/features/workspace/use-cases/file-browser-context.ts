import { useMemoStore } from '@features/memo/store';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { resolveNotebookAgentFiles } from '@/lib/agent-access-defaults';
import { resolveFileBrowserRoot, type FileBrowserContext } from '../store/file-browser-target';

/** Capture ownership once, independently of whichever notebook is selected later. */
export function captureFileBrowserContext(
  filePath: string | null,
  scopePath: string | null = null,
  folderPath: string | null = null,
): FileBrowserContext {
  const notebook = useMemoStore.getState();
  const notebookId = notebook.selectedNotebookId ?? notebook.selectedNotebook?.id ?? null;
  const accessState = useAgentAccessStore.getState();
  const defaults = resolveNotebookAgentFiles(accessState.config, accessState.notebookConfigs, notebookId);
  const resourceRoot = resolveFileBrowserRoot(filePath, defaults?.folders ?? []);
  return {
    notebookId, folderPath, scopePath: scopePath ?? resourceRoot,
    fileTreeVisible: true, fileTreeWidth: 220,
  };
}
