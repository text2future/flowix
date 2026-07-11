import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import type { ThreadState } from "@features/agent/store/chat-store";
import {
  applyErrorChunk,
  applyReasoningChunk,
  applyTextChunk,
  applyToolCallChunk,
  applyToolResultChunk,
} from "@features/agent/store/apply-chunk";

function emptyThreadState(): ThreadState {
  return {
    messages: [],
    isLoading: false,
    activeRunId: null,
    runs: {},
    pendingAssistantId: null,
    pendingReasoningId: null,
    oldestSequence: null,
    hasMoreHistory: false,
    loadingMore: false,
  };
}

function reasoningMessage(id: string, content: string, isCompleted = false): ChatMessage {
  return {
    id,
    role: "reasoning",
    content,
    timestamp: "2026-07-06T00:00:00Z",
    isCompleted,
  };
}

function assistantMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    timestamp: "2026-07-06T00:00:00Z",
  };
}

describe("applyErrorChunk", () => {
  it("appends the error as a new assistant message", () => {
    const next = applyErrorChunk(emptyThreadState(), "boom");

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({
      role: "assistant",
      content: "boom",
    });
  });

  it("clears pendingAssistantId and pendingReasoningId", () => {
    // 修复 #4: 之前保留 pending 游标, error 后迟到的 text/reasoning chunk 会
    // 通过 applyTextChunk / applyReasoningChunk append 到已"失败"的 assistant
    // 行, 形成撕裂。清 null 让迟到 chunk 走 create-new 路径, 与原行物理隔离。
    const st: ThreadState = {
      ...emptyThreadState(),
      pendingAssistantId: "assistant-stale",
      pendingReasoningId: "reasoning-stale",
    };
    const next = applyErrorChunk(st, "boom");

    expect(next.pendingAssistantId).toBeNull();
    expect(next.pendingReasoningId).toBeNull();
  });

  it("closes the pending reasoning message with isCompleted: true", () => {
    // reasoning 行有 isCompleted 字段, 关闭靠显式标 true (与 applyTextChunk
    // 切走 reasoning → text 的语义同形)。 assistant 行没有该字段, 关闭靠
    // pendingAssistantId=null + 后续 text chunk 走 create-new 路径。
    const st: ThreadState = {
      ...emptyThreadState(),
      messages: [
        reasoningMessage("reasoning-stale", "thinking...", false),
        assistantMessage("assistant-stale", "halfway"),
      ],
      pendingAssistantId: "assistant-stale",
      pendingReasoningId: "reasoning-stale",
    };
    const next = applyErrorChunk(st, "agent stuck");

    const reasoning = next.messages.find((m) => m.id === "reasoning-stale");
    expect(reasoning?.isCompleted).toBe(true);
    // 错误消息追加在末尾, 旧的 assistant-stale 不动 (没 isCompleted 字段).
    expect(next.messages).toHaveLength(3);
    expect(next.messages[2]).toMatchObject({ role: "assistant", content: "agent stuck" });
  });

  it("does not mutate state when no pending cursors are set", () => {
    // 空 state (没在 stream 中) 收到 error → 不报错, messages 直接追加。
    const next = applyErrorChunk(emptyThreadState(), "late error");

    expect(next.messages).toHaveLength(1);
    expect(next.pendingAssistantId).toBeNull();
    expect(next.pendingReasoningId).toBeNull();
  });
});

// ── 最小回归网: 验证其他 apply*Chunk 路径不受本次改动影响 ──
describe("apply chunks regression net", () => {
  it("applyTextChunk closes pending reasoning before appending new assistant text", () => {
    // 这是 applyTextChunk 已有的行为, applyErrorChunk 修复后必须保持对称 ──
    // error chunk 也应关闭 pending reasoning。
    const st: ThreadState = {
      ...emptyThreadState(),
      messages: [reasoningMessage("reasoning-stale", "thinking", false)],
      pendingReasoningId: "reasoning-stale",
    };
    const next = applyTextChunk(st, "Hello");

    expect(next.messages.find((m) => m.id === "reasoning-stale")?.isCompleted).toBe(true);
    expect(next.messages[1]).toMatchObject({ role: "assistant", content: "Hello" });
  });

  it("applyToolCallChunk resets pendingAssistantId", () => {
    // tool_call 之后到 tool_result 之前的 assistant 行不连续, 是设计行为 ──
    // 与本次 error chunk 清 pending 语义一致, 验证不被破坏。
    const st: ThreadState = {
      ...emptyThreadState(),
      pendingAssistantId: "assistant-stale",
    };
    const next = applyToolCallChunk(st, "call-1", "read", { path: "/a.md" });

    expect(next.pendingAssistantId).toBeNull();
    expect(next.messages[0]).toMatchObject({ role: "tool", toolCallId: "call-1" });
  });

  it("applyToolResultChunk keeps pending cursors untouched", () => {
    // tool_result 不应清 pending ── LLM 之后可能继续推 text, 应延续到原 assistant 行。
    const st: ThreadState = {
      ...emptyThreadState(),
      pendingAssistantId: "assistant-stale",
      pendingReasoningId: "reasoning-stale",
    };
    const next = applyToolResultChunk(st, "call-1", "read", { content: "ok" });

    expect(next.pendingAssistantId).toBe("assistant-stale");
    expect(next.pendingReasoningId).toBe("reasoning-stale");
  });

  it("applyReasoningChunk keeps pendingAssistantId untouched", () => {
    // 同理, reasoning chunk 不应清 pendingAssistantId。
    const st: ThreadState = {
      ...emptyThreadState(),
      pendingAssistantId: "assistant-stale",
    };
    const next = applyReasoningChunk(st, "thinking...");

    expect(next.pendingAssistantId).toBe("assistant-stale");
    // reasoning 行 id 由实现里 `reasoning-${Date.now()}` 生成, 只要非空即符合预期。
    expect(next.pendingReasoningId).toMatch(/^reasoning-\d+$/);
  });
});