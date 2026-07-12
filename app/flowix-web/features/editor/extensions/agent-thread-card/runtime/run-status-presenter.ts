import type { AgentTypeKey, StatusInfo, UsageInfo } from "@/types/agent";
import type { I18nKey } from "@features/i18n";
import type { ThreadState } from "@features/agent/store/chat-store";
import type { AgentConversationRun } from "@features/agent/store/agent-conversation-store";
import { selectAgentThreadCardRunStatus } from "@features/editor/extensions/agent-thread-card/agent-thread-card-selectors";

export interface AgentThreadCardBadgeData {
  model: string | undefined;
  lastRunAt: number | undefined;
  totalTokens: number | undefined;
  /** Full nested token usage breakdown — see [`UsageInfo`]. */
  usage?: UsageInfo;
  /** Provider-specific status snapshot — see [`StatusInfo`]. */
  statusInfo?: StatusInfo;
}

export function getConversationRunLastRunAt(
  run: AgentConversationRun,
): number | undefined {
  return run.lastRunAt ?? run.endedAt ?? run.startedAt;
}

export function computeAgentThreadCardBadgeData(options: {
  threadState: ThreadState | undefined;
  persistedRun: AgentConversationRun | undefined;
  codexModel: string | undefined;
  typeKey: AgentTypeKey;
}): AgentThreadCardBadgeData {
  const { threadState, persistedRun, codexModel, typeKey } = options;
  let model: string | undefined;
  let lastRunAt: number | undefined;
  let totalTokens: number | undefined;
  let usage: UsageInfo | undefined;
  let statusInfo: StatusInfo | undefined;

  const snapshot = threadState?.lastRun;
  if (snapshot) {
    if (snapshot.model) model = snapshot.model;
    if (snapshot.status !== "running" && snapshot.usage) {
      totalTokens = snapshot.usage.total_tokens ?? undefined;
      usage = snapshot.usage;
    }
    if (snapshot.statusInfo) statusInfo = snapshot.statusInfo;
    lastRunAt = snapshot.lastRunAt ?? snapshot.endedAt ?? snapshot.startedAt;
  }

  if (!snapshot && threadState?.activeRunId && threadState.runs[threadState.activeRunId]) {
    const run = threadState.runs[threadState.activeRunId];
    if (run.model) model = run.model;
    if (run.status !== "running" && run.usage) {
      totalTokens = run.usage.total_tokens ?? undefined;
      usage = run.usage;
    }
    if (run.statusInfo) statusInfo = run.statusInfo;
    lastRunAt = run.lastRunAt ?? run.endedAt ?? run.startedAt;
  }

  if (!snapshot && lastRunAt === undefined) {
    const runs = Object.values(threadState?.runs ?? {});
    if (runs.length > 0) {
      const latest = runs.reduce((acc, run) =>
        run.startedAt > acc.startedAt ? run : acc,
      );
      if (latest.model) model = latest.model;
      if (latest.status !== "running" && latest.usage) {
        totalTokens = latest.usage.total_tokens ?? undefined;
        usage = latest.usage;
      }
      if (latest.statusInfo) statusInfo = latest.statusInfo;
      lastRunAt = latest.lastRunAt ?? latest.endedAt ?? latest.startedAt;
    }
  }

  if (persistedRun) {
    if (!model && persistedRun.model) model = persistedRun.model;
    if (totalTokens === undefined && persistedRun.usage?.total_tokens != null) {
      totalTokens = persistedRun.usage.total_tokens;
    }
    if (!usage && persistedRun.usage) usage = persistedRun.usage;
    if (!statusInfo && persistedRun.statusInfo) statusInfo = persistedRun.statusInfo;
    if (lastRunAt === undefined) {
      lastRunAt = getConversationRunLastRunAt(persistedRun);
    }
  }

  if (!model && typeKey === "codex" && codexModel && codexModel !== "inherit") {
    model = codexModel;
  }

  return { model, lastRunAt, totalTokens, usage, statusInfo };
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
    ? statusView.status === "running"
      ? statusView.supportsStreaming
        ? t("editor.threadCard.running")
        : t("editor.threadCard.running")
      : statusView.status === "failed"
        ? "失败"
        : statusView.status === "cancelled"
          ? "已取消"
          : ""
    : "";

  dom.classList.toggle(
    "agent-thread-card--running",
    statusView.status === "running",
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
