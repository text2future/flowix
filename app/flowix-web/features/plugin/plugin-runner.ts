import { plugins, type PluginArtifact } from '@platform/tauri/client';
import {
  ensurePluginRunStoreSubscription,
  usePluginRunStore,
} from './plugin-run-store';

export interface PluginRunRequest {
  pluginId: string;
  userPrompt: string;
  context: string;
  agentType: string;
  notebookPath: string;
  sourceNote?: string;
}

function waitForRun(runId: string): Promise<PluginArtifact> {
  return new Promise<PluginArtifact>((resolve, reject) => {
    let settled = false;
    let timeout: number | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      unsubscribe?.();
      callback();
    };

    const inspect = () => {
      const run = usePluginRunStore.getState().runs[runId];
      if (!run) return;
      if (run.status === 'failed') {
        finish(() => reject(new Error(run.error || 'Plugin generation failed')));
      } else if (run.status === 'cancelled') {
        finish(() => reject(new Error('Plugin generation cancelled')));
      } else if (run.status === 'completed') {
        const artifact = run.artifact;
        if (artifact) finish(() => resolve(artifact));
        else finish(() => reject(new Error('Plugin completed without an artifact')));
      }
    };

    unsubscribe = usePluginRunStore.subscribe(inspect);
    // Completion can arrive before the IPC call that returns runId unwinds.
    inspect();
    if (settled) return;
    timeout = window.setTimeout(() => {
      finish(() => {
        void plugins.runStop(runId);
        reject(new Error('Plugin generation timed out'));
      });
    }, 10 * 60 * 1000);
  });
}

/**
 * Start a run and wait by immutable runId. The run store, rather than a
 * mainColumn component, owns the event projection while a surface is mounted
 * or not.
 */
export async function runPlugin(request: PluginRunRequest): Promise<PluginArtifact> {
  await ensurePluginRunStoreSubscription();
  const started = await plugins.run(request);
  usePluginRunStore.getState().registerRunContext(
    started.runId,
    request.pluginId,
    { notebookPath: request.notebookPath, sourceNote: request.sourceNote },
  );
  return await waitForRun(started.runId);
}

export { ensurePluginRunStoreSubscription, isPluginRunning } from './plugin-run-store';
