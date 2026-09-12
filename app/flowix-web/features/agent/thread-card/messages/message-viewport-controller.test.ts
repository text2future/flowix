import { describe, expect, it, vi } from "vitest";
import { MessageViewportController } from "@features/agent/thread-card/messages/message-viewport-controller";

function createController() {
  const body = document.createElement("div");
  Object.defineProperties(body, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1000 },
  });

  return {
    body,
    controller: new MessageViewportController({
      body,
      bottomFollowThresholdPx: 64,
      topHistoryLoadThresholdPx: 64,
      scrollDeltaEpsilonPx: 2,
      isCollapsed: () => false,
      isFullscreen: () => false,
      getRuntimeThreadId: () => null,
      getConversationMessageState: () => null,
      loadMoreMessages: vi.fn(),
    }),
  };
}

describe("MessageViewportController run-end scroll behavior", () => {
  it("preserves an upward reading position when streaming ends", () => {
    const { body, controller } = createController();
    body.scrollTop = 300;
    controller.handleScroll();

    const scrollState = controller.captureRenderScrollState();
    body.scrollTop = 0;
    controller.applyAfterRender({ isLoading: false, ...scrollState });

    expect(body.scrollTop).toBe(300);
  });

  it("continues following the bottom when the user was already there", () => {
    const { body, controller } = createController();
    body.scrollTop = 600;
    controller.handleScroll();

    const scrollState = controller.captureRenderScrollState();
    body.scrollTop = 0;
    controller.applyAfterRender({ isLoading: false, ...scrollState });

    expect(body.scrollTop).toBe(1000);
  });

  it("detaches from the bottom on a small upward wheel gesture", () => {
    const { body, controller } = createController();
    body.scrollTop = 600;
    controller.handleScroll();

    controller.handleUserScrollIntent(-12);
    const scrollState = controller.captureRenderScrollState();
    body.scrollTop = 0;
    controller.applyAfterRender({ isLoading: true, ...scrollState });

    expect(body.scrollTop).toBe(600);
  });
});
