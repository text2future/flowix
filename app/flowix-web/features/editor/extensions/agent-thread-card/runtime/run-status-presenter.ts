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
  conversationRun: AgentConversationRun | undefined;
  codexModel: string | undefined;
  typeKey: AgentTypeKey;
}): AgentThreadCardBadgeData {
  const { threadState, conversationRun, codexModel, typeKey } = options;
  let model: string | undefined;
  let lastRunAt: number | undefined;
  let totalTokens: number | undefined;
  let usage: UsageInfo | undefined;
  let statusInfo: StatusInfo | undefined;

  if (conversationRun) {
    if (conversationRun.model) model = conversationRun.model;
    if (conversationRun.usage?.total_tokens != null) {
      totalTokens = conversationRun.usage.total_tokens;
    }
    if (conversationRun.usage) usage = conversationRun.usage;
    if (conversationRun.statusInfo) statusInfo = conversationRun.statusInfo;
    lastRunAt = getConversationRunLastRunAt(conversationRun);
  }

  const snapshot = threadState?.lastRun;
  if (!conversationRun && snapshot) {
    if (!model && snapshot.model) model = snapshot.model;
    if (totalTokens === undefined && snapshot.status !== "running" && snapshot.usage) {
      totalTokens = snapshot.usage.total_tokens ?? undefined;
    }
    if (!usage && snapshot.status !== "running" && snapshot.usage) {
      usage = snapshot.usage;
    }
    if (!statusInfo && snapshot.statusInfo) statusInfo = snapshot.statusInfo;
    if (lastRunAt === undefined) {
      lastRunAt = snapshot.lastRunAt ?? snapshot.endedAt ?? snapshot.startedAt;
    }
  }

  if (!conversationRun && !snapshot && threadState?.activeRunId && threadState.runs[threadState.activeRunId]) {
    const run = threadState.runs[threadState.activeRunId];
    if (!model && run.model) model = run.model;
    if (totalTokens === undefined && run.status !== "running" && run.usage) {
      totalTokens = run.usage.total_tokens ?? undefined;
    }
    if (!usage && run.status !== "running" && run.usage) usage = run.usage;
    if (!statusInfo && run.statusInfo) statusInfo = run.statusInfo;
    if (lastRunAt === undefined) {
      lastRunAt = run.lastRunAt ?? run.endedAt ?? run.startedAt;
    }
  }

  if (!conversationRun && !snapshot && lastRunAt === undefined) {
    const runs = Object.values(threadState?.runs ?? {});
    if (runs.length > 0) {
      const latest = runs.reduce((acc, run) =>
        run.startedAt > acc.startedAt ? run : acc,
      );
      if (!model && latest.model) model = latest.model;
      if (totalTokens === undefined && latest.status !== "running" && latest.usage) {
        totalTokens = latest.usage.total_tokens ?? undefined;
      }
      if (!usage && latest.status !== "running" && latest.usage) usage = latest.usage;
      if (!statusInfo && latest.statusInfo) statusInfo = latest.statusInfo;
      if (lastRunAt === undefined) {
        lastRunAt = latest.lastRunAt ?? latest.endedAt ?? latest.startedAt;
      }
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
  conversationRun?: AgentConversationRun;
  isCreating: boolean;
  isLoading: boolean;
  typeKey: AgentTypeKey;
  t: (key: I18nKey) => string;
}): void {
  const { dom, metaEl, runStatusEl, state, conversationRun, isCreating, isLoading, typeKey, t } =
    options;
  const statusView = selectAgentThreadCardRunStatus({
    state,
    conversationRun,
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
