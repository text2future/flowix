import { describe, expect, it } from "vitest";
import { getComposerSubmissionKind, selectComposerSubmissionState } from "./composer-submission-state";

const idle = {
  agentType: "codex" as const, isModelRunning: false, isStopping: false,
  isCommandRunning: false, isCommandStoppable: false, isSubmitting: false,
  isAvailable: true, prompt: "hello", hasAttachments: false, hasPendingAttachments: false,
};

describe("composer submission policy", () => {
  it("uses one command catalog for typed prompts and menu commands", () => {
    expect(getComposerSubmissionKind("dsh", "/export")).toBe("command");
    expect(getComposerSubmissionKind("dsh", "/compact")).toBe("command");
    expect(getComposerSubmissionKind("codex", "/goal set ship it")).toBe("command");
    expect(getComposerSubmissionKind("codex", "/goalkeeper")).toBe("message");
    expect(getComposerSubmissionKind("claudecode", "/goal")).toBe("message");
    expect(getComposerSubmissionKind("codex", "$browser:review")).toBe("message");
  });

  it.each([
    [{}, "send", false, true],
    [{ prompt: " " }, "send", true, false],
    [{ prompt: "", hasAttachments: true }, "send", false, true],
    [{ hasPendingAttachments: true }, "send", true, false],
    [{ isSubmitting: true }, "busy", true, false],
    [{ isAvailable: false }, "send", true, false],
    // Stopping stays clickable: a stop can be dropped, and a disabled button
    // would leave a run that the runtime never confirmed with no way out.
    [{ isStopping: true, isModelRunning: true }, "stop", false, false],
    [{ isCommandRunning: true }, "busy", true, false],
    [{ isCommandRunning: true, isCommandStoppable: true }, "stop", false, false],
    [{ isModelRunning: true }, "queue", false, true],
    [{ isModelRunning: true, hasPendingAttachments: true }, "queue", true, false],
    [{ isModelRunning: true, prompt: "" }, "stop", false, false],
    [{ isModelRunning: true, prompt: "/compact" }, "send", true, false],
    [{ prompt: "/goal set ship it", hasAttachments: true }, "send", true, false],
  ] as const)("derives buttons and submit permission from %j", (patch, action, disabled, canSubmit) => {
    expect(selectComposerSubmissionState({ ...idle, ...patch }))
      .toMatchObject({ action, disabled, canSubmit });
  });

  it.each(["codex", "dsh", "pi"] as const)("allows %s messages to queue, but not native commands", (agentType) => {
    expect(selectComposerSubmissionState({ ...idle, agentType, isModelRunning: true }).canSubmit).toBe(true);
    expect(selectComposerSubmissionState({ ...idle, agentType, isModelRunning: true, kind: "command" }).canSubmit).toBe(false);
  });

  it("keeps Stop available for agents that cannot queue without permitting Enter to send", () => {
    expect(selectComposerSubmissionState({ ...idle, agentType: "claudecode", isModelRunning: true }))
      .toMatchObject({ action: "stop", disabled: false, canSubmit: false });
  });
});
