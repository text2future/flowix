import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadgeHoverCard } from "./badge-hover-card";

const cloudMocks = vi.hoisted(() => ({
  getState: vi.fn(),
  getAiCreditBalance: vi.fn(),
}));
vi.mock("@platform/tauri/client", () => ({ cloud: cloudMocks }));

vi.mock("@features/agent/store/agent-data-store", () => ({
  useAgentDataStore: (selector: (state: unknown) => unknown) => selector({ agents: { pi: { catalog: { models: { items: [
    { id: "flowix-cn-1/gpt-6.1-terra", providerId: "flowix-cloud-member", source: "flowix-cloud", label: "GPT-6.1 Terra" },
  ] } } } } }),
}));

vi.mock("@shared/ui/hover-card", () => ({
  HoverCard: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => createElement(
    "div",
    null,
    createElement("button", {
      "data-open": "true",
      onClick: () => onOpenChange?.(true),
    }),
    children,
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  HoverCardContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({
    language: "en-US",
    t: (key: string) =>
      key === "editor.threadCard.cwd"
        ? "Space"
        : key === "editor.threadCard.contextUsage"
          ? "Context"
          : key === "editor.threadCard.inputOutputTokens"
            ? "In/Out"
            : key === "editor.threadCard.codexPlan"
              ? "Codex plan"
              : key === "editor.threadCard.codexQuota5h"
                ? "5-hour"
                : key === "editor.threadCard.codexQuotaWeekly"
                  ? "Weekly"
            : key,
  }),
}));

describe("BadgeHoverCard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("displays the Cloud catalog title instead of the internal upstream route", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(BadgeHoverCard, {
      agentType: "pi", model: "flowix-cloud-member/flowix-cn-1/gpt-6.1-terra",
    })));
    expect(host.textContent).toContain("GPT-6.1 Terra");
    expect(host.textContent).not.toContain("flowix-cn-1");
    await act(async () => root.unmount());
  });

  it("loads and refreshes Pi member credits", async () => {
    cloudMocks.getState.mockResolvedValue({ authenticated: true });
    cloudMocks.getAiCreditBalance.mockResolvedValueOnce({ balanceMicrocredits: 1_250_000 })
      .mockResolvedValueOnce({ balanceMicrocredits: 2_500_000 });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(BadgeHoverCard, { agentType: "pi" })); });
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-open]")!.click(); });
    expect(host.textContent).toContain("1.25");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="preferences.pi.cloudCreditsRefresh"]')!.click();
    });
    expect(host.textContent).toContain("2.50");
    expect(cloudMocks.getAiCreditBalance).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("renders the persisted session id and usage synchronously", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          agentType: "dsh",
          sessionId: "provider-session-1",
          model: "deepseek-chat",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 3,
            context_used_tokens: 600,
            model_context_window: 2000,
          },
          cwd: "D:\\projects\\flowix",
        }),
      );
    });

    expect(host.textContent).toContain("provider-session-1");
    expect(host.textContent).toContain("deepseek-chat");
    expect(host.textContent).toContain("In/Out100 / 3 tok");
    expect(host.textContent).toContain("17%");
    expect(host.textContent).toContain("Context");
    expect(host.textContent).toContain("30%");
    expect(host.querySelectorAll(".agent-thread-card__hover-skeleton")).toHaveLength(0);
    expect(host.querySelector<HTMLElement>(".agent-thread-card__cwd-value")?.title).toBe(
      "D:\\projects\\flowix",
    );

    await act(async () => root.unmount());
  });

  it("does not expose a local runtime handle when no persisted session exists", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          agentType: "claudecode",
          model: "gpt-5",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
    });

    expect(host.textContent).toContain("-");
    expect(host.textContent).toContain("10 / 2 tok");
    expect(host.querySelectorAll(".agent-thread-card__hover-skeleton")).toHaveLength(0);

    await act(async () => root.unmount());
  });

  it("loads and displays Codex membership and quota data on hover", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const requestRuntimeInfo = vi.fn().mockResolvedValue({
      sessionId: "codex-session-1",
      usage: { input_tokens: 10, output_tokens: 2 },
      codex: {
        account: { planType: "plus" },
        rateLimits: {
          rateLimitsByLimitId: {
            messages: {
              primary: { usedPercent: 20, windowDurationMins: 300 },
              secondary: { usedPercent: 30, windowDurationMins: 10080 },
            },
          },
          rateLimitResetCredits: { availableCount: 2 },
        },
      },
    });

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          threadId: "codex-local-thread",
          agentType: "codex",
          onRequestRuntimeInfo: requestRuntimeInfo,
        }),
      );
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-open="true"]')?.click();
    });

    expect(requestRuntimeInfo).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("plus");
    expect(host.textContent).toContain("80%");
    expect(host.textContent).toContain("70%");
    expect(host.textContent).toContain("codex-session-1");
    expect(host.querySelector<HTMLElement>(".agent-thread-card__codex-reset-count")?.textContent)
      .toBe("2");
    expect(host.textContent).not.toContain("codex-local-thread");

    await act(async () => root.unmount());
  });

  it("hides the Codex reset count when no reset credits are available", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const requestRuntimeInfo = vi.fn().mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 2 },
      codex: {
        rateLimits: {
          rateLimitResetCredits: { availableCount: 0 },
        },
      },
    });

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          agentType: "codex",
          onRequestRuntimeInfo: requestRuntimeInfo,
        }),
      );
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-open="true"]')?.click();
    });

    expect(host.querySelector(".agent-thread-card__codex-reset-count")).toBeNull();

    await act(async () => root.unmount());
  });

  it("renders field skeletons while Codex runtime info is loading", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const requestRuntimeInfo = vi.fn().mockImplementation(
      () => new Promise(() => undefined),
    );

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          agentType: "codex",
          onRequestRuntimeInfo: requestRuntimeInfo,
        }),
      );
    });

    expect(host.querySelectorAll(".agent-thread-card__hover-skeleton").length)
      .toBeGreaterThan(0);

    await act(async () => root.unmount());
  });
});
