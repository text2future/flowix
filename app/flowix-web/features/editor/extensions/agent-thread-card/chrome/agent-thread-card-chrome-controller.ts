import type { EditorView } from "@tiptap/pm/view";
import type { AgentTypeKey } from "@/types/agent";
import type { I18nKey } from "@features/i18n";
import type { ThreadState } from "@features/agent/store/chat-store";
import type { AgentConversationRun } from "@features/agent/store/agent-conversation-store";
import { AgentThreadCardHeaderChromeController } from "@features/editor/extensions/agent-thread-card/chrome/header-chrome-controller";
import { AgentThreadCardTitleEditController } from "@features/editor/extensions/agent-thread-card/chrome/title-edit-controller";
import { AgentThreadCardBadgeChromeController } from "@features/editor/extensions/agent-thread-card/chrome/badge-chrome-controller";

export interface AgentThreadCardChromeControllerOptions {
  dom: HTMLElement;
  header: HTMLDivElement;
  titleEl: HTMLElement;
  badgeEl: HTMLSpanElement;
  badgeIcon: HTMLImageElement;
  badgeName: HTMLSpanElement;
  badgeHoverCardMount: HTMLSpanElement;
  view: EditorView;
  getPos: () => number | undefined;
  getNodeSize: () => number;
  isFullscreen: () => boolean;
  closeTransientUi: () => void;
  dragThresholdPx: number;
  getAttrTitle: () => string | null;
  getAttrTypeKey: () => string | null;
  getInstanceTitle: () => string | undefined;
  getThreadId: () => string | null;
  getInstanceId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  getThreadState: () => ThreadState | undefined;
  getPersistedRun: () => AgentConversationRun | undefined;
  updateAttrs: (attrs: Record<string, unknown>) => void;
  t: (key: I18nKey) => string;
}

export class AgentThreadCardChromeController {
  private readonly header: AgentThreadCardHeaderChromeController;
  private readonly title: AgentThreadCardTitleEditController;
  private readonly badge: AgentThreadCardBadgeChromeController;

  constructor(options: AgentThreadCardChromeControllerOptions) {
    this.header = new AgentThreadCardHeaderChromeController({
      dom: options.dom,
      header: options.header,
      view: options.view,
      getPos: options.getPos,
      getNodeSize: options.getNodeSize,
      isFullscreen: options.isFullscreen,
      closeTransientUi: options.closeTransientUi,
      dragThresholdPx: options.dragThresholdPx,
    });
    this.title = new AgentThreadCardTitleEditController({
      titleEl: options.titleEl,
      getAttrTitle: options.getAttrTitle,
      getAttrTypeKey: options.getAttrTypeKey,
      getInstanceTitle: options.getInstanceTitle,
      getThreadId: options.getThreadId,
      getInstanceId: options.getInstanceId,
      getTypeKey: options.getTypeKey,
      updateAttrs: options.updateAttrs,
      t: options.t,
    });
    this.badge = new AgentThreadCardBadgeChromeController({
      badgeEl: options.badgeEl,
      badgeIcon: options.badgeIcon,
      badgeName: options.badgeName,
      hoverCardMount: options.badgeHoverCardMount,
      getThreadId: options.getThreadId,
      getThreadState: options.getThreadState,
      getPersistedRun: options.getPersistedRun,
      getTypeKey: options.getTypeKey,
      isFullscreen: options.isFullscreen,
    });
  }

  get activeTitleInput(): HTMLInputElement | null {
    return this.title.activeInput;
  }

  getTitle(): string {
    return this.title.getTitle();
  }

  attach(): void {
    this.header.attach();
    this.badge.renderHoverCard();
  }

  startTitleEdit(): void {
    this.title.startEdit();
  }

  syncTitleText(): void {
    this.title.syncTitleText();
  }

  refreshBadge(): void {
    this.badge.refreshBadge();
  }

  syncRuntimeBadge(): void {
    this.badge.syncRuntimeState();
  }

  renderBadgeHoverCard(): void {
    this.badge.renderHoverCard();
  }

  syncBadgeHoverCardPosition(): void {
    this.badge.syncHoverCardPosition();
  }

  dispose(): void {
    this.header.dispose();
    this.badge.dispose();
  }
}
