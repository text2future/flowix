import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { type ThreadState } from "@features/agent/store/thread-runtime-state";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { normalizeAgentRuntimeStatus } from "@features/agent/runtime/agent-runtime-status";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { BadgeHoverCard } from "@features/agent/thread-card/badge-hover-card";
import { computeAgentThreadCardBadgeData } from "@features/agent/thread-card/runtime/run-status-presenter";
import { createRuntimeInfoRequester } from "@features/agent/thread-card/runtime/runtime-info-requester";
import { getResolvedExternalSessionId } from "@features/agent/services/external-agent-runtime-service";
import { isThemeAdaptiveAgentIcon } from "@features/agent/components/agent-icon";

export interface AgentThreadCardBadgeChromeControllerOptions {
  badgeEl: HTMLSpanElement;
  badgeIcon: HTMLSpanElement;
  badgeName: HTMLSpanElement;
  hoverCardMount: HTMLSpanElement;
  getThreadId: () => string | null;
  getSessionId: () => string | null;
  getThreadState: () => ThreadState | undefined;
  getTypeKey: () => AgentTypeKey;
  getCwd: () => string | null;
}

export class AgentThreadCardBadgeChromeController {
  private readonly badgeEl: HTMLSpanElement;
  private readonly badgeIcon: HTMLSpanElement;
  private readonly badgeName: HTMLSpanElement;
  private readonly hoverCardMount: HTMLSpanElement;
  private readonly hoverCardRoot: Root;
  private readonly getThreadId: () => string | null;
  private readonly getSessionId: () => string | null;
  private readonly getThreadState: () => ThreadState | undefined;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly getCwd: () => string | null;
  private hoverCardPositionFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  private readonly handleViewportChange = (): void => {
    if (this.disposed || this.hoverCardPositionFrame !== null) return;
    this.hoverCardPositionFrame = window.requestAnimationFrame(() => {
      this.hoverCardPositionFrame = null;
      this.syncHoverCardPosition();
    });
  };

  constructor(options: AgentThreadCardBadgeChromeControllerOptions) {
    this.badgeEl = options.badgeEl;
    this.badgeIcon = options.badgeIcon;
    this.badgeName = options.badgeName;
    this.hoverCardMount = options.hoverCardMount;
    this.hoverCardRoot = createRoot(options.hoverCardMount);
    this.getThreadId = options.getThreadId;
    this.getSessionId = options.getSessionId;
    this.getThreadState = options.getThreadState;
    this.getTypeKey = options.getTypeKey;
    this.getCwd = options.getCwd;
  }

  refreshBadge(): void {
    const type = getAgentType(this.getTypeKey());
    this.badgeIcon.style.setProperty("--agent-icon-src", `url("${type.icon}")`);
    this.badgeIcon.classList.toggle(
      "agent-icon--masked",
      isThemeAdaptiveAgentIcon(type.key),
    );
    this.badgeIcon.classList.toggle(
      "agent-type-badge__icon--image",
      !isThemeAdaptiveAgentIcon(type.key),
    );
    this.badgeIcon.classList.toggle("agent-icon--pi", type.key === "pi");
    this.badgeName.textContent = type.name;
    this.syncRuntimeState();
    // Conversation instances may hydrate after the NodeView is mounted. Repaint
    // the already-mounted React tree so the persisted session id becomes
    // visible without waiting for another hover or a network lookup.
    this.renderHoverCardContent();
  }

  syncRuntimeState(): void {
    const type = getAgentType(this.getTypeKey());
    const runtime = useAgentRuntimeStore.getState();
    const status = normalizeAgentRuntimeStatus(
      runtime.statusByType[type.key],
      runtime.isChecking,
    );
    const unavailable = status.state === "not-installed" || status.state === "not-ready";
    this.badgeEl.classList.toggle("agent-type-badge--unavailable", unavailable);
    this.badgeIcon.classList.toggle(
      "agent-type-badge__icon--unavailable",
      unavailable,
    );
    this.badgeEl.title = unavailable
      ? (status.reason ?? `${type.name} is unavailable`)
      : type.desc;
  }

  /**
   * 把 hover-card 内容挂到 mount 节点 ── 挂一次就够,组件本身用 HoverCard 自己的
   * openDelay / closeDelay 控制显隐。每次 `syncHoverCardPosition` 跑完会保证
   * trigger 覆盖在 badge 上,用户 hover 触发即可。
   *
   * 旧版这里 gate 在 `isFullscreen()` 后面,非全屏时返回 null 清空 React 树 ──
   * 那个限制是为了避免 mount 节点在 collapsed 卡片里的 0 尺寸触发 HoverCard 报
   * 错;现在 trigger 是 `position: absolute; inset: 0` 永远跟 badge 同尺寸,
   * 全屏 / 非全屏都可以挂,故直接 mount 不再 bailed out。
   */
  renderHoverCard(): void {
    if (this.disposed) return;
    this.renderHoverCardContent();
  }

  attachHoverCardPositioning(): void {
    if (this.disposed) return;
    window.addEventListener("resize", this.handleViewportChange);
    document.addEventListener("scroll", this.handleViewportChange, true);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.handleViewportChange);
      this.resizeObserver.observe(this.badgeEl);
    }
    this.handleViewportChange();
  }

  /**
   * 把 mount 节点固定定位到 badge 的 viewport 矩形 ── trigger 是 absolute
   * inset:0,跟着 mount 的位置覆盖整个 badge。使用 viewport 坐标不依赖
   * offsetParent; 后者在 NodeView 初次挂载、编辑器切换可见性时可能为空或尚未稳定。
   */
  syncHoverCardPosition(): void {
    const badgeRect = this.badgeEl.getBoundingClientRect();
    // Hidden editors report a zero rect. Keep the previous valid position and
    // let ResizeObserver/viewport events retry once the card becomes visible.
    if (badgeRect.width <= 0 || badgeRect.height <= 0) return;
    this.hoverCardMount.style.position = "fixed";
    this.hoverCardMount.style.top = `${badgeRect.top}px`;
    this.hoverCardMount.style.left = `${badgeRect.left}px`;
    this.hoverCardMount.style.width = `${badgeRect.width}px`;
    this.hoverCardMount.style.height = `${badgeRect.height}px`;
    this.hoverCardMount.style.display = "block";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.handleViewportChange);
    document.removeEventListener("scroll", this.handleViewportChange, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.hoverCardPositionFrame !== null) {
      window.cancelAnimationFrame(this.hoverCardPositionFrame);
      this.hoverCardPositionFrame = null;
    }
    // 推迟到下一个 microtask 再 unmount React root ── ProseMirror destroy 可能
    // 在 React commit phase / passive effects 内被调用, 此时同步 unmount 会触发
    // "Attempted to synchronously unmount a root while React was already rendering"。
    const root = this.hoverCardRoot;
    queueMicrotask(() => {
      root.unmount();
    });
  }

  private renderHoverCardContent(): void {
    if (this.disposed) return;
    const threadId = this.getThreadId() ?? "";
    const sessionId =
      this.getSessionId() ??
      (threadId ? getResolvedExternalSessionId(threadId) : null);
    const typeKey = this.getTypeKey();
    const { model, usage } =
      computeAgentThreadCardBadgeData({
        threadState: this.getThreadState(),
        // Phase 4 (2026-08-02): 真源是 session-store.sessionMeta.settings.
        codexModel:
          useAgentSessionStore.getState().sessionMeta.settings.agentCodexModel,
        typeKey: this.getTypeKey(),
      });
    this.hoverCardRoot.render(
      React.createElement(BadgeHoverCard, {
        threadId: threadId || undefined,
        sessionId: sessionId ?? undefined,
        model,
        usage,
        onRequestRuntimeInfo: createRuntimeInfoRequester(
          typeKey,
          () => this.getThreadId(),
          () =>
            this.getSessionId() ??
            (this.getThreadId()
              ? getResolvedExternalSessionId(this.getThreadId()!)
              : null),
        ),
        codex: typeKey === "codex",
        cwd: this.getCwd() ?? undefined,
      }),
    );
  }
}
