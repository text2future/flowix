export type MessageRenderPlanKind =
  | "hidden"
  | "noop"
  | "patch-last"
  | "append-tail"
  | "replace-empty"
  | "replace-all";

export interface MessageRenderPlanStats {
  total: number;
  hidden: number;
  noop: number;
  patchLast: number;
  appendTail: number;
  replaceEmpty: number;
  replaceAll: number;
  last: {
    kind: MessageRenderPlanKind;
    messageCount: number;
    at: number;
  } | null;
}

type GlobalWithMessageRenderStats = typeof globalThis & {
  __FLOWIX_AGENT_THREAD_CARD_MESSAGE_RENDER_STATS__?: MessageRenderPlanStats;
};

function createStats(): MessageRenderPlanStats {
  return {
    total: 0,
    hidden: 0,
    noop: 0,
    patchLast: 0,
    appendTail: 0,
    replaceEmpty: 0,
    replaceAll: 0,
    last: null,
  };
}

function getDevStats(): MessageRenderPlanStats | null {
  if (!import.meta.env.DEV) return null;
  const target = globalThis as GlobalWithMessageRenderStats;
  target.__FLOWIX_AGENT_THREAD_CARD_MESSAGE_RENDER_STATS__ ??= createStats();
  return target.__FLOWIX_AGENT_THREAD_CARD_MESSAGE_RENDER_STATS__;
}

export function recordMessageRenderPlan(
  kind: MessageRenderPlanKind,
  messageCount: number,
): void {
  const stats = getDevStats();
  if (!stats) return;

  stats.total += 1;
  if (kind === "hidden") stats.hidden += 1;
  else if (kind === "noop") stats.noop += 1;
  else if (kind === "patch-last") stats.patchLast += 1;
  else if (kind === "append-tail") stats.appendTail += 1;
  else if (kind === "replace-empty") stats.replaceEmpty += 1;
  else stats.replaceAll += 1;

  stats.last = {
    kind,
    messageCount,
    at: Date.now(),
  };
}
