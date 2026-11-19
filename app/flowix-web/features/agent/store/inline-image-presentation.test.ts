import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { restoreInlineImagePresentations, saveInlineImagePresentation } from "./inline-image-presentation";

const path = "/Users/rop/.flowix/cache/images/test-image.png";
const attachment = {
  type: "input_image" as const,
  path,
  name: "test-image.png",
  mimeType: "image/png",
};
const href = `flowix://agent-image-attachment?path=${encodeURIComponent(path)}`;

function userMessage(content: string, timestamp = "2026-11-17T15:00:00.000Z"): ChatMessage {
  return {
    id: "user-history",
    role: "user",
    content,
    attachments: [attachment],
    timestamp,
  };
}

function oldFingerprint(content: string, paths: string[]): string {
  const value = JSON.stringify([content.trim(), paths.slice().sort()]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${first >>> 0}:${second >>> 0}`;
}

describe("inline image presentation history", () => {
  beforeEach(() => localStorage.clear());

  it("restores a saved image marker at its original position after reload", () => {
    const displayContent = `[test-image.png](${href})测试`;
    saveInlineImagePresentation(
      "thread-1",
      "codex",
      "测试",
      displayContent,
      [attachment],
      Date.parse("2026-11-17T15:00:00.000Z"),
    );

    const restored = restoreInlineImagePresentations("thread-1", "codex", [userMessage("测试")]);
    expect(restored[0].content).toBe(displayContent);
  });

  it("restores both the inline card and its local attachment when provider history omits attachments", () => {
    const displayContent = `[test-image.png](${href})测试`;
    saveInlineImagePresentation(
      "thread-1",
      "codex",
      "测试",
      displayContent,
      [attachment],
      Date.parse("2026-11-17T15:00:00.000Z"),
    );
    const historyMessage = { ...userMessage("测试"), attachments: undefined };

    const restored = restoreInlineImagePresentations("thread-1", "codex", [historyMessage]);
    expect(restored[0].content).toBe(displayContent);
    expect(restored[0].attachments).toEqual([attachment]);
  });

  it("uses the saved local image path when provider history changes the attachment path", () => {
    const displayContent = `[test-image.png](${href})测试`;
    saveInlineImagePresentation(
      "thread-1",
      "codex",
      "测试",
      displayContent,
      [attachment],
      Date.parse("2026-11-17T15:00:00.000Z"),
    );
    const providerAttachment = { ...attachment, path: "/provider/cache/image.png" };

    const restored = restoreInlineImagePresentations("thread-1", "codex", [
      { ...userMessage("测试"), attachments: [providerAttachment] },
    ]);
    expect(restored[0].content).toBe(displayContent);
    expect(restored[0].attachments).toEqual([attachment]);
  });

  it("migrates the previous presentation record when provider history omits attachments", () => {
    const timestamp = Date.parse("2026-11-17T15:00:00.000Z");
    localStorage.setItem("flowix-agent-inline-image-presentations-v1", JSON.stringify([{
      threadId: "thread-1",
      agentType: "codex",
      fingerprint: oldFingerprint("测试", [path]),
      createdAt: timestamp,
      markers: [{ offset: 0, order: 0, label: "test-image.png", path }],
    }]));

    const historyMessage = { ...userMessage("测试"), attachments: undefined };
    const restored = restoreInlineImagePresentations("thread-1", "codex", [historyMessage]);
    expect(restored[0].content).toBe(`[test-image.png](${href})测试`);
    expect(restored[0].attachments?.[0]).toMatchObject({ path, name: "test-image.png", type: "input_image" });
  });

  it("restores older image messages at the start when their position was never saved", () => {
    const restored = restoreInlineImagePresentations("thread-legacy", "codex", [userMessage("测试")]);
    expect(restored[0].content).toBe(`[test-image.png](${href})测试`);
  });

  it("does not reuse a saved position for another thread or different text", () => {
    const displayContent = `测试[test-image.png](${href})`;
    saveInlineImagePresentation("thread-1", "codex", "测试", displayContent, [attachment], 1);

    expect(restoreInlineImagePresentations("thread-2", "codex", [userMessage("测试")])[0].content)
      .toBe(`[test-image.png](${href})测试`);
    expect(restoreInlineImagePresentations("thread-1", "codex", [userMessage("other")])[0].content)
      .toBe(`[test-image.png](${href})other`);
  });
});
