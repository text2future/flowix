import { translate, type AppLanguage } from "@/lib/i18n";
import {
  createAgentThreadCardMessageElement,
} from "@features/agent/thread-card/messages/message-item-renderer";
import {
  isFailedToolMessage,
  type AgentRenderItem,
} from "@features/agent/thread-card/messages/tool-grouping";
import type {
  AgentMessage,
  AgentThreadCardMessageRenderContext,
} from "@features/agent/thread-card/messages/message-render-context";
import {
  createChevronIcon,
  createToolRunningLoadingIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";

type ToolGroup = Extract<AgentRenderItem, { kind: "tool-group" }>;

function parseEventTimestamp(
  event: Record<string, unknown> | undefined,
): number | null {
  if (!event) return null;
  for (const key of ["time", "timestamp", "createdAt"]) {
    const value = event[key];
    const timestamp =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function getToolGroupDurationMs(group: ToolGroup, now = Date.now()): number | null {
  const timings = [...group.completedTools, ...group.runningTools].map((tool) => {
    const displayTimestamp = Date.parse(tool.timestamp);
    const callTimestamp = parseEventTimestamp(tool.toolCall);
    const resultTimestamp = parseEventTimestamp(tool.toolResult);
    const hasTrustedTimestamp = tool.sourceTimestamp !== undefined;
    const start = callTimestamp ?? displayTimestamp;
    let end: number | null = resultTimestamp;

    if (end === null && group.status !== "running" && hasTrustedTimestamp && Number.isFinite(displayTimestamp)) {
      end = displayTimestamp;
    }
    return { start, end };
  });

  if (timings.length === 0 || timings.some(({ start, end }) =>
    !Number.isFinite(start) || (group.status !== "running" && end === null),
  )) return null;

  const start = Math.min(...timings.map(({ start }) => start));
  const end = group.status === "running"
    ? now
    : Math.max(...timings.map(({ end }) => end as number));
  return Math.max(0, end - start);
}

function formatToolGroupDuration(durationMs: number): string | null {
  // The product format has no millisecond representation. Do not turn a
  // real sub-second duration into the misleading label "0s".
  if (durationMs < 1000) return null;
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getToolGroupLabel(group: ToolGroup, language: AppLanguage): string {
  const completedCount = group.completedTools.filter(
    (tool) => !tool.isLoading && !isFailedToolMessage(tool),
  ).length;
  const key =
    group.status === "failed"
      ? "agent.tools.failedSteps"
      : "agent.tools.completedSteps";
  return translate(language, key, {
    count: group.status === "failed" ? group.totalCount : completedCount,
  });
}

function renderTool(
  tool: AgentMessage,
  context: AgentThreadCardMessageRenderContext,
): HTMLElement | null {
  const element = createAgentThreadCardMessageElement({
    message: tool,
    language: context.language,
    getReasoningCollapsed: context.getReasoningCollapsed,
    setReasoningCollapsed: context.setReasoningCollapsed,
    getDisplayExpanded: context.getDisplayExpanded,
    setDisplayExpanded: context.setDisplayExpanded,
    isStreaming: context.isStreaming(tool),
    showActions: false,
    canFork: false,
    onForkMessage: context.onForkMessage,
  })?.element ?? null;

  // A running tool is progress feedback, not an expandable detail row. Keep
  // this rule at the group renderer boundary so it applies consistently to
  // both the trailing running region and the expanded completed list.
  if (element && tool.isLoading) {
    element.querySelector<HTMLElement>(
      ".agent-thread-card__message-tool-toggle",
    )?.remove();
  }
  return element;
}

export function createToolGroupElement(options: {
  group: ToolGroup;
  context: AgentThreadCardMessageRenderContext;
}): HTMLElement {
  const { group, context } = options;
  const wrapper = document.createElement("div");
  wrapper.className = "agent-thread-card__tool-group";
  wrapper.dataset.toolGroupId = group.id;

  const header = document.createElement("button");
  header.type = "button";
  header.className = "agent-thread-card__tool-group-header";
  header.id = `${group.id}-header`;

  const completedTools = document.createElement("div");
  completedTools.className = "agent-thread-card__tool-group-completed-tools";
  completedTools.id = `${group.id}-completed`;
  completedTools.setAttribute("role", "region");
  completedTools.setAttribute("aria-labelledby", header.id);

  const runningTools = document.createElement("div");
  runningTools.className = "agent-thread-card__tool-group-running-tools";
  runningTools.id = `${group.id}-running`;
  runningTools.setAttribute("role", "region");
  runningTools.setAttribute("aria-live", "polite");
  runningTools.setAttribute("aria-labelledby", header.id);
  header.setAttribute("aria-controls", `${completedTools.id} ${runningTools.id}`);
  let currentGroup = group;
  let currentContext = context;
  let expanded = context.getToolGroupExpanded?.(group.id) ?? false;
  let durationTimer: number | null = null;

  const createRunningTool = (message: AgentMessage): HTMLElement | null => {
    const element = renderTool(message, currentContext);
    if (!element) return null;
    element.classList.add("agent-thread-card__tool-group-running-tool");
    const loadingIcon = createToolRunningLoadingIcon();
    loadingIcon.setAttribute("aria-hidden", "true");
    const toolName = element.querySelector(
      ".agent-thread-card__message-tool-name",
    );
    if (toolName) toolName.before(loadingIcon);
    else element.prepend(loadingIcon);
    return element;
  };

  const syncCompletedTools = () => {
    const visibleTools = expanded
      ? currentGroup.completedTools
      : currentGroup.completedTools.filter(isFailedToolMessage);
    if (visibleTools.length === 0) {
      completedTools.replaceChildren();
      return;
    }
    const renderedTools = visibleTools
      .map((tool) => renderTool(tool, currentContext))
      .filter((element): element is HTMLElement => element !== null);
    completedTools.replaceChildren(...renderedTools);
  };

  const syncRunningTools = () => {
    const renderedTools = currentGroup.runningTools
      .map(createRunningTool)
      .filter((element): element is HTMLElement => element !== null);
    runningTools.replaceChildren(...renderedTools);
  };

  const label = document.createElement("span");
  label.className = "agent-thread-card__tool-group-label";
  const headerLoadingIcon = createToolRunningLoadingIcon();
  headerLoadingIcon.classList.add(
    "agent-thread-card__tool-group-header-loading-icon",
  );
  headerLoadingIcon.setAttribute("aria-hidden", "true");

  const syncLabel = () => {
    const baseLabel = getToolGroupLabel(currentGroup, currentContext.language);
    const duration = getToolGroupDurationMs(currentGroup);
    const formattedDuration = duration === null
      ? null
      : formatToolGroupDuration(duration);
    label.textContent = formattedDuration === null
      ? baseLabel
      : `${baseLabel} · ${formattedDuration}`;
  };

  const syncDurationTimer = () => {
    if (durationTimer !== null) {
      window.clearInterval(durationTimer);
      durationTimer = null;
    }
    if (currentGroup.status !== "running") return;
    if (getToolGroupDurationMs(currentGroup) === null) return;
    durationTimer = window.setInterval(() => {
      if (!wrapper.isConnected) {
        if (durationTimer !== null) window.clearInterval(durationTimer);
        durationTimer = null;
        return;
      }
      syncLabel();
    }, 1000);
  };

  const applyExpanded = (nextExpanded: boolean) => {
    expanded = nextExpanded;
    wrapper.classList.toggle(
      "agent-thread-card__tool-group--expanded",
      nextExpanded,
    );
    wrapper.classList.remove(
      "agent-thread-card__tool-group--completed",
      "agent-thread-card__tool-group--running",
      "agent-thread-card__tool-group--failed",
    );
    wrapper.classList.add(`agent-thread-card__tool-group--${currentGroup.status}`);
    syncLabel();
    header.setAttribute("aria-expanded", String(nextExpanded));
    const toggle = document.createElement("span");
    toggle.className = "agent-thread-card__tool-group-toggle";
    toggle.append(createChevronIcon(nextExpanded ? "down" : "right"));
    header.replaceChildren(
      toggle,
      label,
    );
    if (currentGroup.status === "running") {
      header.append(headerLoadingIcon);
    }
    syncCompletedTools();
    syncRunningTools();
    syncDurationTimer();
  };

  header.addEventListener("click", (event) => {
    event.stopPropagation();
    const nextExpanded = !wrapper.classList.contains(
      "agent-thread-card__tool-group--expanded",
    );
    currentContext.setToolGroupExpanded?.(group.id, nextExpanded);
    applyExpanded(nextExpanded);
  });
  header.addEventListener("mousedown", (event) => event.stopPropagation());

  wrapper.append(header);
  wrapper.append(completedTools);
  wrapper.append(runningTools);
  applyExpanded(context.getToolGroupExpanded?.(group.id) ?? false);

  toolGroupUpdaters.set(wrapper, (nextGroup, nextContext) => {
    currentGroup = nextGroup;
    currentContext = nextContext;
    applyExpanded(expanded);
  });
  return wrapper;
}

type ToolGroupUpdater = (
  group: ToolGroup,
  context: AgentThreadCardMessageRenderContext,
) => void;

const toolGroupUpdaters = new WeakMap<HTMLElement, ToolGroupUpdater>();

export function updateToolGroupElement(
  element: HTMLElement,
  options: {
    group: ToolGroup;
    context: AgentThreadCardMessageRenderContext;
  },
): boolean {
  const update = toolGroupUpdaters.get(element);
  if (!update) return false;
  update(options.group, options.context);
  return true;
}
