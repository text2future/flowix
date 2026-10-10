import type { AgentEvent } from "@/types/agent";

export type BufferedStreamEvent = Extract<AgentEvent, { kind: "text_delta" | "reasoning_delta" }>;

export interface StreamingBuffer {
  append(event: BufferedStreamEvent): void;
  flushSync(): void;
}

export interface StreamingScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

function defaultStreamingScheduler(): StreamingScheduler {
  return {
    request: (callback) => {
      if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
      return setTimeout(() => callback(performance.now()), 16) as unknown as number;
    },
    cancel: (id) => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
      else clearTimeout(id);
    },
  };
}

export function createStreamingBuffer(
  onFlush: (events: BufferedStreamEvent[]) => void,
  scheduler: StreamingScheduler = defaultStreamingScheduler(),
): StreamingBuffer {
  let buffered: BufferedStreamEvent[] = [];
  let pendingRafId: number | null = null;

  function flushSync(): void {
    if (pendingRafId != null) {
      scheduler.cancel(pendingRafId);
      pendingRafId = null;
    }
    if (buffered.length === 0) return;
    const events = buffered;
    buffered = [];
    onFlush(events);
  }

  return {
    append(event) {
      const previous = buffered[buffered.length - 1];
      if (
        previous && previous.kind === event.kind &&
        previous.threadId === event.threadId &&
        previous.runId === event.runId &&
        previous.agentType === event.agentType &&
        previous.messageId === event.messageId &&
        previous.contentMode === "delta" && event.contentMode === "delta"
      ) {
        buffered[buffered.length - 1] = { ...previous, text: previous.text + event.text };
      } else {
        buffered.push(event);
      }
      if (pendingRafId == null) {
        pendingRafId = scheduler.request(() => {
          pendingRafId = null;
          flushSync();
        });
      }
    },
    flushSync,
  };
}
