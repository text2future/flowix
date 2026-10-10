import type { AgentRunState } from "@/types/agent";
import type { ThreadProjection } from "@features/agent/store/session-reducer";

/** Update only the run that still owns this projection. */
export function withRunPhase(
  projection: ThreadProjection,
  runId: string,
  phase: AgentRunState["phase"],
  expectedPhase?: AgentRunState["phase"],
): ThreadProjection {
  const run = projection.runs.runs[runId];
  if (!run || projection.runs.activeRunId !== runId ||
    (expectedPhase !== undefined && run.phase !== expectedPhase) || run.phase === phase) return projection;
  return {
    ...projection,
    runs: {
      ...projection.runs,
      runs: { ...projection.runs.runs, [runId]: { ...run, phase } },
    },
  };
}
