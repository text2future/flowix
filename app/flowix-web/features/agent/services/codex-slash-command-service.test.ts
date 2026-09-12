import { describe, expect, it } from "vitest";

import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import {
  beginCodexSlashCommand,
  createCodexCommandLifecycle,
  finishCodexSlashCommand,
  hasPendingCodexCommand,
  parseCodexSkills,
} from "./codex-slash-command-service";

describe("parseCodexSkills", () => {
  it("reads the current skills/list response grouped by cwd", () => {
    expect(parseCodexSkills({
      data: [{
        cwd: "/workspace/project",
        skills: [
          {
            name: "review-agent",
            description: "Review changes.",
            interface: {
              displayName: "Review Agent",
              shortDescription: "Find actionable review findings.",
            },
            scope: "system",
          },
          { name: "skill-creator", description: "Create a skill.", enabled: true },
        ],
      }],
      errors: [],
    })).toEqual([
      {
        name: "review-agent",
        description: "Review changes.",
        displayName: "Review Agent",
        shortDescription: "Find actionable review findings.",
      },
      { name: "skill-creator", description: "Create a skill." },
    ]);
  });

  it("accepts direct data and skills envelopes", () => {
    expect(parseCodexSkills({
      data: [{ name: "from-data", description: "Data" }],
    })).toEqual([{ name: "from-data", description: "Data" }]);
    expect(parseCodexSkills({
      skills: [{ name: "from-skills", description: "Skills" }],
    })).toEqual([{ name: "from-skills", description: "Skills" }]);
  });

  it("accepts nested skills envelopes and removes duplicate names", () => {
    expect(parseCodexSkills({
      data: {
        skills: {
          data: [
            { name: "nested", description: "Nested" },
            { name: "nested", description: "Duplicate" },
          ],
        },
      },
    })).toEqual([{ name: "nested", description: "Nested" }]);
  });

  it("ignores empty and malformed responses", () => {
    expect(parseCodexSkills(undefined)).toEqual([]);
    expect(parseCodexSkills({ data: [{ cwd: "/workspace/project", skills: [null, {}, { name: "" }] }] }))
      .toEqual([]);
  });
});

describe("Codex command lifecycle", () => {
  it("creates an immediately visible pending row and settles the same row", () => {
    const threadId = "codex-command-lifecycle-test";
    const command = "/goal set ship it";
    const lifecycle = createCodexCommandLifecycle(threadId);

    beginCodexSlashCommand(threadId, command, lifecycle);
    let projection = useAgentSessionStore.getState().threadProjections[threadId];
    expect(projection?.messages).toMatchObject([
      {
        id: `codex-command:live:${lifecycle.commandId}`,
        content: command,
        isLoading: true,
      },
    ]);
    expect(hasPendingCodexCommand(threadId)).toBe(true);

    finishCodexSlashCommand(threadId, command, lifecycle, "error", "failed");
    projection = useAgentSessionStore.getState().threadProjections[threadId];
    expect(projection?.messages[0]).toMatchObject({
      content: command,
      isLoading: false,
      isCompleted: true,
    });
    expect(hasPendingCodexCommand(threadId)).toBe(false);

    useAgentSessionStore.getState().removeThreadProjection(threadId);
  });
});
