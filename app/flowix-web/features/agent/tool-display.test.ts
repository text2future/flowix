import { describe, expect, it } from "vitest";

import {
  createAgentToolDisplay,
  formatAgentPlanSummary,
  parseAgentCommandInput,
  parseAgentPlan,
  parseAgentPatch,
  parseAgentRequestUserInput,
} from "@features/agent/tool-display";

describe("parseAgentCommandInput", () => {
  it("splits command chains into display items without losing operators", () => {
    const r = parseAgentCommandInput({
      command: 'cd app && npm run build || echo "build failed"',
    });
    expect(r?.items.map((item) => item.op)).toEqual([
      undefined,
      "&&",
      "||",
    ]);
    expect(r?.items.map((item) => item.command)).toEqual([
      "cd",
      "npm",
      "echo",
    ]);
    expect(r?.items[1].args).toEqual(["run", "build"]);
    expect(r?.items[2].args).toEqual(["build failed"]);
  });

  it("keeps quoted separators inside the same argument", () => {
    const r = parseAgentCommandInput({
      command: 'printf "a && b | c" | head -1',
    });
    expect(r?.items.length).toBe(2);
    expect(r?.items[0]).toMatchObject({
      command: "printf",
      args: ["a && b | c"],
    });
    expect(r?.items[1]).toMatchObject({
      op: "|",
      command: "head",
      args: ["-1"],
    });
  });

  it("unwraps generic shell wrapper payloads", () => {
    const r = parseAgentCommandInput({
      command:
        "/bin/zsh -lc 'ls -la /Users/rop/Desktop/flowix-main | head -5'",
    });
    expect(r?.items[0].command).toBe("/bin/zsh");
    expect(r?.items[0].wrapper?.label).toBe("/bin/zsh -lc");
    expect(r?.items[0].wrapper?.payload.items.map((item) => item.command))
      .toEqual(["ls", "head"]);
    expect(r?.items[0].wrapper?.payload.items[1].op).toBe("|");
  });

  it("finds payload through env / sudo style prefixes", () => {
    const r = parseAgentCommandInput({
      command: "sudo env NODE_ENV=production bash -lc 'npm run build'",
    });
    expect(r?.items[0].command).toBe("sudo");
    expect(r?.items[0].wrapper?.label).toBe(
      "sudo env NODE_ENV=production bash -lc",
    );
    expect(r?.items[0].wrapper?.payload.items[0]).toMatchObject({
      command: "npm",
      args: ["run", "build"],
    });
  });

  it("recognizes env assignments before the executable", () => {
    const r = parseAgentCommandInput({
      command: "NODE_ENV=production npm run build",
    });
    expect(r?.items[0]).toMatchObject({
      command: "npm",
      env: ["NODE_ENV=production"],
      args: ["run", "build"],
    });
  });

  it("does not split ampersands inside shell redirections", () => {
    const r = parseAgentCommandInput({
      command: "sudo -n true 2>&1",
    });
    expect(r?.items).toHaveLength(1);
    expect(r?.items[0]).toMatchObject({
      command: "sudo",
      args: ["-n", "true", "2>&1"],
    });
  });

  it("does not split operators inside command substitution", () => {
    const r = parseAgentCommandInput({
      command: "echo $(git status | head -1) && pwd",
    });
    expect(r?.items).toHaveLength(2);
    expect(r?.items[0]).toMatchObject({
      command: "echo",
      args: ["$(git status | head -1)"],
    });
    expect(r?.items[1]).toMatchObject({
      op: "&&",
      command: "pwd",
      args: [],
    });
  });

  it("does not split operators inside process substitution", () => {
    const r = parseAgentCommandInput({
      command: "diff <(sort a | uniq) <(sort b | uniq)",
    });
    expect(r?.items).toHaveLength(1);
    expect(r?.items[0]).toMatchObject({
      command: "diff",
      args: ["<(sort a | uniq)", "<(sort b | uniq)"],
    });
  });

  it("does not split operators inside test expressions", () => {
    const r = parseAgentCommandInput({
      command: "[ -f package.json ] && npm test",
    });
    expect(r?.items).toHaveLength(2);
    expect(r?.items[0]).toMatchObject({
      command: "[ -f package.json ]",
      args: [],
    });
    expect(r?.items[1]).toMatchObject({
      op: "&&",
      command: "npm",
      args: ["test"],
    });
  });

  it("accepts JSON-string command input", () => {
    const r = parseAgentCommandInput('{"command":"npm test -- --runInBand"}');
    expect(r?.items[0]).toMatchObject({
      command: "npm",
      args: ["test", "--", "--runInBand"],
    });
  });

  it("normalizes Flowix shell command tools to command display", () => {
    expect(
      createAgentToolDisplay({
        agentType: "flowix",
        toolName: "shell",
        input: { command: "npm run build" },
      }),
    ).toMatchObject({
      kind: "command",
      summary: "npm run build",
    });
  });

  it("normalizes Claude Code Bash command tools to command display", () => {
    expect(
      createAgentToolDisplay({
        agentType: "claude",
        toolName: "Bash",
        input: { command: "npm test", description: "run tests" },
      }),
    ).toMatchObject({
      kind: "command",
      summary: "npm test",
    });
  });

  it("normalizes Hermes run_command style tools to command display", () => {
    expect(
      createAgentToolDisplay({
        agentType: "hermes",
        toolName: "run_command",
        input: { command_text: "cargo test" },
      }),
    ).toMatchObject({
      kind: "command",
      summary: "cargo test",
    });
    expect(parseAgentCommandInput({ command_text: "cargo test" })?.items[0])
      .toMatchObject({
        command: "cargo",
        args: ["test"],
      });
  });
});

describe("parseAgentPlan", () => {
  it("returns null on empty / non-array input", () => {
    expect(parseAgentPlan(undefined)).toBeNull();
    expect(parseAgentPlan({})).toBeNull();
    expect(parseAgentPlan({ plan: [] })).toBeNull();
    expect(parseAgentPlan({ plan: "nope" })).toBeNull();
    expect(parseAgentPlan(null)).toBeNull();
    expect(parseAgentPlan(42)).toBeNull();
  });

  it("accepts canonical Codex update_plan shape", () => {
    const r = parseAgentPlan({
      plan: [
        { status: "completed", step: "a" },
        { status: "in_progress", step: "b" },
        { status: "pending", step: "c" },
      ],
    });
    expect(r?.plan).toEqual([
      { status: "completed", step: "a" },
      { status: "in_progress", step: "b" },
      { status: "pending", step: "c" },
    ]);
  });

  it("normalizes common status aliases (case-insensitive)", () => {
    const r = parseAgentPlan({
      plan: [
        { status: "Done", step: "a" },
        { status: "in-progress", step: "b" },
        { status: "QUEUED", step: "c" },
      ],
    });
    expect(r?.plan.map((s) => s.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  it("recovers plan nested under input / arguments / data / payload", () => {
    expect(
      parseAgentPlan({ input: { plan: [{ status: "completed", step: "x" }] } })
        ?.plan.length,
    ).toBe(1);
    expect(
      parseAgentPlan({ arguments: { plan: [{ status: "completed", step: "x" }] } })
        ?.plan.length,
    ).toBe(1);
    expect(
      parseAgentPlan({ data: { plan: [{ status: "completed", step: "x" }] } })
        ?.plan.length,
    ).toBe(1);
  });

  it("falls back to step / content / title / text / label fields", () => {
    const r = parseAgentPlan({
      todos: [
        { state: "in_progress", content: "via content" },
        { status: "pending", title: "via title" },
        { status: "pending", text: "via text" },
      ],
    });
    expect(r?.plan.map((s) => s.step)).toEqual([
      "via content",
      "via title",
      "via text",
    ]);
  });

  it("treats step without status as pending", () => {
    const r = parseAgentPlan({
      plan: [{ step: "loose" }, { step: 42 }, { step: "  spaced  " }],
    });
    expect(r?.plan).toEqual([{ status: "pending", step: "loose" }, { status: "pending", step: "spaced" }]);
  });

  it("accepts top-level array as input", () => {
    const r = parseAgentPlan([
      { status: "in_progress", step: "x" },
    ]);
    expect(r?.plan.length).toBe(1);
  });
});

describe("formatAgentPlanSummary", () => {
  it("returns empty string when no plan", () => {
    expect(formatAgentPlanSummary(undefined)).toBe("");
  });

  it("formats count and current step in zh-CN", () => {
    const out = formatAgentPlanSummary(
      {
        plan: [
          { status: "completed", step: "a" },
          { status: "in_progress", step: "b" },
          { status: "pending", step: "c" },
        ],
      },
      "zh-CN",
    );
    expect(out).toBe("1/3 · 正在做：b");
  });

  it("formats count and current step in en-US", () => {
    const out = formatAgentPlanSummary(
      {
        plan: [
          { status: "completed", step: "a" },
          { status: "in_progress", step: "build it" },
          { status: "pending", step: "c" },
        ],
      },
      "en-US",
    );
    expect(out).toBe("1/3 · Working on：build it");
  });

  it("falls back to count only when no in_progress step", () => {
    expect(
      formatAgentPlanSummary({
        plan: [
          { status: "completed", step: "a" },
          { status: "pending", step: "b" },
        ],
      }),
    ).toBe("1/2");
  });
});

describe("parseAgentPatch", () => {
  it("returns [] for non-string / empty command", () => {
    expect(parseAgentPatch(undefined)).toEqual([]);
    expect(parseAgentPatch({})).toEqual([]);
    expect(parseAgentPatch({ command: "" })).toEqual([]);
    expect(parseAgentPatch({ command: 42 })).toEqual([]);
  });

  it("parses a single Update File entry", () => {
    const r = parseAgentPatch({
      command:
        "apply_patch\n*** Begin Patch\n*** Update File: /Users/rop/Desktop/foo.tsx\n@@\n-old\n+new\n*** End Patch",
    });
    expect(r).toEqual([{ action: "update", path: "/Users/rop/Desktop/foo.tsx" }]);
  });

  it("parses Add / Delete / Move", () => {
    const r = parseAgentPatch({
      command:
        "*** Begin Patch\n*** Add File: /a/b/new.ts\n*** Delete File: /a/b/old.ts\n*** Move to: /a/b/dest.ts\n*** End Patch",
    });
    expect(r.map((e) => e.action)).toEqual(["add", "delete", "move"]);
  });

  it("tolerates missing 'apply_patch' / 'Begin Patch' / 'End Patch' markers", () => {
    const r = parseAgentPatch({ command: "*** Update File: /x.ts\n-old\n+new" });
    expect(r).toEqual([{ action: "update", path: "/x.ts" }]);
  });
});

describe("parseAgentRequestUserInput", () => {
  it("returns null on missing or empty questions", () => {
    expect(parseAgentRequestUserInput(undefined)).toBeNull();
    expect(parseAgentRequestUserInput({})).toBeNull();
    expect(parseAgentRequestUserInput({ questions: [] })).toBeNull();
    expect(
      parseAgentRequestUserInput({ questions: "nope" as unknown as never }),
    ).toBeNull();
  });

  it("parses a single question with options", () => {
    const r = parseAgentRequestUserInput({
      questions: [
        {
          header: "下拉按钮标题",
          id: "title_content",
          question: "标题显示什么?",
          options: [
            { label: "当前选中名", description: "显示当前激活的笔记本名" },
            { label: "固定文字" },
          ],
        },
      ],
    });
    expect(r?.questions.length).toBe(1);
    expect(r?.questions[0].options.length).toBe(2);
    expect(r?.questions[0].options[0].description).toBe(
      "显示当前激活的笔记本名",
    );
  });

  it("parses multi-question payload", () => {
    const r = parseAgentRequestUserInput({
      questions: [
        {
          header: "Q1",
          id: "q1",
          question: "1?",
          options: [
            { label: "A" },
            { label: "B" },
          ],
        },
        {
          header: "Q2",
          id: "q2",
          question: "2?",
          options: [
            { label: "X" },
            { label: "Y" },
            { label: "Z" },
          ],
        },
      ],
    });
    expect(r?.questions.length).toBe(2);
    expect(r?.questions[0].options.length).toBe(2);
    expect(r?.questions[1].options.length).toBe(3);
  });

  it("drops malformed questions (empty question / no options)", () => {
    const r = parseAgentRequestUserInput({
      questions: [
        { id: "x", header: "h", question: "  ", options: [{ label: "A" }] },
        { id: "y", header: "h", question: "OK?", options: [] },
        { id: "z", header: "h", question: "OK?", options: [{ label: "" }] },
        {
          id: "w",
          header: "h",
          question: "Real?",
          options: [{ label: "Yes" }],
        },
      ],
    });
    expect(r?.questions.length).toBe(1);
    expect(r?.questions[0].id).toBe("w");
  });

  it("truncates long header / option label", () => {
    const long = "x".repeat(200);
    const r = parseAgentRequestUserInput({
      questions: [
        {
          header: long,
          id: "x",
          question: "Q?",
          options: [{ label: long, description: long }],
        },
      ],
    });
    expect(r?.questions[0].header.length).toBeLessThanOrEqual(24);
    expect(r?.questions[0].options[0].label.length).toBeLessThanOrEqual(
      40,
    );
  });
});
