import { beforeEach, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ getFeatures: vi.fn(), clearLegacyCodeMode: vi.fn(), chatStream: vi.fn() }));
vi.mock("@platform/tauri/client", () => ({ piModels: backend, agentAccess: {} }));
vi.mock("./agent-client", () => ({ agentClient: backend }));
vi.mock("@features/agent/runtime/workspace-snapshot", () => ({
  normalizeWorkspaceSnapshot: () => null,
  markConversationWorkspaceStarted: vi.fn(),
}));
vi.mock("@features/agent/runtime/conversation-workspace", () => ({ normalizeConversationWorkspaceState: () => null }));

import { dispatchChatStream } from "./chat-stream";
import { useAgentDataStore } from "./agent-data-store";

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useAgentDataStore.setState(useAgentDataStore.getInitialState(), true);
  useAgentDataStore.setState({ legacyPreferencesMigrated: true });
  backend.getFeatures.mockResolvedValue({ toolSearch: false, legacyCodeMode: false });
  backend.clearLegacyCodeMode.mockResolvedValue(undefined);
  backend.chatStream.mockResolvedValue(undefined);
});

const input = {
  threadId: "pi-thread", content: "hello", llmContent: "hello", runId: "run",
  userPayload: { llmContent: "hello", systemReminderDirectory: "/notes" },
  agentType: "pi" as const,
};

type PiBlock = { pi?: { model?: string; providerId?: string } };

function sentPiBlock(): PiBlock {
  const payload = backend.chatStream.mock.calls[backend.chatStream.mock.calls.length - 1]![1] as { runtimeConfig: PiBlock };
  return payload.runtimeConfig;
}

it("sends the picked Cloud model even when the snapshot still holds the BYOK one", async () => {
  // A conversation that already ran keeps the model it was frozen with. Pi's
  // model is shared, so a later pick has to win over that snapshot — otherwise
  // the picker shows the new model while the run keeps the previous one.
  const frozen = { model: { key: "deepseek-flash", providerId: "deepseek" } };
  useAgentDataStore.getState().setUserPreference("pi", {
    model: { id: "deepseek-flash", providerId: "flowix-cloud-member" },
  });

  await dispatchChatStream({ ...input, runtimeConfig: frozen });

  expect(sentPiBlock().pi?.model).toBe("deepseek-flash");
  expect(sentPiBlock().pi?.providerId).toBe("flowix-cloud-member");
});

it("sends the picked model when the conversation has no snapshot yet", async () => {
  useAgentDataStore.getState().setUserPreference("pi", {
    model: { id: "deepseek-v4-pro", providerId: "flowix-cloud-member" },
  });

  await dispatchChatStream({ ...input, runtimeConfig: {} });

  expect(sentPiBlock().pi?.model).toBe("deepseek-v4-pro");
  expect(sentPiBlock().pi?.providerId).toBe("flowix-cloud-member");
});
