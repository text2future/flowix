import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import type { AgentEvent } from "@/types/agent";
import { createAgentMessageViewModel } from "@features/agent/message";
import { getRenderedAgentItems } from "@features/agent/thread-card/messages/message-list-renderer";
import { parsePiHistoryMessages } from "@features/agent/runtime/pi-history";
import { emptyProjection, reduceProjection } from "@features/agent/store/session-reducer";
import { replaceCompletedRunWithHistory } from "@features/agent/store/thread-history";

/**
 * Live/history parity for one Pi turn.
 *
 * Pi has two projection paths that must agree: the reducer consumes the RPC
 * event stream while streaming, and `parsePiHistoryMessages` reads the
 * persisted session. `replaceCompletedRunWithHistory` swaps the first for the
 * second when the run settles, so any field the two paths format differently
 * becomes a visible jump at turn end (raw JSON results that suddenly turn into
 * text, a tool row that turns red, a spinner that starts spinning again).
 *
 * These tests replay the exact event shapes `pi/runtime.rs` emits and assert
 * the *rendered* projection — not the raw rows — is identical on both sides.
 */

const THREAD = "thread-1";
const RUN = "run-1";
const T = 1_760_000_000_000;

function event(partial: Record<string, unknown>): AgentEvent {
  return { agentType: "pi", threadId: THREAD, runId: RUN, timestamp: T, ...partial } as AgentEvent;
}

function reduceAll(events: AgentEvent[]): ChatMessage[] {
  let projection = emptyProjection();
  for (const item of events) projection = reduceProjection(projection, item);
  return projection.messages;
}

interface DescribedMessage {
  role: ChatMessage["role"];
  messageType?: string;
  content: string;
  toolLabel: string;
  toolSummary: string;
  reasoningLabel?: string;
  isLoading: boolean;
  toolError: boolean;
  isCompleted?: boolean;
}

function describeMessage(row: ChatMessage): DescribedMessage {
  const view = createAgentMessageViewModel(row, "zh-CN");
  return {
    role: row.role,
    messageType: row.messageType,
    content: view.visibleContent,
    toolLabel: view.toolLabel,
    toolSummary: view.toolSummary,
    reasoningLabel: row.role === "reasoning" ? view.reasoningLabel : undefined,
    isLoading: row.isLoading ?? false,
    toolError: row.toolError ?? false,
    // Assistant/reasoning rows expose "still streaming" through isCompleted;
    // tool rows use isLoading and have no settled equivalent on the live path.
    isCompleted: row.role === "tool" ? undefined : row.isCompleted ?? false,
  };
}

/** What the reader actually sees: grouped render items, in order. */
function describeTimeline(messages: ChatMessage[], isLoading = false) {
  return getRenderedAgentItems(messages, isLoading).map((item) => {
    if (item.kind === "tool-group") {
      return {
        kind: "tool-group" as const,
        status: item.status,
        total: item.totalCount,
        tools: [...item.completedTools, ...item.runningTools].map(describeMessage),
      };
    }
    if (item.kind === "generated-images") {
      return { kind: "generated-images" as const, count: item.images.length };
    }
    return describeMessage(item.message);
  });
}

interface Scenario {
  name: string;
  history: unknown[];
  events: AgentEvent[];
}

function expectParity(scenario: Scenario) {
  const live = reduceAll(scenario.events);
  const history = parsePiHistoryMessages(THREAD, scenario.history);
  const settled = replaceCompletedRunWithHistory(live, history, RUN, "pi");

  // 1. The streaming result and the persisted result must render identically.
  expect(describeTimeline(live), `${scenario.name}: live vs history`).toEqual(
    describeTimeline(history),
  );

  // 2. Settling the run must not change what is on screen.
  expect(describeTimeline(settled), `${scenario.name}: live vs settled`).toEqual(
    describeTimeline(live),
  );

  // 3. ...and it must not leave a duplicate row behind either.
  expect(settled.length, `${scenario.name}: row count`).toBe(live.length);

  // 4. Rows must keep their render identity, otherwise every settled turn
  //    remounts the tool group and the reader loses scroll anchoring / any
  //    expanded detail state they had open.
  expect(
    settled.map((row) => row.renderKey ?? row.id),
    `${scenario.name}: render identity`,
  ).toEqual(live.map((row) => row.renderKey ?? row.id));
}

function userEntry(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: T,
    _pi_session_message_id: "u1",
    _pi_history_sequence: 1,
  };
}

function userEvent(text: string, sequence = 1) {
  return event({
    kind: "user_message",
    id: "u1",
    text,
    sourceSequence: sequence,
    sourceSubsequence: 0,
    sourceTimestamp: T,
  });
}

function startEvent() {
  return event({ kind: "stream_start", sourceSequence: 1 });
}

/** One assistant content block, as `project_completed_message` emits it. */
function textSnapshot(entryId: string, text: string, blockIndex: number, sequence: number, timestamp = T + 1) {
  return event({
    kind: "text_delta",
    text,
    contentMode: "snapshot",
    messagePhase: "completed",
    messageId: entryId,
    sourceSequence: sequence,
    sourceSubsequence: blockIndex,
    sourceTimestamp: timestamp,
  });
}

function reasoningSnapshot(entryId: string, text: string, blockIndex: number, sequence: number) {
  return event({
    kind: "reasoning_delta",
    text,
    contentMode: "snapshot",
    messagePhase: "completed",
    messageId: entryId,
    sourceSequence: sequence,
    sourceSubsequence: blockIndex,
    sourceTimestamp: T + 1,
  });
}

function toolCallEvent(callId: string, name: string, input: unknown, parentId: string, blockIndex: number, sequence: number) {
  return event({
    kind: "tool_call",
    toolCallId: callId,
    name,
    input,
    parentMessageId: parentId,
    sourceSequence: sequence,
    sourceSubsequence: blockIndex,
    sourceTimestamp: T + 1,
  });
}

function toolResultEvent(callId: string, name: string, content: string, sequence: number, isError = false) {
  return event({
    kind: "tool_result",
    toolCallId: callId,
    name,
    result: { content, is_error: isError },
    sourceSequence: sequence,
  });
}

describe("Pi live/history projection parity", () => {
  it("renders a tool call identically while streaming and after it is persisted", () => {
    expectParity({
      name: "read tool",
      history: [
        userEntry("please read a.md"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the file.", _pi_content_index: 0 },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.md" }, _pi_content_index: 1 },
          ],
          stopReason: "toolUse",
          timestamp: T + 1,
          _pi_session_message_id: "a1",
          _pi_history_sequence: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "file content" }],
          isError: false,
          timestamp: T + 2,
          _pi_session_message_id: "r1",
          _pi_history_sequence: 3,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done.", _pi_content_index: 0 }],
          stopReason: "stop",
          timestamp: T + 3,
          _pi_session_message_id: "a2",
          _pi_history_sequence: 4,
        },
      ],
      events: [
        userEvent("please read a.md"),
        startEvent(),
        textSnapshot("a1", "Reading the file.", 0, 2),
        toolCallEvent("call-1", "read", { path: "a.md" }, "a1", 1, 2),
        toolResultEvent("call-1", "read", "file content", 3),
        textSnapshot("a2", "Done.", 0, 4, T + 3),
        event({ kind: "stream_end", sourceSequence: 5 }),
      ],
    });
  });

  it("keeps a failed tool soft-failed on both paths instead of turning red at the end", () => {
    expectParity({
      name: "failed bash tool",
      history: [
        userEntry("run tests"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running.", _pi_content_index: 0 },
            { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "npm test" }, _pi_content_index: 1 },
          ],
          stopReason: "toolUse",
          timestamp: T + 1,
          _pi_session_message_id: "a1",
          _pi_history_sequence: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "bash",
          content: [{ type: "text", text: "boom" }],
          isError: true,
          timestamp: T + 2,
          _pi_session_message_id: "r1",
          _pi_history_sequence: 3,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "It failed.", _pi_content_index: 0 }],
          stopReason: "stop",
          timestamp: T + 3,
          _pi_session_message_id: "a2",
          _pi_history_sequence: 4,
        },
      ],
      events: [
        userEvent("run tests"),
        startEvent(),
        textSnapshot("a1", "Running.", 0, 2),
        toolCallEvent("call-2", "bash", { command: "npm test" }, "a1", 1, 2),
        toolResultEvent("call-2", "bash", "boom", 3, true),
        textSnapshot("a2", "It failed.", 0, 4, T + 3),
        event({ kind: "stream_end", sourceSequence: 5 }),
      ],
    });
  });

  it("does not report an empty successful tool as a failure", () => {
    expectParity({
      name: "write with no output",
      history: [
        userEntry("write it"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Writing.", _pi_content_index: 0 },
            { type: "toolCall", id: "call-3", name: "write", arguments: { path: "b.md", content: "hi" }, _pi_content_index: 1 },
          ],
          stopReason: "toolUse",
          timestamp: T + 1,
          _pi_session_message_id: "a1",
          _pi_history_sequence: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-3",
          toolName: "write",
          content: [],
          isError: false,
          timestamp: T + 2,
          _pi_session_message_id: "r1",
          _pi_history_sequence: 3,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Written.", _pi_content_index: 0 }],
          stopReason: "stop",
          timestamp: T + 3,
          _pi_session_message_id: "a2",
          _pi_history_sequence: 4,
        },
      ],
      events: [
        userEvent("write it"),
        startEvent(),
        textSnapshot("a1", "Writing.", 0, 2),
        toolCallEvent("call-3", "write", { path: "b.md", content: "hi" }, "a1", 1, 2),
        toolResultEvent("call-3", "write", "", 3),
        textSnapshot("a2", "Written.", 0, 4, T + 3),
        event({ kind: "stream_end", sourceSequence: 5 }),
      ],
    });
  });

  it("settles an interrupted tool call without leaving a spinner", () => {
    expectParity({
      name: "aborted tool",
      history: [
        userEntry("stop midway"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Working.", _pi_content_index: 0 },
            { type: "toolCall", id: "call-4", name: "read", arguments: { path: "a.md" }, _pi_content_index: 1 },
          ],
          stopReason: "aborted",
          timestamp: T + 1,
          _pi_session_message_id: "a1",
          _pi_history_sequence: 2,
        },
      ],
      events: [
        userEvent("stop midway"),
        startEvent(),
        textSnapshot("a1", "Working.", 0, 2),
        toolCallEvent("call-4", "read", { path: "a.md" }, "a1", 1, 2),
        event({ kind: "stream_end", reason: "aborted", sourceSequence: 3 }),
      ],
    });
  });

  it("keeps text-tool-text blocks of one message in native order", () => {
    expectParity({
      name: "text tool text",
      history: [
        userEntry("two paragraphs"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Before.", _pi_content_index: 0 },
            { type: "toolCall", id: "call-5", name: "read", arguments: { path: "a.md" }, _pi_content_index: 1 },
            { type: "text", text: "After.", _pi_content_index: 2 },
          ],
          stopReason: "stop",
          timestamp: T + 1,
          _pi_session_message_id: "a1",
          _pi_history_sequence: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-5",
          toolName: "read",
          content: [{ type: "text", text: "body" }],
          isError: false,
          timestamp: T + 2,
          _pi_session_message_id: "r1",
          _pi_history_sequence: 3,
        },
      ],
      events: [
        userEvent("two paragraphs"),
        startEvent(),
        textSnapshot("a1", "Before.", 0, 2),
        toolCallEvent("call-5", "read", { path: "a.md" }, "a1", 1, 2),
        toolResultEvent("call-5", "read", "body", 3),
        textSnapshot("a1", "After.", 2, 4, T + 1),
        event({ kind: "stream_end", sourceSequence: 5 }),
      ],
    });
  });

  it("renders forwarded thinking as a reasoning row on both paths", () => {
    expectParity({
      name: "reasoning then text",
      history: [
        userEntry("think first"),
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should read it.", _pi_content_index: 0 },
            { type: "text", text: "Reading the file.", _pi_content_index: 1 },
          ],
          stopReason: "stop",
          timestamp: T + 1,
          _pi_session_message_id: "a1",
          _pi_history_sequence: 2,
        },
      ],
      events: [
        userEvent("think first"),
        startEvent(),
        reasoningSnapshot("a1", "I should read it.", 0, 2),
        textSnapshot("a1", "Reading the file.", 1, 2),
        event({ kind: "stream_end", sourceSequence: 3 }),
      ],
    });
  });

  it("keeps an image tool result as the same placeholder the history emits", () => {
    expectParity({
      name: "image tool result",
      history: [
        userEntry("screenshot it"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Taking a screenshot.", _pi_content_index: 0 },
            { type: "toolCall", id: "call-6", name: "screenshot", arguments: {}, _pi_content_index: 1 },
          ],
          stopReason: "toolUse",
          timestamp: T + 1,
          _pi_session_message_id: "a1",
          _pi_history_sequence: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-6",
          toolName: "screenshot",
          content: [
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "text", text: "screenshot" },
          ],
          isError: false,
          timestamp: T + 2,
          _pi_session_message_id: "r1",
          _pi_history_sequence: 3,
        },
      ],
      events: [
        userEvent("screenshot it"),
        startEvent(),
        textSnapshot("a1", "Taking a screenshot.", 0, 2),
        toolCallEvent("call-6", "screenshot", {}, "a1", 1, 2),
        // Rust flattens the content envelope before it reaches the wire.
        toolResultEvent("call-6", "screenshot", "[Image attachment]\nscreenshot", 3),
        event({ kind: "stream_end", sourceSequence: 4 }),
      ],
    });
  });

  // Pi has no live event for compaction, fork summaries, or extension
  // commentary, so those rows can only appear when history lands. That is
  // acceptable; silently rewriting or duplicating the rows the reader is
  // already looking at is not.
  it("adds history-only marker rows without touching the rows already on screen", () => {
    const live = reduceAll([
      userEvent("check the plan"),
      startEvent(),
      textSnapshot("a2", "Plan looks fine.", 0, 2),
      event({ kind: "stream_end", sourceSequence: 3 }),
    ]);
    const history = parsePiHistoryMessages(THREAD, [
      userEntry("check the plan"),
      {
        role: "compactionSummary",
        summary: "Earlier context compacted.",
        timestamp: T + 1,
        _pi_session_message_id: "c1",
        _pi_history_sequence: 2,
      },
      {
        role: "branchSummary",
        summary: "Forked from the draft branch.",
        timestamp: T + 2,
        _pi_session_message_id: "b1",
        _pi_history_sequence: 3,
      },
      {
        role: "custom",
        display: true,
        content: [{ type: "text", text: "Extension note." }],
        timestamp: T + 3,
        _pi_session_message_id: "x1",
        _pi_history_sequence: 4,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Plan looks fine.", _pi_content_index: 0 }],
        stopReason: "stop",
        timestamp: T + 4,
        _pi_session_message_id: "a2",
        _pi_history_sequence: 5,
      },
    ]);

    const settled = replaceCompletedRunWithHistory(live, history, RUN, "pi");
    const liveKeys = live.map((row) => row.renderKey ?? row.id);
    const settledKeys = settled.map((row) => row.renderKey ?? row.id);

    // Every row the reader already saw is still there, in the same order.
    expect(settledKeys.filter((key) => liveKeys.includes(key))).toEqual(liveKeys);
    // The only additions are the three history-only markers, each exactly once.
    expect(
      settled
        .filter((row) => !liveKeys.includes(row.renderKey ?? row.id))
        .map((row) => row.messageType),
    ).toEqual(["context-compaction", "branch-summary", "agent-commentary"]);
    // ...and they land before the assistant row they precede in history.
    expect(settledKeys.indexOf("a2:block:0")).toBeGreaterThan(
      settledKeys.findIndex((key) => key === "c1"),
    );
  });
});
