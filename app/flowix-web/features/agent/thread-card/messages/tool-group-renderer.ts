import { translate, type AppLanguage } from "@/lib/i18n";
import {
  createAgentThreadCardMessageElement,
  disposeAgentThreadCardMessageTree,
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

const TOOL_ROW_TRANSITION_MS = 180;
const MIN_TOOL_ROW_VISIBLE_MS = 300;

interface RunningToolRow {
  message: AgentMessage;
  element: HTMLElement;
  animation: Animation | null;
  exitTimer: number | null;
  shownAt: number;
  exiting: boolean;
}

function animateToolRow(element: HTMLElement, entering: boolean): Animation | null {
  if (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    typeof element.animate !== "function"
  ) return null;

  const height = element.getBoundingClientRect().height;
  if (height <= 0) return null;

  const full = {
    height: `${height}px`,
    paddingTop: "6px",
    paddingBottom: "6px",
    opacity: 1,
    transform: "translateY(0)",
  };
  const collapsed = {
    height: "0px",
    paddingTop: "0px",
    paddingBottom: "0px",
    opacity: 0,
    transform: "translateY(-4px)",
  };
  const animation = element.animate(
    entering ? [collapsed, full] : [full, collapsed],
    {
      duration: TOOL_ROW_TRANSITION_MS,
      easing: "ease-out",
      fill: "both",
    },
  );
  return animation;
}

function replaceChildrenWithCleanup(
  parent: HTMLElement,
  ...children: HTMLElement[]
): void {
  for (const child of Array.from(parent.children)) {
    disposeAgentThreadCardMessageTree(child);
  }
  parent.replaceChildren(...children);
}

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
    group.status === "running"
      ? completedCount > 0
        ? "agent.tools.runningSteps"
        : "agent.tools.processing"
      : group.status === "failed"
        // Failure is a hint, not an alarm: the label stays in the same quiet
        // register and only adds "some failed" to the step count.
        ? "agent.tools.finishedWithFailure"
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
  const runningToolRows = new Map<string, RunningToolRow>();

  const createRunningTool = (message: AgentMessage): HTMLElement | null => {
    const element = renderTool(message, currentContext);
    if (!element) return null;
    element.classList.add("agent-thread-card__tool-group-running-tool");
    const loadingIcon = createToolRunningLoadingIcon();
    loadingIcon.setAttribute("aria-hidden", "true");
    // Keep the spinner on the same 18px alignment track as the tool icon and
    // first text line. The SVG itself is intentionally 12px, so inserting it
    // directly into the flex row makes it sit higher than the other items.
    const loadingIconWrap = document.createElement("span");
    loadingIconWrap.className =
      "agent-thread-card__tool-group-running-loading-wrap";
    loadingIconWrap.append(loadingIcon);
    const toolName = element.querySelector(
      ".agent-thread-card__message-tool-name",
    );
    if (toolName) toolName.before(loadingIconWrap);
    else element.prepend(loadingIconWrap);
    return element;
  };

  const syncCompletedTools = () => {
    const visibleTools = (expanded ? currentGroup.completedTools : [])
      .filter((tool) => !runningToolRows.has(tool.id));
    if (visibleTools.length === 0) {
      replaceChildrenWithCleanup(completedTools);
      return;
    }
    const renderedTools = visibleTools
      .map((tool) => renderTool(tool, currentContext))
      .filter((element): element is HTMLElement => element !== null);
    replaceChildrenWithCleanup(completedTools, ...renderedTools);
  };

  const removeRunningToolRow = (id: string, row: RunningToolRow) => {
    if (row.exitTimer !== null) window.clearTimeout(row.exitTimer);
    row.exitTimer = null;
    row.element.remove();
    disposeAgentThreadCardMessageTree(row.element);
    if (runningToolRows.get(id) === row) runningToolRows.delete(id);
    syncCompletedTools();
  };

  const startRowAnimation = (
    id: string,
    row: RunningToolRow,
    entering: boolean,
  ) => {
    const animation = animateToolRow(row.element, entering);
    row.animation = animation;
    if (!animation) {
      if (!entering) removeRunningToolRow(id, row);
      return;
    }
    animation.onfinish = () => {
      if (
        row.animation !== animation ||
        (entering && row.exiting) ||
        (!entering && !row.exiting)
      ) return;
      row.animation = null;
      animation.cancel();
      if (!entering) removeRunningToolRow(id, row);
    };
  };

  const startToolRowExit = (id: string, row: RunningToolRow) => {
    row.element.setAttribute("aria-hidden", "true");
    row.element.inert = true;
    startRowAnimation(id, row, false);
  };

  const syncRunningTools = () => {
    const visibleIds = new Set<string>();

    for (const message of currentGroup.runningTools) {
      visibleIds.add(message.id);
      const row = runningToolRows.get(message.id);
      if (!row) {
        const element = createRunningTool(message);
        if (!element) continue;
        const newRow = {
          message,
          element,
          animation: null,
          exitTimer: null,
          shownAt: Date.now(),
          exiting: false,
        };
        runningToolRows.set(message.id, newRow);
        runningTools.append(element);
        startRowAnimation(message.id, newRow, true);
        continue;
      }

      if (row.exiting) {
        if (row.exitTimer !== null) window.clearTimeout(row.exitTimer);
        row.exitTimer = null;
        row.animation?.cancel();
        row.animation = null;
        row.exiting = false;
        row.element.removeAttribute("aria-hidden");
        row.element.inert = false;
      }

      if (row.message !== message) {
        row.animation?.cancel();
        row.animation = null;
        const replacement = createRunningTool(message);
        if (replacement) {
          row.element.replaceWith(replacement);
          disposeAgentThreadCardMessageTree(row.element);
          row.element = replacement;
          row.message = message;
        }
      }
      // appendChild also moves existing rows into the latest tool order.
      runningTools.append(row.element);
    }

    for (const [id, row] of runningToolRows) {
      if (visibleIds.has(id) || row.exiting) continue;
      row.exiting = true;
      const remaining = Math.max(
        0,
        MIN_TOOL_ROW_VISIBLE_MS - (Date.now() - row.shownAt),
      );
      if (remaining === 0) {
        startToolRowExit(id, row);
      } else {
        row.exitTimer = window.setTimeout(() => {
          row.exitTimer = null;
          if (row.exiting) startToolRowExit(id, row);
        }, remaining);
      }
    }
  };

  const label = document.createElement("span");
  label.className = "agent-thread-card__tool-group-label";
  const headerLoadingIcon = createToolRunningLoadingIcon();
  headerLoadingIcon.classList.add(
    "agent-thread-card__tool-group-header-loading-icon",
  );
  headerLoadingIcon.setAttribute("aria-hidden", "true");

  const syncLabel = () => {
    label.textContent = getToolGroupLabel(currentGroup, currentContext.language);
    const duration = getToolGroupDurationMs(currentGroup);
    const formattedDuration = duration === null
      ? null
      : formatToolGroupDuration(duration);
    if (formattedDuration !== null) {
      label.append(document.createTextNode(` · ${formattedDuration}`));
    }
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
