import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@/types/agent';
import {
  applyRunEnded,
  applyRunFailed,
  applyRunStarted,
  applyRunStopped,
  applyRunUsage,
  type RunLifecycleThreadState,
} from './run-lifecycle';

function emptyState(): RunLifecycleThreadState {
  return {
    isLoading: false,
    activeRunId: null,
    runs: {},
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

function startEvent(runId: string): Extract<AgentEvent, { kind: 'stream_start' }> {
  return {
    kind: 'stream_start',
    agentType: 'codex',
    threadId: 'thread-1',
    runId,
    timestamp: 100,
  };
}

function endEvent(runId: string, reason: string | null = null): Extract<AgentEvent, { kind: 'stream_end' }> {
  return {
    kind: 'stream_end',
    agentType: 'codex',
    threadId: 'thread-1',
    runId,
    timestamp: 100,
    reason,
  };
}

function errorEvent(runId: string, message = 'failed'): Extract<AgentEvent, { kind: 'error' }> {
  return {
    kind: 'error',
    agentType: 'codex',
    threadId: 'thread-1',
    runId,
    timestamp: 100,
    message,
  };
}

describe('run lifecycle reducer', () => {
  it('starts a run and marks it active', () => {
    const next = applyRunStarted(emptyState(), startEvent('run-1'));

    expect(next.isLoading).toBe(true);
    expect(next.activeRunId).toBe('run-1');
    expect(next.runs['run-1']).toMatchObject({
      runId: 'run-1',
      status: 'running',
      agentType: 'codex',
    });
  });

  it('removes a normally completed active run', () => {
    const running = applyRunStarted(emptyState(), startEvent('run-1'));
    const ended = applyRunEnded(running, {
      ...endEvent('run-1'),
      reason: null,
    });

    expect(ended.isLoading).toBe(false);
    expect(ended.activeRunId).toBeNull();
    expect(ended.runs['run-1']).toBeUndefined();
  });

  it('keeps a newer active run when a stale stream_end arrives', () => {
    const first = applyRunStarted(emptyState(), startEvent('run-1'));
    const second = applyRunStarted(first, startEvent('run-2'));
    const afterStaleEnd = applyRunEnded(second, {
      ...endEvent('run-1'),
      reason: null,
    });

    expect(afterStaleEnd.isLoading).toBe(true);
    expect(afterStaleEnd.activeRunId).toBe('run-2');
    expect(afterStaleEnd.runs['run-2']?.status).toBe('running');
  });

  it('ends the active run when an external stream_end has an unknown run id', () => {
    const running = applyRunStarted(emptyState(), startEvent('run-1'));
    const ended = applyRunEnded(running, {
      ...endEvent('session-end-run'),
      reason: null,
    });

    expect(ended.isLoading).toBe(false);
    expect(ended.activeRunId).toBeNull();
    expect(ended.runs['run-1']).toBeUndefined();
    expect(ended.lastRun).toMatchObject({
      runId: 'run-1',
      status: 'completed',
    });
  });

  it('preserves cancelled status when the backend stream_end follows a stop', () => {
    const running = applyRunStarted(emptyState(), startEvent('run-1'));
    const stopped = applyRunStopped(running, 'run-1', 150);
    const ended = applyRunEnded(stopped, {
      ...endEvent('run-1'),
      timestamp: 200,
      reason: null,
    });

    expect(ended.isLoading).toBe(false);
    expect(ended.activeRunId).toBeNull();
    expect(ended.runs['run-1']).toMatchObject({
      status: 'cancelled',
      reason: null,
      endedAt: 200,
    });
  });

  it('drops terminated sibling runs when a new run ends (long-session accumulation guard)', () => {
    // 修复 #5: 之前 `idleRuns` 只清当前 event.runId, 其它 terminated run
    // (failed / cancelled / 已被 idleRuns 路径移走的 completed) 全部留在 runs
    // map, 长会话单调累积。 现在 `runs` 只承担 in-flight 元数据, 展示层走
    // `lastRun`。
    //
    // 模拟场景:
    //   run-1 (running) → 失败
    //   run-2 (running) → 用户 stop → cancelled
    //   run-3 (running, active) → 正常完成 (success, 不在 map 留)
    // 之后 runs map 应当为空 ── 三个 run 全部 terminated, 展示走 lastRun。
    let st = applyRunStarted(emptyState(), startEvent('run-1'));
    st = applyRunStarted(st, startEvent('run-2'));
    st = applyRunStarted(st, startEvent('run-3'));

    st = applyRunFailed(st, { ...errorEvent('run-1'), timestamp: 200 }, 'boom');
    st = applyRunStopped(st, 'run-2', 250);
    st = applyRunEnded(st, { ...endEvent('run-3'), timestamp: 300, reason: null });

    expect(Object.keys(st.runs)).toHaveLength(0);
    // lastRun 仍保留 ── 展示层真源, 不随 runs 清掉而丢。
    expect(st.lastRun).toMatchObject({
      runId: 'run-3',
      status: 'completed',
      endedAt: 300,
    });
  });

  it('keeps concurrent running runs when one stale background run ends', () => {
    // 多 run 并发场景: run-1 / run-2 同时跑, run-1 先结束 (failed),
    // run-2 仍在跑 ── 必须保留 run-2 的 entry。
    //
    // 关于 run-1 的处理: shouldKeepRun 在 reason 非空时为 true, 走 upsertRun
    // 把 event.runId 重新写一份 'failed' 进 runs ── 这是有意保留, 让
    // chat-store 内部能读到 metadata (e.g. tokenUsage.last error).
    // 这条副本在下一个 idleRuns 路径触发时 (新 run 的 success stream_end)
    // 才会被清掉 ── 由上一条测试覆盖。
    let st = applyRunStarted(emptyState(), startEvent('run-1'));
    st = applyRunStarted(st, startEvent('run-2'));

    st = applyRunEnded(st, { ...endEvent('run-1'), timestamp: 200, reason: 'late failure' });

    expect(Object.keys(st.runs).sort()).toEqual(['run-1', 'run-2']);
    expect(st.runs['run-1']?.status).toBe('failed');
    expect(st.runs['run-2']?.status).toBe('running');
    expect(st.activeRunId).toBe('run-2');
    expect(st.isLoading).toBe(true);
  });

  it('stores failed runs with a reason', () => {
    const running = applyRunStarted(emptyState(), startEvent('run-1'));
    const failed = applyRunFailed(running, {
      ...errorEvent('run-1'),
      message: 'boom',
      timestamp: 300,
    }, 'boom');

    expect(failed.runs['run-1']).toMatchObject({
      status: 'failed',
      reason: 'boom',
      endedAt: 300,
    });
  });

  it('clears isLoading / activeRunId / pending cursors when active run fails', () => {
    // 修复 #4: 之前 error chunk 后 isLoading / activeRunId / pendingAssistantId /
    // pendingReasoningId 全部保留, 直到 stream_end chunk 到达才统一清。
    // 中间窗口期 (跨一个网络 RTT) UI 仍显示"running", 迟到的 text/reasoning
    // chunk 会 append 到已"失败"的 assistant 行, 形成撕裂。
    const running = applyRunStarted(
      { ...emptyState(), pendingAssistantId: 'assistant-stale', pendingReasoningId: 'reasoning-stale' },
      startEvent('run-1'),
    );
    const failed = applyRunFailed(running, {
      ...errorEvent('run-1'),
      message: 'agent stuck',
      timestamp: 300,
    }, 'agent stuck');

    expect(failed.isLoading).toBe(false);
    expect(failed.activeRunId).toBeNull();
    expect(failed.pendingAssistantId).toBeNull();
    expect(failed.pendingReasoningId).toBeNull();
    expect(failed.runs['run-1']?.status).toBe('failed');
  });

  it('keeps isLoading / activeRunId untouched when a stale background run fails', () => {
    // 守门: 仅当 event.runId === activeRunId 才清 active 状态。
    // background run (非 active) 失败不影响主 run 的运行中视觉, 后续 stream_end
    // chunk 仍会兜底收敛。
    const first = applyRunStarted(emptyState(), startEvent('run-1'));
    const second = applyRunStarted(first, startEvent('run-2'));
    expect(second.activeRunId).toBe('run-2');
    expect(second.isLoading).toBe(true);

    // run-1 是 stale background, 它失败不应打断正在跑的 run-2。
    const failed = applyRunFailed(second, {
      ...errorEvent('run-1'),
      message: 'late failure',
      timestamp: 300,
    }, 'late failure');

    expect(failed.activeRunId).toBe('run-2');
    expect(failed.isLoading).toBe(true);
    // pending 游标仍清 ── 与 active run 无关, error 后无更多 chunk, 切 null 防撕裂。
    expect(failed.pendingAssistantId).toBeNull();
    expect(failed.pendingReasoningId).toBeNull();
    // run-1 失败被记录到 runs map (供 metadata 展示)。
    expect(failed.runs['run-1']?.status).toBe('failed');
  });

  // ── 通用 metadata 协议: lastRun 快照 ──
  // Bug 修复: stream_end 后 runs[runId] 被清理, BadgeHoverCard 读不到 metadata。
  // 解决: 每次 stream_start / usage / stream_end / failed / stopped 都同步
  //       写 lastRun, 让 run 结束后展示层仍可读 model / tokenUsage / elapsed。
  describe('lastRun snapshot', () => {
    it('initializes lastRun on stream_start with model and startedAt', () => {
      const next = applyRunStarted(
        emptyState(),
        { ...startEvent('run-1'), model: 'gpt-5', reasoningEffort: 'medium' },
        { model: 'gpt-5' }
      );

      expect(next.lastRun).toMatchObject({
        runId: 'run-1',
        agentType: 'codex',
        startedAt: 100,
        status: 'running',
        model: 'gpt-5',
      });
      expect(next.lastRun?.tokenUsage).toBeUndefined();
    });

    it('keeps lastRun visible after a normally completed run (runs map cleared)', () => {
      const running = applyRunStarted(
        emptyState(),
        { ...startEvent('run-1'), model: 'gpt-5' },
        { model: 'gpt-5' }
      );
      const withUsage = applyRunUsage(running, {
        kind: 'usage',
        agentType: 'codex',
        threadId: 'thread-1',
        runId: 'run-1',
        timestamp: 200,
        totalTokens: 42,
      });
      // 中间 lastRun.tokenUsage 应已累加
      expect(withUsage.lastRun?.tokenUsage?.total).toBe(42);

      const ended = applyRunEnded(withUsage, {
        ...endEvent('run-1'),
        timestamp: 300,
        reason: null,
      });

      // 关键断言: runs[run-1] 被清理, 但 lastRun 仍可见;
      // 正常完成 → status === 'completed'(与 agent-conversation-store.markRunEnded 同语义)。
      expect(ended.runs['run-1']).toBeUndefined();
      expect(ended.lastRun).toMatchObject({
        runId: 'run-1',
        startedAt: 100,
        endedAt: 300,
        model: 'gpt-5',
        status: 'completed',
        reason: null,
      });
      expect(ended.lastRun?.tokenUsage?.total).toBe(42);
    });

    it('marks lastRun as failed when stream_end carries a reason', () => {
      // 后端流断了 / stuck / 超 cycle 等 → emit `Error` chunk + `StreamEnd{reason:...}`。
      // 之前 status 永远写 'failed',无法区分"成功"和"失败"两种结局。
      // 修复后 reason 非空 → 'failed',reason 为空 → 'completed'。
      const running = applyRunStarted(
        emptyState(),
        { ...startEvent('run-1'), model: 'gpt-5' },
        { model: 'gpt-5' }
      );
      const ended = applyRunEnded(running, {
        ...endEvent('run-1'),
        timestamp: 200,
        reason: 'agent stuck',
      });

      expect(ended.runs['run-1']).toMatchObject({
        status: 'failed',
        reason: 'agent stuck',
        endedAt: 200,
      });
      expect(ended.lastRun).toMatchObject({
        runId: 'run-1',
        status: 'failed',
        reason: 'agent stuck',
        endedAt: 200,
        model: 'gpt-5',
      });
    });

    it('mirrors usage to lastRun only when runId matches (no cross-run pollution)', () => {
      const r1 = applyRunStarted(
        emptyState(),
        { ...startEvent('run-1'), model: 'gpt-5' },
        { model: 'gpt-5' }
      );
      const r1Used = applyRunUsage(r1, {
        kind: 'usage',
        agentType: 'codex',
        threadId: 'thread-1',
        runId: 'run-1',
        timestamp: 150,
        totalTokens: 10,
      });
      expect(r1Used.lastRun?.tokenUsage?.total).toBe(10);

      // 启动 run-2: lastRun 切换,但保留上一轮 token 快照,避免运行中展示闪空。
      const r2 = applyRunStarted(r1Used, startEvent('run-2'));
      expect(r2.lastRun?.runId).toBe('run-2');
      expect(r2.lastRun?.tokenUsage?.total).toBe(10);

      // run-1 迟到的 Usage chunk 不应污染 run-2 的 lastRun
      const r2AfterStale = applyRunUsage(r2, {
        kind: 'usage',
        agentType: 'codex',
        threadId: 'thread-1',
        runId: 'run-1',
        timestamp: 200,
        totalTokens: 5,
      });
      expect(r2AfterStale.lastRun?.runId).toBe('run-2');
      expect(r2AfterStale.lastRun?.tokenUsage?.total).toBe(10);
      // runs[run-1] 仍累加 (供 chat-store 内部使用)
      expect(r2AfterStale.runs['run-1']?.tokenUsage?.total).toBe(15);
    });

    it('writes lastRun on applyRunStopped (cancel before stream_end)', () => {
      const running = applyRunStarted(
        emptyState(),
        { ...startEvent('run-1'), model: 'claude-sonnet' },
        { model: 'claude-sonnet' }
      );
      const stopped = applyRunStopped(running, 'run-1', 250);

      expect(stopped.lastRun).toMatchObject({
        runId: 'run-1',
        status: 'cancelled',
        endedAt: 250,
        model: 'claude-sonnet',
      });
    });

    it('writes lastRun on applyRunFailed (error before stream_end)', () => {
      const running = applyRunStarted(
        emptyState(),
        { ...startEvent('run-1'), model: 'gpt-5' },
        { model: 'gpt-5' }
      );
      const failed = applyRunFailed(running, {
        ...errorEvent('run-1'),
        message: 'boom',
        timestamp: 300,
      }, 'boom');

      expect(failed.lastRun).toMatchObject({
        runId: 'run-1',
        status: 'failed',
        reason: 'boom',
        endedAt: 300,
        model: 'gpt-5',
      });
    });
  });
});
