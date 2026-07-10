import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAgentRunTraceRecords,
  exportAgentRunTrace,
  getAgentRunTraceRecords,
  recordAgentChunkMapped,
} from './agent-run-trace';

describe('agent run trace diagnostics', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAgentRunTraceRecords();
  });

  it('does not record when diagnostics are disabled', () => {
    recordAgentChunkMapped({
      kind: 'stream_start',
      thread_id: 'thread-1',
      run_id: 'run-1',
      agent_type: 'codex',
    }, {
      kind: 'stream_start',
      threadId: 'thread-1',
      runId: 'run-1',
      agentType: 'codex',
      timestamp: 1,
    });

    expect(getAgentRunTraceRecords()).toHaveLength(0);
  });

  it('records and exports mapped chunks when diagnostics are enabled', () => {
    localStorage.setItem('flowix.agent.diagnostics', '1');
    recordAgentChunkMapped({
      kind: 'stream_start',
      thread_id: 'thread-1',
      run_id: 'run-1',
      agent_type: 'codex',
    }, {
      kind: 'stream_start',
      threadId: 'thread-1',
      runId: 'run-1',
      agentType: 'codex',
      timestamp: 1,
    });

    expect(getAgentRunTraceRecords()).toHaveLength(1);
    expect(exportAgentRunTrace()).toContain('"kind": "chunk_mapped"');
    expect(exportAgentRunTrace()).toContain('"runId": "run-1"');
  });
});
