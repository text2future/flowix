import { describe, expect, it } from "vitest";
import type { AgentTypeKey } from "@/types/agent";
import {
  isKnownProductThreadId,
  resolveExternalChunkThreadId,
  resolveProductThreadId,
  resolveStoreThreadId,
} from "@features/agent/store/external-session";

describe("product thread identity", () => {
  const resolutions = { "codex-thread": "shared-native", "pi-thread": "shared-native" };
  const threadTypes: Record<string, AgentTypeKey> = {
    "codex-thread": "codex", "pi-thread": "pi",
  };

  it("scopes native aliases to their runtime", () => {
    expect(resolveProductThreadId("shared-native", resolutions, "codex", threadTypes)).toBe("codex-thread");
    expect(resolveProductThreadId("shared-native", resolutions, "pi", threadTypes)).toBe("pi-thread");
    expect(resolveExternalChunkThreadId({
      kind: "text", thread_id: "shared-native", agent_type: "pi", text: "hello",
    }, resolutions, threadTypes)).toBe("pi-thread");
  });

  it("keeps known product ids even when they equal native ids", () => {
    const known = (id: string) => id === "shared-native";
    expect(resolveProductThreadId("shared-native", resolutions, "codex", threadTypes, known))
      .toBe("shared-native");
    expect(resolveStoreThreadId("shared-native", resolutions, "codex", threadTypes, known))
      .toBe("shared-native");
  });

  it("rejects native ids that cannot be resolved uniquely", () => {
    const ambiguous = { first: "native", second: "native" };
    const types: Record<string, AgentTypeKey> = { first: "codex", second: "codex" };
    expect(resolveStoreThreadId("native", ambiguous, "codex", types)).toBeNull();
    expect(resolveStoreThreadId("first", ambiguous, "codex", types)).toBe("first");
    expect(resolveStoreThreadId("new-product", ambiguous, "codex", types)).toBe("new-product");
  });

  it("recognizes product ids from their current owners", () => {
    expect(isKnownProductThreadId("projected", {
      sessionMeta: { activeThreadIds: {}, threadLists: {}, externalSessionResolutions: {} },
      threadProjections: { projected: {} },
    })).toBe(true);
  });
});
