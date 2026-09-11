import type { FileBrowserContext } from './file-browser-target';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { PluginArtifactRendererId } from '@features/plugin/public/workspace-api';

/**
 * The stable target currently owned by the workColumn.
 *
 * Notebook and list selection are deliberately not part of this state. A
 * target can remain open while the surrounding library context changes.
 */
export type WorkColumnTarget =
  | { kind: 'empty' }
  | {
      kind: 'memo';
      memoId: string;
      path: string;
      notebookId: string | null;
      notebookPath: string | null;
      transitionId: number | null;
    }
  | {
      kind: 'external';
      fileBrowser?: FileBrowserContext;
      path: string;
      scopePath: string | null;
      transitionId: number | null;
    }
  /** A durable host-owned artifact referenced by a pointer memo. */
  | {
      kind: 'artifact';
      pointerMemoId: string;
      notebookId: string | null;
      notebookPath: string | null;
      pluginId: string | null;
      renderer: PluginArtifactRendererId | null;
    }
  | { kind: 'agent-conversation'; instanceId: string }
  /** View identity only. Plugin run state and artifacts live in host stores. */
  | { kind: 'plugin-workbench'; plugin: PluginDescriptor }
  | { kind: 'web'; url: string };

export const EMPTY_WORK_COLUMN_TARGET = { kind: 'empty' } as const satisfies WorkColumnTarget;

export type WorkColumnNavigationPhase = 'idle' | 'loading' | 'committed' | 'failed';

export interface WorkColumnNavigationFailure {
  code: 'navigation-failed' | 'navigation-stale';
  message: string;
  requestId: number;
  retryToken: string | null;
}

export interface WorkColumnNavigationState {
  /** The last successfully committed workColumn target. */
  phase: WorkColumnNavigationPhase;
  requestId: number;
  target: WorkColumnTarget;
  /** The target currently being attempted, if any. */
  pendingTarget: WorkColumnTarget | null;
  /** Target that was active when the current request began. */
  previousTarget: WorkColumnTarget | null;
  failure: WorkColumnNavigationFailure | null;
  retryToken: string | null;
}
