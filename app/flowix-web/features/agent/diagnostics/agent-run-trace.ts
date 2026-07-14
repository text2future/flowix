import type { AgentChunk, AgentEvent, AgentTypeKey } from '@/types/agent';

const DIAGNOSTICS_STORAGE_KEY = 'flowix.agent.diagnostics';
const MAX_TRACE_RECORDS = 500;

type AgentRunTraceRecord =
  | {
    kind: 'chunk_mapped';
    at: number;
    threadId: string;
    runId: string;
    agentType: AgentTypeKey;
    chunk: AgentChunk;
    event: AgentEvent;
  }
  | {
    kind: 'lifecycle_event';
    at: number;
    threadId: string;
    runId: string;
    agentType: AgentTypeKey;
    eventKind: AgentEvent['kind'];
    activeRunId: string | null;
    isLoading: boolean;
  }
  | {
    kind: 'stop_requested';
    at: number;
    threadId: string;
    runId: string | null;
    agentType: AgentTypeKey;
  };

const traceRecords: AgentRunTraceRecord[] = [];

function isDiagnosticsEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' &&
      localStorage.getItem(DIAGNOSTICS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function pushTraceRecord(record: AgentRunTraceRecord): void {
  if (!isDiagnosticsEnabled()) return;
  traceRecords.push(record);
  if (traceRecords.length > MAX_TRACE_RECORDS) {
    traceRecords.splice(0, traceRecords.length - MAX_TRACE_RECORDS);
  }
}

export function recordAgentChunkMapped(chunk: AgentChunk, event: AgentEvent): void {
  pushTraceRecord({
    kind: 'chunk_mapped',
    at: Date.now(),
    threadId: event.threadId,
    runId: event.runId,
    agentType: event.agentType,
    chunk,
    event,
  });
}

export function recordAgentLifecycleEvent(
  event: AgentEvent,
  snapshot: { activeRunId: string | null; isLoading: boolean }
): void {
  pushTraceRecord({
    kind: 'lifecycle_event',
    at: Date.now(),
    threadId: event.threadId,
    runId: event.runId,
    agentType: event.agentType,
    eventKind: event.kind,
    activeRunId: snapshot.activeRunId,
    isLoading: snapshot.isLoading,
  });
}

export function recordAgentStopRequested(
  threadId: string,
  runId: string | null,
  agentType: AgentTypeKey
): void {
  pushTraceRecord({
    kind: 'stop_requested',
    at: Date.now(),
    threadId,
    runId,
    agentType,
  });
}

export function getAgentRunTraceRecords(): AgentRunTraceRecord[] {
  return [...traceRecords];
}

export function clearAgentRunTraceRecords(): void {
  traceRecords.length = 0;
}

export function exportAgentRunTrace(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    records: traceRecords,
  }, null, 2);
}
