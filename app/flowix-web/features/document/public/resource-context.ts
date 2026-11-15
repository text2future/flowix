import { getWorkspaceAgentRepositories } from '@features/agent/public/workspace-api';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { documentResourceRoots, resolveDocumentResourceContext } from '@/lib/document-resource-context';

export function getDocumentResourceSnapshot() {
  const notebooks = getWorkspaceMemoState().notebooks;
  const repositories = notebooks.flatMap(notebook => getWorkspaceAgentRepositories(notebook.id)
    .map(repository => ({ notebookId: notebook.id, path: repository.path })));
  return { notebooks, repositories, roots: documentResourceRoots(notebooks, repositories) };
}

export function getDocumentResourceContext(documentPath?: string) {
  return resolveDocumentResourceContext(documentPath, getDocumentResourceSnapshot().roots);
}
