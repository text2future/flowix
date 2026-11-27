import { canonicalPath } from '@/lib/path';
import type { WorkspaceSession } from '@features/workspace/public/session-api';

type Navigation = WorkspaceSession['navigation'];

/** A completed run may navigate only if its original workbench was never superseded. */
export function canOpenPluginRunResult(initial: Navigation, current: Navigation, pluginId: string,
  notebookPath: string, currentNotebookPath: string | null | undefined): boolean {
  const entry = current.current;
  return initial.transaction.phase === 'committed'
    && current.transaction.phase === 'committed'
    && initial.transaction.requestId === current.transaction.requestId
    && Boolean(initial.current?.id && entry?.id === initial.current.id
      && entry.target.kind === 'plugin-workbench' && entry.target.plugin.manifest.id === pluginId
      && currentNotebookPath && canonicalPath(currentNotebookPath) === canonicalPath(notebookPath));
}
