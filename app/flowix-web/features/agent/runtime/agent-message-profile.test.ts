import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAgentMessageProfile,
  messageBlockId,
  messageBlockIndex,
  messageDraftScope,
  messageNativeId,
} from "@features/agent/runtime/agent-message-profile";

// Vitest runs from the repo root; the jsdom environment makes
// `import.meta.url` an http URL, so resolve from cwd instead.
const AGENT_DIR = resolve(process.cwd(), "app/flowix-web/features/agent");

/** Files that decide "how an event stream becomes messages". They must read
 * `agent-message-profile` instead of branching on the runtime name. */
const MESSAGE_SEMANTICS_FILES = [
  "store/session-reducer/reduce-projection.ts",
  "store/tool-chunks.ts",
  "store/message-order.ts",
  "store/thread-history.ts",
  "events/message-identity.ts",
];

describe("agent message profiles", () => {
  it("describes Pi as an indexed-block, run-scoped runtime", () => {
    expect(getAgentMessageProfile("pi")).toMatchObject({
      nativeMessageIds: true,
      indexedBlocks: true,
      inlineToolRows: true,
      adoptsOptimisticUserRow: true,
      draftScope: "run",
      historyMerge: "pi-timeline",
      // Pi never mints fallback ids and its blocks are immutable-ish by
      // entry id, so late deltas still land in their block.
      mintsFallbackItemIds: false,
      dropsDeltasAfterCompletion: false,
      toolRowIdScheme: "tool-call",
    });
  });

  it("describes Codex as an immutable-item runtime without blocks", () => {
    expect(getAgentMessageProfile("codex")).toMatchObject({
      nativeMessageIds: true,
      indexedBlocks: false,
      inlineToolRows: false,
      adoptsOptimisticUserRow: true,
      draftScope: "none",
      historyMerge: "codex-items",
      mintsFallbackItemIds: true,
      dropsDeltasAfterCompletion: true,
      toolRowIdScheme: "codex-turn-item",
    });
  });

  it("keeps DSH on the default message model but knows it echoes prompts", () => {
    const dsh = getAgentMessageProfile("dsh");
    expect(dsh.echoesInjectedPrompts).toBe(true);
    expect(dsh.nativeMessageIds).toBe(false);
    expect(dsh.indexedBlocks).toBe(false);
    expect(dsh.historyMerge).toBe("sequence");
  });

  it("falls back to the conservative profile for unknown or missing runtimes", () => {
    const fallback = getAgentMessageProfile(undefined);
    expect(fallback).toMatchObject({
      nativeMessageIds: false,
      indexedBlocks: false,
      inlineToolRows: false,
      adoptsOptimisticUserRow: false,
      draftScope: "none",
      historyMerge: "sequence",
      toolRowIdScheme: "tool-call",
      echoesInjectedPrompts: false,
    });
    expect(getAgentMessageProfile("nope" as never)).toEqual(fallback);
    expect(getAgentMessageProfile("claudecode")).toEqual(fallback);
  });
});

describe("profile accessors", () => {
  const pi = getAgentMessageProfile("pi");
  const codex = getAgentMessageProfile("codex");

  it("only block-scopes ids for indexed-block runtimes", () => {
    expect(messageBlockId(pi, "entry-1", 2)).toBe("entry-1:block:2");
    expect(messageBlockId(pi, "entry-1", undefined)).toBe("entry-1");
    expect(messageBlockId(pi, undefined, 2)).toBeUndefined();
    expect(messageBlockId(codex, "item-1", 2)).toBe("item-1");
  });

  it("only reports a block index for indexed-block runtimes", () => {
    expect(messageBlockIndex(pi, 3)).toBe(3);
    expect(messageBlockIndex(codex, 3)).toBeUndefined();
  });

  it("only run-scopes drafts when the runtime says so", () => {
    expect(messageDraftScope(pi, "run-1")).toBe("run-1");
    expect(messageDraftScope(codex, "run-1")).toBeUndefined();
  });

  it("only exposes native ids when they are stable across live and history", () => {
    expect(messageNativeId(pi, "entry-1")).toBe("entry-1");
    expect(messageNativeId(codex, "item-1")).toBe("item-1");
    expect(messageNativeId(getAgentMessageProfile("hermes"), "x")).toBeUndefined();
  });
});

describe("message semantics stay in the profile", () => {
  const RUNTIME_BRANCH = /(agentType|runtime|typeKey)\s*(?:===|!==)\s*["'](codex|claudecode|hermes|pi|opencode|dsh)["']/;

  it.each(MESSAGE_SEMANTICS_FILES)(
    "%s has no runtime-name branch",
    (relativePath) => {
      const source = readFileSync(resolve(AGENT_DIR, relativePath), "utf8");
      const offending = source
        .split("\n")
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => RUNTIME_BRANCH.test(line));

      expect(offending).toEqual([]);
    },
  );
});
