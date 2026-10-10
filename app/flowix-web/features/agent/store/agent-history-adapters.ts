import type { ChatMessage, ThreadListItem } from "@/types";
import type { PiHistoryRevision, AgentTypeKey } from "@/types/agent";
import { agentClient } from "@features/agent/store/agent-client";
import { parsePiHistoryMessages } from "@features/agent/runtime/pi-history";

export interface ThreadHistoryPage {
  messages: ChatMessage[];
  /** Absence of a stronger native proof always means a partial page. */
  coverage?: HistoryCoverage;
  confirmedMessageIds?: string[];
  /** Adapter-owned cursor; callers must return it unchanged. */
  nextCursor?: string;
  oldestSequence: number | null;
  hasMore: boolean;
  /** Pins subsequent pages to the same provider/journal snapshot when supported. */
  snapshotSequence?: number | null;
  piRevision?: PiHistoryRevision;
  piBeforeEntryId?: string | null;
}

export type HistoryCoverage =
  | { kind: "partial" }
  | { kind: "complete-turns"; turnIds: string[] }
  | { kind: "branch-snapshot"; branchId: string; complete: true };

interface HistoryCursorPayload {
  version: 1;
  runtime: AgentTypeKey;
  threadId: string;
  beforeSequence: number | null;
  snapshotSequence?: number | null;
  piRevision?: PiHistoryRevision;
  piBeforeEntryId?: string | null;
}

export class HistoryChangedError extends Error {
  constructor() {
    super("History changed during pagination");
    this.name = "HistoryChangedError";
  }
}

export function attachHistoryCursor(
  runtime: AgentTypeKey,
  threadId: string,
  page: ThreadHistoryPage,
): ThreadHistoryPage {
  if (!page.hasMore) return { ...page, coverage: page.coverage ?? { kind: "partial" }, nextCursor: undefined };
  if (runtime === "pi" ? !page.piBeforeEntryId || !page.piRevision : page.oldestSequence === null) {
    throw new Error("History page has more data but no usable cursor");
  }
  const payload: HistoryCursorPayload = {
    version: 1, runtime, threadId,
    beforeSequence: page.oldestSequence,
    snapshotSequence: page.snapshotSequence,
    piRevision: page.piRevision,
    piBeforeEntryId: page.piBeforeEntryId,
  };
  return { ...page, coverage: page.coverage ?? { kind: "partial" }, nextCursor: encodeURIComponent(JSON.stringify(payload)) };
}

export async function readHistoryPageWithCursor(
  runtime: AgentTypeKey,
  threadId: string,
  cursor: string,
  limit: number,
  adapter: AgentHistoryAdapter = getAgentHistoryAdapter(runtime),
): Promise<ThreadHistoryPage> {
  let payload: HistoryCursorPayload;
  try {
    payload = JSON.parse(decodeURIComponent(cursor)) as HistoryCursorPayload;
  } catch {
    throw new Error("History cursor is invalid");
  }
  if (payload.version !== 1 || payload.runtime !== runtime || payload.threadId !== threadId) {
    throw new Error("History cursor belongs to another runtime or thread");
  }
  if (runtime === "pi" ? !payload.piBeforeEntryId || !payload.piRevision : typeof payload.beforeSequence !== "number") {
    throw new Error("History cursor is incomplete");
  }
  const page = await adapter.getPage(
    threadId, payload.beforeSequence, limit, payload.snapshotSequence,
    payload.piRevision, payload.piBeforeEntryId,
  );
  if (payload.snapshotSequence != null && page.snapshotSequence !== payload.snapshotSequence) {
    throw new HistoryChangedError();
  }
  if (runtime === "pi" && JSON.stringify(payload.piRevision) !== JSON.stringify(page.piRevision)) {
    throw new HistoryChangedError();
  }
  const next = attachHistoryCursor(runtime, threadId, page);
  if (runtime !== "pi" && page.hasMore && page.oldestSequence != null &&
    payload.beforeSequence != null && page.oldestSequence >= payload.beforeSequence) {
    throw new Error("History cursor did not move toward older messages");
  }
  if (next.nextCursor === cursor || (next.hasMore && next.messages.length === 0)) {
    throw new Error("History cursor made no progress");
  }
  return next;
}

export interface AgentHistoryAdapter {
  readonly typeKey: AgentTypeKey;
  readonly externalSessionBacked?: boolean;
  listThreads(): Promise<ThreadListItem[]>;
  getInitialHistory(threadId: string, limit: number): Promise<ThreadHistoryPage>;
  getFullHistory(threadId: string): Promise<ChatMessage[]>;
  getPage(
    threadId: string,
    beforeSequence: number | null,
    limit: number,
    snapshotSequence?: number | null,
    piRevision?: PiHistoryRevision,
    piBeforeEntryId?: string | null,
  ): Promise<ThreadHistoryPage>;
}

async function readAllHistoryPages(
  runtime: AgentTypeKey,
  threadId: string,
  limit = 50,
): Promise<ChatMessage[]> {
  const startedAt = Date.now();
  const adapter = getAgentHistoryAdapter(runtime);
  const seen = new Set<string>();
  let page = attachHistoryCursor(runtime, threadId, await adapter.getInitialHistory(threadId, limit));
  let messages = page.messages;
  let pageCount = 1;
  while (page.hasMore) {
    const cursor = page.nextCursor;
    if (!cursor || seen.has(cursor) || page.messages.length === 0) {
      throw new Error("History cursor made no progress");
    }
    if (pageCount >= 1000 || Date.now() - startedAt > 30_000) {
      throw new Error("History read incomplete: page or time budget exceeded");
    }
    seen.add(cursor);
    page = await readHistoryPageWithCursor(runtime, threadId, cursor, limit, adapter);
    messages = [...page.messages, ...messages];
    pageCount += 1;
  }
  return messages;
}

function createCodexHistoryAdapter(): AgentHistoryAdapter {
  const readPage = async (
    threadId: string, beforeSequence: number | null, limit: number,
    snapshotSequence?: number | null,
  ): Promise<ThreadHistoryPage> => {
    const page = snapshotSequence == null
      ? await agentClient.getCodexThreadPage(threadId, beforeSequence, limit)
      : await agentClient.getCodexThreadPage(threadId, beforeSequence, limit, snapshotSequence);
    const turnIds = page.completeTurnIds?.filter((id) => id.length > 0) ?? [];
    return {
      ...page,
      coverage: turnIds.length > 0 ? { kind: "complete-turns", turnIds } : { kind: "partial" },
    };
  };
  return {
    typeKey: "codex",
    externalSessionBacked: true,
    listThreads: () => agentClient.listCodexThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getCodexThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) => readPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      readPage(threadId, beforeSequence, limit, snapshotSequence),
  };
}

function createClaudeHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "claude",
    externalSessionBacked: true,
    listThreads: () => agentClient.listClaudeThreads(),
    async getFullHistory(threadId) {
      return readAllHistoryPages("claude", threadId);
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getClaudeThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      agentClient.getClaudeThreadPage(
        threadId,
        beforeSequence,
        limit,
        snapshotSequence,
      ),
  };
}

function createHermesHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "hermes",
    externalSessionBacked: true,
    listThreads: () => agentClient.listHermesThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getHermesThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getHermesThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      agentClient.getHermesThreadPage(
        threadId,
        beforeSequence,
        limit,
        snapshotSequence,
      ),
  };
}

function createLocalAgentHistoryAdapter(typeKey: AgentTypeKey): AgentHistoryAdapter {
  return {
    typeKey,
    listThreads: () => agentClient.listLocalAgentThreads(typeKey),
    async getFullHistory(threadId) {
      return (await agentClient.getThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getThreadPage(threadId, beforeSequence, limit),
  };
}

function createOpenCodeHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "opencode",
    externalSessionBacked: true,
    listThreads: () => agentClient.listOpenCodeThreads(),
    async getFullHistory(threadId) {
      return readAllHistoryPages("opencode", threadId);
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getOpenCodeThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      agentClient.getOpenCodeThreadPage(
        threadId,
        beforeSequence,
        limit,
        snapshotSequence,
      ),
  };
}

function createPiHistoryAdapter(): AgentHistoryAdapter {
  const readPage = async (threadId: string, before: string | null, limit: number, revision?: PiHistoryRevision): Promise<ThreadHistoryPage> => {
    let page;
    try {
      page = await agentClient.getPiSessionPage(threadId, before, limit, revision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("HistoryChanged:pi_branch")) {
        throw new HistoryChangedError();
      }
      throw error;
    }
    return {
      messages: parsePiHistoryMessages(threadId, page.messages), oldestSequence: page.oldestSequence,
      snapshotSequence: page.snapshotSequence, hasMore: page.hasMore,
      piRevision: page.revision, piBeforeEntryId: page.beforeEntryId,
    };
  };
  return {
    typeKey: "pi",
    externalSessionBacked: true,
    listThreads: () => agentClient.listPiThreads(),
    async getFullHistory(threadId) {
      return readAllHistoryPages("pi", threadId, 100);
    },
    getInitialHistory: (threadId, limit) => readPage(threadId, null, limit),
    getPage(threadId, beforeSequence, limit, _snapshotSequence, revision, beforeEntryId) {
      if (beforeSequence !== null && (!beforeEntryId || !revision)) {
        return Promise.reject(new Error("Pi history pagination requires its native cursor and revision"));
      }
      return readPage(threadId, beforeEntryId ?? null, limit, revision);
    },
  };
}

function createDeepSeekHarnessHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "deepseek-harness",
    externalSessionBacked: true,
    listThreads: () => agentClient.listDeepSeekHarnessThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getDeepSeekHarnessThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getDeepSeekHarnessThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit, snapshotSequence) =>
      agentClient.getDeepSeekHarnessThreadPage(
        threadId,
        beforeSequence,
        limit,
        snapshotSequence,
      ),
  };
}

const historyAdapters: Partial<Record<AgentTypeKey, AgentHistoryAdapter>> = {
  // Codex history is projected by the backend from Codex App Server threads.
  codex: createCodexHistoryAdapter(),
  pi: createPiHistoryAdapter(),
  claude: createClaudeHistoryAdapter(),
  hermes: createHermesHistoryAdapter(),
  // OpenCode reads its provider session through the ACP session/load path.
  opencode: createOpenCodeHistoryAdapter(),
  "deepseek-harness": createDeepSeekHarnessHistoryAdapter(),
};

export function getAgentHistoryAdapter(typeKey: AgentTypeKey): AgentHistoryAdapter {
  return historyAdapters[typeKey] ?? createLocalAgentHistoryAdapter(typeKey);
}
