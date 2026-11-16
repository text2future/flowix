import { create } from 'zustand';
import type { PluginArtifact, PluginRunEvent } from '@platform/tauri/client';
import { listenToPluginRuns } from '@platform/tauri/client/plugin';
import { canonicalPath } from '@/lib/path';

export type PluginRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PluginRunRecord {
  runId: string;
  pluginId: string;
  notebookPath: string | null;
  sourceNote: string | null;
  status: PluginRunStatus;
  agentType: string;
  artifact: PluginArtifact | null;
  error: string | null;
  content: string | null;
  updatedAt: number;
}

export interface PluginRunContext {
  notebookPath: string;
  sourceNote?: string;
}

interface PluginRunStore {
  runs: Record<string, PluginRunRecord>;
  latestRunIdByContext: Record<string, string>;
  registerRunContext: (runId: string, pluginId: string, context: PluginRunContext) => void;
  ingestEvent: (event: PluginRunEvent) => void;
  getLatestForPlugin: (pluginId: string, notebookPath: string | null) => PluginRunRecord | null;
}

const MAX_UNREFERENCED_TERMINAL_RUNS = 50;

export function pluginRunContextKey(pluginId: string, notebookPath: string): string {
  return `${pluginId}\u0000${canonicalPath(notebookPath)}`;
}

function eventStatus(status: PluginRunEvent['status']): PluginRunStatus {
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'started':
    case 'text':
      return 'running';
    default:
      return 'running';
  }
}

export const usePluginRunStore = create<PluginRunStore>((set, get) => ({
  runs: {},
  latestRunIdByContext: {},
  registerRunContext: (runId, pluginId, context) => set((state) => {
    const previous = state.runs[runId];
    const notebookPath = canonicalPath(context.notebookPath);
    const next: PluginRunRecord = previous
      ? {
          ...previous,
          pluginId,
          notebookPath,
          sourceNote: context.sourceNote ?? previous.sourceNote,
          updatedAt: Date.now(),
        }
      : {
          runId,
          pluginId,
          notebookPath,
          sourceNote: context.sourceNote ?? null,
          status: 'queued',
          agentType: '',
          artifact: null,
          error: null,
          content: null,
          updatedAt: Date.now(),
        };
    return {
      runs: { ...state.runs, [runId]: next },
      latestRunIdByContext: {
        ...state.latestRunIdByContext,
        [pluginRunContextKey(pluginId, notebookPath)]: runId,
      },
    };
  }),
  ingestEvent: (event) => set((state) => {
    const previous = state.runs[event.runId];
    const isStarted = event.status === 'started';
    const next: PluginRunRecord = {
      runId: event.runId,
      pluginId: event.pluginId,
      notebookPath: previous?.notebookPath ?? null,
      sourceNote: previous?.sourceNote ?? null,
      status: eventStatus(event.status),
      agentType: event.agentType,
      artifact: event.artifact ?? (isStarted ? null : previous?.artifact ?? null),
      error: event.error ?? (isStarted ? null : previous?.error ?? null),
      content: event.content ?? (isStarted ? null : previous?.content ?? null),
      updatedAt: Date.now(),
    };
    const currentLatestRunId = next.notebookPath
      ? state.latestRunIdByContext[pluginRunContextKey(event.pluginId, next.notebookPath)]
      : undefined;
    const shouldPromote = !!next.notebookPath && (
      isStarted
      || currentLatestRunId === undefined
      || currentLatestRunId === event.runId
    );
    const latestRunIdByContext = shouldPromote
      ? {
          ...state.latestRunIdByContext,
          [pluginRunContextKey(event.pluginId, next.notebookPath!)]: event.runId,
        }
      : state.latestRunIdByContext;
    const runs = pruneRuns(
      { ...state.runs, [event.runId]: next },
      latestRunIdByContext,
    );
    return {
      runs,
      latestRunIdByContext,
    };
  }),
  getLatestForPlugin: (pluginId, notebookPath) => {
    if (!notebookPath) return null;
    const runId = get().latestRunIdByContext[pluginRunContextKey(pluginId, notebookPath)];
    return runId ? get().runs[runId] ?? null : null;
  },
}));

function pruneRuns(
  runs: Record<string, PluginRunRecord>,
  latestRunIdByContext: Record<string, string>,
): Record<string, PluginRunRecord> {
  const protectedRunIds = new Set(Object.values(latestRunIdByContext));
  const removable = Object.values(runs)
    .filter((run) => (
      (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')
      && !protectedRunIds.has(run.runId)
    ))
    .sort((left, right) => left.updatedAt - right.updatedAt);
  if (removable.length <= MAX_UNREFERENCED_TERMINAL_RUNS) return runs;

  const next = { ...runs };
  for (const run of removable.slice(0, removable.length - MAX_UNREFERENCED_TERMINAL_RUNS)) {
    delete next[run.runId];
  }
  return next;
}

let runEventReady: Promise<void> | null = null;

/** Keep run projections alive independently of whichever mainColumn surface is mounted. */
export function ensurePluginRunStoreSubscription(): Promise<void> {
  if (runEventReady) return runEventReady;
  let resolveReady: (() => void) | undefined;
  runEventReady = new Promise<void>((resolve) => { resolveReady = resolve; });
  listenToPluginRuns((event) => {
    usePluginRunStore.getState().ingestEvent(event);
  }, {
    onListenerReady: () => resolveReady?.(),
  });
  return runEventReady;
}

export function isPluginRunning(pluginId: string, notebookPath: string | null): boolean {
  const run = usePluginRunStore.getState().getLatestForPlugin(pluginId, notebookPath);
  return run?.status === 'queued' || run?.status === 'running';
}
