import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { useChatStore, type ThreadState } from "@features/agent/store/chat-store";
import type { AgentConversationRun } from "@features/agent/store/agent-conversation-store";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { BadgeHoverCard } from "@features/editor/extensions/agent-thread-card/badge-hover-card";
import { computeAgentThreadCardBadgeData } from "@features/editor/extensions/agent-thread-card/runtime/run-status-presenter";

export interface AgentThreadCardBadgeChromeControllerOptions {
  badgeEl: HTMLSpanElement;
  badgeIcon: HTMLImageElement;
  badgeName: HTMLSpanElement;
  hoverCardMount: HTMLSpanElement;
  getThreadId: () => string | null;
  getThreadState: () => ThreadState | undefined;
  getPersistedRun: () => AgentConversationRun | undefined;
  getTypeKey: () => AgentTypeKey;
  isFullscreen: () => boolean;
}

export class AgentThreadCardBadgeChromeController {
  private readonly badgeEl: HTMLSpanElement;
  private readonly badgeIcon: HTMLImageElement;
  private readonly badgeName: HTMLSpanElement;
  private readonly hoverCardMount: HTMLSpanElement;
  private readonly hoverCardRoot: Root;
  private readonly getThreadId: () => string | null;
  private readonly getThreadState: () => ThreadState | undefined;
  private readonly getPersistedRun: () => AgentConversationRun | undefined;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly isFullscreen: () => boolean;
  private hoverCardTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AgentThreadCardBadgeChromeControllerOptions) {
    this.badgeEl = options.badgeEl;
    this.badgeIcon = options.badgeIcon;
    this.badgeName = options.badgeName;
    this.hoverCardMount = options.hoverCardMount;
    this.hoverCardRoot = createRoot(options.hoverCardMount);
    this.getThreadId = options.getThreadId;
    this.getThreadState = options.getThreadState;
    this.getPersistedRun = options.getPersistedRun;
    this.getTypeKey = options.getTypeKey;
    this.isFullscreen = options.isFullscreen;
  }

  refreshBadge(): void {
    const type = getAgentType(this.getTypeKey());
    this.badgeIcon.src = type.icon;
    this.badgeIcon.alt = type.name;
    this.badgeName.textContent = type.name;
    this.syncRuntimeState();
  }

  syncRuntimeState(): void {
    const type = getAgentType(this.getTypeKey());
    const status = useAgentRuntimeStore.getState().statusByType[type.key];
    const unavailable = status?.available === false;
    this.badgeEl.classList.toggle("agent-type-badge--unavailable", unavailable);
    this.badgeIcon.classList.toggle(
      "agent-type-badge__icon--unavailable",
      unavailable,
    );
    this.badgeEl.title = unavailable
      ? (status?.reason ?? `${type.name} is unavailable`)
      : type.desc;
  }

  renderHoverCard(): void {
    if (!this.isFullscreen()) {
      this.stopHoverCardTimer();
      this.hoverCardRoot.render(null);
      return;
    }
    this.renderHoverCardContent();
    this.startHoverCardTimer();
  }

  syncHoverCardPosition(): void {
    if (!this.isFullscreen()) {
      this.hoverCardMount.style.display = "none";
      return;
    }
    const badgeRect = this.badgeEl.getBoundingClientRect();
    const wrapRect = this.badgeEl.offsetParent?.getBoundingClientRect();
    if (!wrapRect) return;
    const top = badgeRect.top - wrapRect.top;
    const left = badgeRect.left - wrapRect.left;
    this.hoverCardMount.style.position = "absolute";
    this.hoverCardMount.style.top = `${top}px`;
    this.hoverCardMount.style.left = `${left}px`;
    this.hoverCardMount.style.width = `${badgeRect.width}px`;
    this.hoverCardMount.style.height = `${badgeRect.height}px`;
    this.hoverCardMount.style.display = "block";
  }

  dispose(): void {
    this.stopHoverCardTimer();
    this.hoverCardRoot.unmount();
  }

  private startHoverCardTimer(): void {
    if (this.hoverCardTimer !== null) return;
    this.hoverCardTimer = setInterval(() => {
      if (!this.isFullscreen()) return;
      this.renderHoverCardContent();
    }, 1000);
  }

  private stopHoverCardTimer(): void {
    if (this.hoverCardTimer === null) return;
    clearInterval(this.hoverCardTimer);
    this.hoverCardTimer = null;
  }

  private renderHoverCardContent(): void {
    const { model, lastRunAt, totalTokens } =
      computeAgentThreadCardBadgeData({
        threadState: this.getThreadState(),
        persistedRun: this.getPersistedRun(),
        codexModel: useChatStore.getState().agentCodexModel,
        typeKey: this.getTypeKey(),
      });
    this.hoverCardRoot.render(
      React.createElement(BadgeHoverCard, {
        sessionId: this.getThreadId() ?? "",
        model,
        lastRunAt,
        totalTokens,
      }),
    );
  }
}
