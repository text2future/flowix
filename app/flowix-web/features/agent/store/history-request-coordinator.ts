import type { AgentTypeKey } from "@/types/agent";

export interface HistoryBinding {
  providerSessionId?: string;
  agentType?: AgentTypeKey;
}

export interface HistoryRequest {
  threadId: string;
  version: number;
  epoch: number;
  binding: HistoryBinding;
}

interface HistoryRequestState {
  binding(threadId: string): HistoryBinding;
  epoch(threadId: string): number;
  isDeleted(threadId: string): boolean;
}

interface InitialRead {
  requestedAgentType: AgentTypeKey;
  binding: HistoryBinding;
}

/** Local request bookkeeping. None of these values is conversation state. */
export function createHistoryRequestCoordinator(state: HistoryRequestState) {
  const versions = new Map<string, number>();
  const initialReads = new Map<string, InitialRead>();
  const codexReconciles = new Map<string, Map<string, Promise<void>>>();

  return {
    binding(threadId: string): HistoryBinding {
      return state.binding(threadId);
    },
    begin(threadId: string): HistoryRequest {
      const version = (versions.get(threadId) ?? 0) + 1;
      versions.set(threadId, version);
      return { threadId, version, epoch: state.epoch(threadId), binding: state.binding(threadId) };
    },
    isCurrent(request: HistoryRequest): boolean {
      const binding = state.binding(request.threadId);
      return !state.isDeleted(request.threadId) &&
        versions.get(request.threadId) === request.version &&
        state.epoch(request.threadId) === request.epoch &&
        binding.providerSessionId === request.binding.providerSessionId &&
        binding.agentType === request.binding.agentType;
    },
    isLatest(request: HistoryRequest): boolean {
      return versions.get(request.threadId) === request.version;
    },
    hasInitial(threadId: string, requestedAgentType: AgentTypeKey, binding: HistoryBinding): boolean {
      const pending = initialReads.get(threadId);
      return pending?.requestedAgentType === requestedAgentType &&
        pending.binding.providerSessionId === binding.providerSessionId &&
        pending.binding.agentType === binding.agentType;
    },
    startInitial(threadId: string, requestedAgentType: AgentTypeKey, binding: HistoryBinding): void {
      initialReads.set(threadId, { requestedAgentType, binding });
    },
    finishInitial(request: HistoryRequest): void {
      if (versions.get(request.threadId) === request.version) initialReads.delete(request.threadId);
    },
    reconcileCodex(threadId: string, runId: string, execute: () => Promise<void>): Promise<void> {
      const pending = codexReconciles.get(threadId) ?? new Map<string, Promise<void>>();
      const duplicate = pending.get(runId);
      if (duplicate) return duplicate;
      const previous = [...pending.values()].pop();
      // A later run must read history after the preceding reconciliation, not
      // borrow its result or invalidate its request while it is in flight.
      const promise = previous
        ? previous.then(execute, execute)
        : execute();
      pending.set(runId, promise);
      codexReconciles.set(threadId, pending);
      void promise.finally(() => {
        pending.delete(runId);
        if (pending.size === 0) codexReconciles.delete(threadId);
      }).catch(() => undefined);
      return promise;
    },
  };
}
