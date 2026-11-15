import { getWorkspaceAgentRepositories } from "@features/agent/public/workspace-api";
import { useNoteStore } from "@features/memo/store/note-store";
import type { ComposerFolderReference } from "./composer-folder-controller";

/** Read the folders configured for the supplied notebook. */
export function getCurrentNotebookComposerFolders(
  notebookId: string | null | undefined = useNoteStore.getState().selectedNotebook?.id,
): readonly ComposerFolderReference[] {
  if (!notebookId) return [];

  return getWorkspaceAgentRepositories(notebookId).map((repository) => ({
    path: repository.path,
    name: repository.name,
  }));
}
