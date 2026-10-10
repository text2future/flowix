import type { AgentTypeKey, StatusInfo, UsageInfo } from "@/types/agent";
import type { I18nKey } from "@/lib/i18n";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import { selectAgentThreadCardRunStatus } from "@features/agent/thread-card/agent-thread-card-selectors";

/**
 * The compact subset of runtime state required by the agent badge hover card.
 * Both an embedded ThreadState and the standalone conversation projection
 * expose this shape, so the two fullscreen conversation surfaces can render
 * the same metadata without copying the presentation rules.
 */
export interface AgentThreadCardBadgeRuntimeState {
  lastRun?: ThreadState["lastRun"];
  activeRunId: string | null;
  runs: ThreadState["runs"];
}

export interface AgentThreadCardBadgeData {
  model: string | undefined;
  /** Full nested token usage breakdown — see [`UsageInfo`]. */
  usage?: UsageInfo;
  /** Provider-specific status snapshot — see [`StatusInfo`]. */
  statusInfo?: StatusInfo;
}

export function computeAgentThreadCardBadgeData(options: {
  threadState: AgentThreadCardBadgeRuntimeState | undefined;
  codexModel: string | undefined;
  typeKey: AgentTypeKey;
}): AgentThreadCardBadgeData {
  const { threadState, codexModel, typeKey } = options;
  let model: string | undefined;
  let usage: UsageInfo | undefined;
  let statusInfo: StatusInfo | undefined;

  const snapshot = threadState?.lastRun;
  if (snapshot) {
    if (!model && (snapshot.modelId || snapshot.model)) {
      model = snapshot.modelId ?? snapshot.model;
    }
    if (!usage && snapshot.usage) {
      usage = snapshot.usage;
    }
    if (!statusInfo && snapshot.statusInfo) statusInfo = snapshot.statusInfo;
  }

  if (!snapshot && threadState?.activeRunId && threadState.runs[threadState.activeRunId]) {
    const run = threadState.runs[threadState.activeRunId];
    if (!model && (run.modelId || run.model)) {
      model = run.modelId ?? run.model;
    }
    if (!usage && run.usage) usage = run.usage;
    if (!statusInfo && run.statusInfo) statusInfo = run.statusInfo;
  }

  if (!snapshot) {
    const runs = Object.values(threadState?.runs ?? {});
    if (runs.length > 0) {
      const latest = runs.reduce((acc, run) =>
        run.startedAt > acc.startedAt ? run : acc,
      );
      if (!model && (latest.modelId || latest.model)) {
        model = latest.modelId ?? latest.model;
      }
      if (!usage && latest.usage) usage = latest.usage;
      if (!statusInfo && latest.statusInfo) statusInfo = latest.statusInfo;
    }
  }

  if (!model && typeKey === "codex" && codexModel && codexModel !== "inherit") {
    model = codexModel;
  }

  return { model, usage, statusInfo };
}

export function renderAgentThreadCardMetaState(options: {
  dom: HTMLElement;
  metaEl: HTMLElement;
  runStatusEl: HTMLSpanElement;
  state: ThreadState | undefined;
  isCreating: boolean;
  isLoading: boolean;
  typeKey: AgentTypeKey;
  t: (key: I18nKey) => string;
}): void {
  const { dom, metaEl, runStatusEl, state, isCreating, isLoading, typeKey, t } =
    options;
  const statusView = selectAgentThreadCardRunStatus({
    state,
    isCreating,
    isLoading,
    typeKey,
  });
  const label = statusView.shouldShowStatus
    ? statusView.status === "stopping"
      ? t("editor.threadCard.stopping")
      : statusView.status === "running"
      ? t("editor.threadCard.running")
      : statusView.status === "failed"
        ? t("editor.threadCard.failed")
        : statusView.status === "cancelled"
          ? t("editor.threadCard.cancelled")
          : ""
    : "";

  dom.classList.toggle(
    "agent-thread-card--running",
    statusView.status === "running" || statusView.status === "stopping",
  );
  runStatusEl.textContent = label;
  runStatusEl.hidden = !statusView.shouldShowStatus;
  runStatusEl.className = `agent-thread-card__run-status agent-thread-card__run-status--${statusView.statusClass}`;
  if (statusView.latestRun?.runId) {
    runStatusEl.title = `Run: ${statusView.latestRun.runId}`;
  } else {
    runStatusEl.removeAttribute("title");
  }

  metaEl.replaceChildren(runStatusEl);
}
