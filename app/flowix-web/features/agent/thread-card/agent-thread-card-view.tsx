import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type {
  EditorView,
  NodeView as ProseMirrorNodeView,
} from "@tiptap/pm/view";
import {
  type ThreadState,
} from "@features/agent/store/thread-runtime-state";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-types";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { canActOnQueuedMessage } from "@features/agent/store/follow-up-queue-slice";
import { acquireThreadInterest } from "@features/agent/store/thread-interest";
import type { ThreadProjection } from "@features/agent/store/session-reducer";
import { selectRenderableThreadMessages } from "@features/agent/store/thread-render-messages";
import { translate, type AppLanguage, type I18nKey, type I18nParams } from "@/lib/i18n";
import { createLogger } from "@/lib/logger";
import { errorMessage } from "@/lib/error-message";
import type { AgentTypeKey } from "@/types/agent";
import type { WorkspaceHostId } from "@features/workspace/public/host-api";
import { deriveThreadTitleFromPrompt, defaultThreadTitle } from "@features/agent/store/thread-titles";
import { toast } from "@/lib/toast";
import { useNoteStore } from "@features/memo/store/note-store";
import { agent } from "@platform/tauri/client/agent";
import { normalizeAgentTypeKey } from "@/lib/agent-types";
import { getCurrentAppLanguage } from "@features/preferences/public/runtime-api";
import type { AgentRuntimeSettingKind } from "@features/agent/runtime/agent-runtime-spec";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import {
  stopExternalAgentThreadCardRun,
} from "@features/agent/services/external-agent-runtime-service";
import { createFreshExternalAgentThreadId } from "@features/agent/services/external-agent-runtime-adapters";
import {
  ensureAgentThreadCardConversation,
} from "@features/agent/thread-card/agent-thread-card-submit-controller";
import {
  listDshSkills,
} from "@features/agent/services/dsh-command-service";
import {
  listCodexSkills,
} from "@features/agent/services/codex-slash-command-service";
import { listPiSkills } from "@features/agent/services/pi-slash-command-service";
import {
  createArrowBendDownRightIcon,
  createFullscreenIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";
import { createAgentThreadCardDom } from "@features/agent/thread-card/view/agent-thread-card-dom-factory";
import { AgentThreadCardChromeController } from "@features/agent/thread-card/chrome";
import { ExternalAgentSettingsController } from "@features/agent/thread-card/settings/external-agent-settings-controller";
import { NotebookAgentSettingsDialogController } from "@features/agent/thread-card/settings/notebook-agent-settings-dialog";
import { NotePickerController, type MemoRef } from "@features/agent/thread-card/note/note-picker-controller";
import { FullscreenLayoutController } from "@features/agent/thread-card/fullscreen/fullscreen-layout-controller";
import {
  ComposerController,
  ComposerSubmissionController,
  getComposerRuntimeState,
  ComposerDraftController,
  ComposerAttachmentController,
  ComposerAttachmentDocument,
  ComposerAddMenuController,
  getCurrentNotebookComposerFolders,
  type AgentThreadCardInputAttachment,
  getAgentThreadCardUserHistoryMessagesFromMessages,
} from "@features/agent/thread-card/composer";

import {
  AgentThreadCardMessagesController,
  createThreadCacheSkeleton,
} from "@features/agent/thread-card/messages";
import { AgentConversationSurfaceController } from "@features/agent/thread-card/surface/agent-conversation-surface-controller";
import { getAgentConversationRuntimeCwd } from "@features/agent/conversation-presentation";
import { openWorkspaceSurface } from "@features/workspace/public/open-surface-api";
import {
  getAgentMessageTypographyCssVars,
  useAgentMessageFontStore,
} from "@features/agent/store/agent-message-font-store";

import { acceptComposerSubmission } from "@features/agent/services/composer-submission-service";

const logger = createLogger("agent-thread-card");
import {
  AgentThreadCardRuntimeController,
  getCurrentThreadCardSource,
  renderAgentThreadCardMetaState,
} from "@features/agent/thread-card/runtime";
import {
  canSkipMessageRebuild,
  consumeEditorPopoverDismissPointer,
  extractDocumentContext,
  focusWithoutScroll,
  getEventElement,
  isAgentThreadCardInteractiveTarget,
  isAgentThreadCardSelectableMessageText,
  type ScrollSnapshot,
} from "@features/agent/thread-card/agent-thread-card-dom";
import {
  selectAgentThreadCardRuntimeView,
} from "@features/agent/thread-card/agent-thread-card-selectors";
import {
  agentFileScopePathForRuntime,
  handleAgentLinkClick,
} from "@features/agent/thread-card/link-navigation";

export { localFilePathFromAgentHref } from "@features/agent/thread-card/link-navigation";

// OS 顶部控件区高度 ── AgentThreadCard 全屏时把卡片向上探出这条带状区
// 高度, 覆盖到 webview 顶端 (而不是停在文档区顶边)。
//
//   - Windows: 36px (h-9), 来自 components/windows-titlebar-controls.tsx
//     ── 那是一个 `position: fixed; top: 0; h-9` 的覆盖层, 实际占
//     据 webview 内容顶部的 36px 高度。
//   - macOS / Linux: 0px ── OS 自带的 traffic-light / GTK decoration
//     在 webview 之外, 不占内容区。Mac 上确实有 flowix 自己的
//     document-titlebar-mac (h-12 = 48px), 但它属于"文档区内部的
//     标题栏", 全屏卡片向上探出去就把它压住了 ── 不算 OS 顶部控件区。
//
// 用 px 写死而非 var 是有意: h-9 是 Tailwind 直接出 36px 的常量, 改
// 一边就要同步改另一边, 这里保留纯数字 + 注释避免魔法值漂移。
const BOTTOM_FOLLOW_THRESHOLD_PX = 96;
const TOP_HISTORY_LOAD_THRESHOLD_PX = 48;
const FULLSCREEN_EXIT_FALLBACK_MIN_TOP_PX = 24;
const FULLSCREEN_EXIT_FALLBACK_MAX_TOP_PX = 160;
const FULLSCREEN_EXIT_FALLBACK_TOP_RATIO = 0.28;
const SCROLL_DELTA_EPSILON_PX = 0.5;
const AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT =
  "flowix:agent-thread-card-fullscreen-change";
const AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT =
  "flowix:agent-thread-card-request-fullscreen";
const AGENT_THREAD_CARD_FULLSCREEN_RESTORE_CLASS =
  "agent-thread-card--restoring-fullscreen";
const AGENT_THREAD_CARD_MESSAGE_SCROLL_ACTIVE_CLASS =
  "agent-thread-card--message-scroll-active";
const AGENT_THREAD_CARD_INPUT_DRAFT_MAX_CHARS = 500;
// inputDraft 落盘 debounce: typing 停 2s 后写入 ProseMirror attrs。
// submit / destroy / blur 会主动 flush, 避免卡片重挂载时用旧 attr 回填。
const AGENT_THREAD_CARD_DRAFT_PERSIST_DEBOUNCE_MS = 2000;

function wheelDeltaPixels(event: WheelEvent, scroller: HTMLElement): {
  deltaX: number;
  deltaY: number;
} {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    const styles = getComputedStyle(scroller);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const fontSize = Number.parseFloat(styles.fontSize) || 16;
    const lineSize = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.5;
    return { deltaX: event.deltaX * lineSize, deltaY: event.deltaY * lineSize };
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return {
      deltaX: event.deltaX * scroller.clientWidth,
      deltaY: event.deltaY * scroller.clientHeight,
    };
  }

  return { deltaX: event.deltaX, deltaY: event.deltaY };
}

function buildTitle(prompt: string, fallback: string = ""): string {
  return deriveThreadTitleFromPrompt(prompt, fallback);
}

const AGENT_THREAD_CARD_HEADER_DRAG_THRESHOLD_PX = 4;

export class AgentThreadCardView implements ProseMirrorNodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;

  private node: ProseMirrorNode;
  private view: EditorView;
  private getPos: (() => number | undefined) | undefined;
  private input: HTMLDivElement;
  private sendButtonMount: HTMLSpanElement;
  private body: HTMLElement;
  private composer: HTMLElement;
  // 输入框左侧的添加内容按钮，打开笔记、附件与设置菜单。
  private composerRoleIcon: HTMLButtonElement;
  private chrome: AgentThreadCardChromeController;
  private metaEl: HTMLElement;
  private runStatusEl: HTMLSpanElement;
  // 消息区底部 loading 指示器 ── 24px 固定高度, 始终挂在 body 末尾。
  // 容器永远在 DOM 里 (保证 24px 空间不被流式更新挤掉), 内部的文字
  // "思考中" 仅在 isLoading 为 true 时显示 ── 与面板 agent-thinking-indicator
  // 反馈保持一致。
  private loadingIndicator: HTMLDivElement;
  private queuedMessages: HTMLDivElement;
  private hydratedCodexQueueThreadId: string | null = null;
  private collapseButton: HTMLButtonElement;
  private deleteButton: HTMLButtonElement;
  private openInBrowserColumnButton: HTMLButtonElement;
  private fullscreenButton: HTMLButtonElement;
  private fullscreenLayout: FullscreenLayoutController;
  private composerDraft: ComposerDraftController;
  private composerController: ComposerController;
  private composerAttachments: ComposerAttachmentController;
  private messages: AgentThreadCardMessagesController;
  private surface: AgentConversationSurfaceController;
  private runtime: AgentThreadCardRuntimeController;
  // 全屏 / 删除按钮之间的竖向分割线 ── 非交互元素, aria-hidden 让屏幕
  // 阅读器跳过; 视觉与按钮同高 (28px), 1px var(--border) 着色。
  // 可见性与 fullscreenButton 同步 (renderFullscreenState 一起切 hidden)。
  private actionsDivider: HTMLSpanElement;
  private externalAgentSettings: ExternalAgentSettingsController;
  private externalSettingsLoadedTypeKey: AgentTypeKey | null = null;
  private notePicker: NotePickerController;
  private composerAddMenu: ComposerAddMenuController;
  private notebookAgentSettingsDialog = new NotebookAgentSettingsDialogController();
  private isCreating = false;
  private isDestroyed = false;
  private disposeBodyScrollbar: () => void = () => {};
  private disposeAgentMessageTypography: () => void = () => {};
  private readonly submission = new ComposerSubmissionController();
  private scrollToLatestButton: HTMLButtonElement;
  private interestedThreadId: string | null = null;
  private hydratingInstanceId: string | null = null;
  private instanceBindingPromise: {
    instanceId: string;
    promise: Promise<AgentConversationInstance | null>;
  } | null = null;
  private releaseThreadInterest: (() => void) | null = null;
  private isFullscreen = false;
  private isMessageScrollActive = false;
  private isViewportVisible = false;
  private visibilityObserver: IntersectionObserver | null = null;
  private fullscreenRestoreGeneration = 0;
  private fullscreenRestorePending = false;
  private fullscreenRestoreFrame: number | null = null;
  private badgePositionFrame: number | null = null;
  /** 文档引用注入回调 (旧 quick-phrases 弹窗入参已废弃, 这里留给将来扩展)。 */
  private boundHandleBodyScroll = (event: Event): void => {
    const body = event.currentTarget;
    if (body instanceof HTMLElement) {
      body.classList.toggle(
        "agent-thread-card__body--scrolled",
        body.scrollTop > SCROLL_DELTA_EPSILON_PX,
      );
    }
    this.messages.handleScroll();
  };
  private boundHandleScrollToLatest = (event: MouseEvent): void => {
    event.stopPropagation();
    this.messages.scrollToBottomSmooth();
  };
  private boundHandleRequestFullscreen = (event: Event): void => {
    const detail = (event as CustomEvent<{
      element?: HTMLElement;
      threadId?: string | null;
      host?: WorkspaceHostId;
      exitOthers?: boolean;
      persist?: boolean;
    }>).detail;
    // This request is deliberately host-scoped. Ignore legacy/unscoped
    // broadcasts so a missing host can never turn into a cross-column exit.
    const hostMatches =
      detail?.host !== undefined && detail.host === this.workspaceHost;
    const isTarget =
      hostMatches &&
      (detail?.element === this.dom ||
        (!!detail?.threadId && detail.threadId === this.threadId));

    if (isTarget) {
      this.setFullscreen(true, { persist: detail?.persist });
      return;
    }

    if (hostMatches && detail?.exitOthers !== false && this.isFullscreen) {
      this.setFullscreen(false, { persist: detail?.persist });
    }
  };
  private boundHandleCardMouseDown = (event: MouseEvent): void => {
    // 拦截左键 (0) 与右键 (2) ── 走相同的 preventDefault /
    // stopPropagation 路径, 避免 mousedown 冒泡到 ProseMirror 后把
    // 卡片设成 NodeSelection。中键 (1) 等其他按键维持原行为。
    if (this.isFullscreen) return;
    if (event.button !== 0 && event.button !== 2) return;
    const target = getEventElement(event);
    if (!target || !this.dom.contains(target)) return;

    const titleInput = this.chrome.activeTitleInput;
    if (titleInput && target !== titleInput && !titleInput.contains(target)) {
      event.preventDefault();
      event.stopPropagation();
      this.dom.classList.remove("ProseMirror-selectednode");
      titleInput.blur();
      return;
    }

    if (isAgentThreadCardInteractiveTarget(target)) {
      event.stopPropagation();
      return;
    }

    if (isAgentThreadCardSelectableMessageText(target)) {
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };
  private boundHandleOutsidePointerDown = (event: PointerEvent): void => {
    this.blurOwnedFocusForOutsidePointer(event);
  };
  private boundHandleMessageScrollModePointerDown = (event: PointerEvent): void => {
    if (this.isDestroyed || this.isFullscreen || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Node)) return;

    const bodyFrame = this.body.parentElement;
    const clickedMessageSurface =
      this.body.contains(target) ||
      (bodyFrame?.classList.contains("agent-thread-card__body-frame") === true &&
        bodyFrame.contains(target));
    this.setMessageScrollActive(clickedMessageSurface);
  };
  /**
   * A fullscreen card remains a NodeView inside the outer ProseMirror DOM.
   * The fixed positioning prevents most pointer interaction with the note,
   * but it does not prevent the outer editor from receiving a caret when a
   * browser/WebView delivers a focus or keyboard event there. Keep the guard
   * at the document capture phase so the outer editor never gets a chance to
   * create a selection. This deliberately does not call setEditable(false):
   * external document updates (including agent edits) must keep working.
   */
  private boundHandleFullscreenPointerDown = (event: PointerEvent): void => {
    if (!this.isFullscreen || !this.isOutsideFullscreenCardTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    this.focusFullscreenSurface();
  };
  private boundHandleFullscreenKeyDown = (event: KeyboardEvent): void => {
    if (!this.isFullscreen || !this.isOutsideFullscreenCardTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    this.focusFullscreenSurface();
  };
  private boundHandleFullscreenFocusIn = (event: FocusEvent): void => {
    if (!this.isFullscreen || !this.isOutsideFullscreenCardTarget(event.target)) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && this.view.dom.contains(activeElement)) {
      activeElement.blur();
    }
    this.focusFullscreenSurface();
  };
  private boundHandleInputFocus = (): void => {
    this.clearAgentThreadCardNodeSelection();
  };
  /** 当前 AppLanguage ── NodeView 不在 React 树里, 不能用 useI18n,
   *  走 user-settings-store 读最新值 (跨窗口同步跟 I18nProvider 一致)。 */
  private get language(): AppLanguage {
    return getCurrentAppLanguage();
  }

  /** 翻译: NodeView 内部所有面向用户的字符串走这里, 切换语言时由
   *  rerender 文案刷新, 不依赖 React 重渲染整张卡片。
   *  支持 I18nParams 插值 (memo.time.* 等文案走 {d}/{h}/{m}/{s} 占位符)。 */
  private t(key: I18nKey, params?: I18nParams): string {
    return translate(this.language, key, params);
  }

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos?: () => number | undefined,
    private readonly hostId: WorkspaceHostId = "main-third",
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    const domParts = createAgentThreadCardDom({
      inputDraft: this.inputDraft,
      t: (key) => this.t(key),
      onCardMouseDown: this.boundHandleCardMouseDown,
      onTitleDoubleClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.chrome.startTitleEdit();
      },
      onDeleteClick: (event) => {
        event.stopPropagation();
        const pos = this.getPos?.();
        if (pos === undefined) return;
        const tr = this.view.state.tr.delete(pos, pos + this.node.nodeSize);
        this.view.dispatch(tr);
      },
      onOpenInBrowserColumnClick: (event) => {
        event.stopPropagation();
        void this.openInBrowserColumn();
      },
      onFullscreenClick: (event) => {
        event.stopPropagation();
        this.toggleFullscreen();
      },
      onCollapseClick: (event) => {
        event.stopPropagation();
        this.toggleCollapsed();
      },
      onBodyClick: (event) => this.handleBodyClick(event),
      onBodyScroll: this.boundHandleBodyScroll,
      onBodyWheel: (event) => this.handleBodyWheel(event),
      // composer 空区域 → 输入框 focus 已由 createAgentComposerDom
      // 工厂内部挂的 pointerdown 委托统一处理 (详见
      // composer-dom-factory.ts COMPOSER_FOCUS_INTERACTIVE_SELECTOR),
      // 这里不再单独接 onComposerMouseDown ── 否则会与工厂委托重复
      // 触发, 同一次点击会跑两遍 focus, caret 闪烁。
    });

    this.dom = domParts.dom;
    const applyAgentMessageTypography = () => {
      const typography = useAgentMessageFontStore.getState();
      const cssVars = getAgentMessageTypographyCssVars(typography.fontMode, typography.sizeMode);
      this.dom.style.setProperty('--agent-message-font-family', cssVars['--agent-message-font-family']);
      this.dom.style.setProperty('--agent-message-base-font-size', cssVars['--agent-message-base-font-size']);
      this.dom.style.setProperty('--agent-message-size-scale', String(cssVars['--agent-message-size-scale']));
    };
    applyAgentMessageTypography();
    this.disposeAgentMessageTypography = useAgentMessageFontStore.subscribe((state, previous) => {
      if (state.fontMode !== previous.fontMode || state.sizeMode !== previous.sizeMode) {
        applyAgentMessageTypography();
      }
    });
    if (typeof IntersectionObserver !== "undefined") {
      this.visibilityObserver = new IntersectionObserver((entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        this.isViewportVisible = visible;
        if (visible && !this.isDestroyed) {
          this.ackReadAfterVisibleRender(!this.collapsed || this.isFullscreen, false);
        }
      });
      this.visibilityObserver.observe(this.dom);
    }
    if (this.persistedFullscreen && this.shouldRestorePersistedFullscreen()) {
      this.dom.classList.add(AGENT_THREAD_CARD_FULLSCREEN_RESTORE_CLASS);
    }
    this.chrome = new AgentThreadCardChromeController({
      dom: this.dom,
      header: domParts.header,
      titleEl: domParts.titleEl,
      badgeEl: domParts.badgeEl,
      badgeIcon: domParts.badgeIcon,
      badgeName: domParts.badgeName,
      badgeHoverCardMount: domParts.badgeHoverCardMount,
      view: this.view,
      getPos: () => this.getPos?.(),
      getNodeSize: () => this.node.nodeSize,
      isFullscreen: () => this.isFullscreen,
      closeTransientUi: () => {
        this.composerAddMenu?.close();
        this.setCodexSettingsPopoverOpen(false);
        this.notePicker.setOpen(false);
      },
      dragThresholdPx: AGENT_THREAD_CARD_HEADER_DRAG_THRESHOLD_PX,
      getAttrTitle: () => this.node.attrs.title as string | null,
      getInstanceTitle: () => this.instance?.title,
      getFirstUserMessageText: () => this.firstUserMessageText(),
      getDefaultTitle: () => defaultThreadTitle(this.typeKey),
      getThreadId: () => this.threadId,
      getSessionId: () => this.instance?.providerSessionId ?? null,
      getInstanceId: () => this.instanceId,
      getTypeKey: () => this.typeKey,
      getCwd: () => this.cwd,
      t: (key) => this.t(key),
      getThreadState: () => this.currentThreadState(),
    });
    this.chrome.attach();

    this.metaEl = domParts.metaEl;
    this.runStatusEl = domParts.runStatusEl;
    this.deleteButton = domParts.deleteButton;
    this.openInBrowserColumnButton = domParts.openInBrowserColumnButton;
    this.fullscreenButton = domParts.fullscreenButton;
    this.actionsDivider = domParts.actionsDivider;
    this.collapseButton = domParts.collapseButton;
    this.body = domParts.body;
    this.disposeBodyScrollbar = domParts.disposeBodyScrollbar;
    this.loadingIndicator = domParts.loadingIndicator;
    this.queuedMessages = domParts.queuedMessages;
    this.composer = domParts.composer;
    this.composerRoleIcon = domParts.composerRoleIcon;
    this.input = domParts.input;
    this.sendButtonMount = domParts.sendButtonMount;
    this.scrollToLatestButton = domParts.scrollToLatestButton;
    this.input.addEventListener("focus", this.boundHandleInputFocus);

    const { codexSettingsPopover, composerRolePopover, composerAddPopover } = domParts;
    this.externalAgentSettings = new ExternalAgentSettingsController({
      popover: codexSettingsPopover,
      getTypeKey: () => this.typeKey,
      getInstanceId: () => this.instanceId ?? undefined,
      getLanguage: () => this.language,
      // 全屏卡片即"独立对话面"，空状态形态随之在创建与复用判定时重算。
      getEmptyStatePresentation: () => (this.isFullscreen ? "expanded" : "inline-card"),
      t: (key, params) => this.t(key, params),
      isDestroyed: () => this.isDestroyed,
      isRunning: () => this.currentRuntimeView().isRunning,
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
      onPopoverStateChange: (open, anchor) =>
        this.composerAddMenu?.syncSettingsSubmenuState(open, anchor),
      // 常用笔记卡片 → 直接注入 composer 输入框, 与文档引用走同一条路径。
      onSelectFeaturedNote: (ref) => this.injectMemoReference(ref),
      onSelectEmptyPrompt: (prompt) => {
        this.composerController?.setHistoryValue(prompt, { persistDraft: true });
      },
      onSelectEmptySkill: (skill) => this.composerController?.selectSkill(skill),
      onOpenEmptySkills: () => this.composerController?.openSlashMenu(),
      toast: (kind, message) => toast[kind](message),
    });
    const composerModelButton = this.externalAgentSettings.createComposerModelButton();
    if (composerModelButton) {
      domParts.composerActions.append(composerModelButton);
    }
    const composerModeButton = this.externalAgentSettings.createComposerModeButton();
    if (composerModeButton) {
      domParts.composerActions.append(composerModeButton);
    }
    const composerPermissionButton = this.externalAgentSettings.createComposerPermissionButton();
    if (composerPermissionButton) {
      domParts.composerActions.append(composerPermissionButton);
    }
    const composerWorkspaceButton = this.externalAgentSettings.createComposerWorkspaceButton();
    if (composerWorkspaceButton) {
      domParts.composerActions.append(composerWorkspaceButton);
    }
    this.notePicker = new NotePickerController({
      trigger: this.composerRoleIcon,
      popover: composerRolePopover,
      // 必须把 params 透传给 this.t ── formatTimeAgo 走的是
      // t('memo.time.minutesAgo', { m }) 这种带参调用, 老 wrapper
      // (key) => this.t(key) 会丢掉 params, 让 translate 拿到 undefined,
      // 文案就只剩 "{m} 分钟前" 字面量, 数字永远不替换。
      t: (key, params) => this.t(key, params),
      isDestroyed: () => this.isDestroyed,
      injectMemoReference: (ref) => this.injectMemoReference(ref),
      onSelect: () => this.composerAddMenu.close(),
    });
    this.fullscreenLayout = new FullscreenLayoutController({
      dom: this.dom,
      isFullscreen: () => this.isFullscreen,
      isDestroyed: () => this.isDestroyed,
      minExitTopPx: FULLSCREEN_EXIT_FALLBACK_MIN_TOP_PX,
      maxExitTopPx: FULLSCREEN_EXIT_FALLBACK_MAX_TOP_PX,
      exitTopRatio: FULLSCREEN_EXIT_FALLBACK_TOP_RATIO,
      scrollDeltaEpsilonPx: SCROLL_DELTA_EPSILON_PX,
    });
    this.composerDraft = new ComposerDraftController({
      persistDelayMs: AGENT_THREAD_CARD_DRAFT_PERSIST_DEBOUNCE_MS,
      persist: (draft) => this.updateAttrs({ inputDraft: draft }),
    });
    this.composerAttachments = new ComposerAttachmentController({
      input: this.input,
      initialAttachments: this.inputAttachments,
      onChange: (attachments) => this.updateAttrs({ inputAttachments: attachments }),
      onStateChange: () => this.composerController?.setSendButtonState(),
      onError: (message) => toast.error(message),
      onLimitExceeded: (kind) => {
        toast.warning(
          this.t(
            kind === "size"
              ? "editor.threadCard.imageSizeLimit"
              : "editor.threadCard.imageCountLimit",
          ),
        );
      },
    });
    this.composerAddMenu = new ComposerAddMenuController({
      trigger: this.composerRoleIcon,
      popover: composerAddPopover,
      notePopover: composerRolePopover,
      settingsPopover: codexSettingsPopover,
      notePicker: this.notePicker,
      attachments: this.composerAttachments,
      t: (key) => this.t(key),
      isDestroyed: () => this.isDestroyed,
      settings: [
        ...(composerModelButton
          ? [{
              label: "agent.model.title" as const,
              popupRole: this.typeKey === "pi" ? "dialog" as const : "menu" as const,
              onHover: (anchor: HTMLButtonElement) =>
                this.externalAgentSettings.openComposerSettingsPopover("model", anchor),
            }]
          : []),
        ...(composerModeButton
          ? [{
              label: "agent.mode.title" as const,
              onHover: (anchor: HTMLButtonElement) =>
                this.externalAgentSettings.openComposerSettingsPopover("mode", anchor),
            }]
          : []),
        ...(composerPermissionButton
          ? [{
              label: "agent.permission.title" as const,
              onHover: (anchor: HTMLButtonElement) =>
                this.externalAgentSettings.openComposerSettingsPopover("permission", anchor),
            }]
          : []),
        ...(composerWorkspaceButton
          ? [{
              label: "agent.workspace.access" as const,
              onHover: (anchor: HTMLButtonElement) =>
                this.externalAgentSettings.openComposerWorkspacePopover(anchor),
            }]
          : []),
      ],
      showSettings: () => !this.isFullscreen,
      closeSettingsSubmenu: (anchor) =>
        this.externalAgentSettings.closeComposerSettingsPopover(anchor),
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
      openNotebookAgentSettings: () => {
        const notebookPath = this.notebookPath;
        if (notebookPath) this.notebookAgentSettingsDialog.open(notebookPath);
      },
    });
    this.runtime = new AgentThreadCardRuntimeController({
      getCurrentThreadId: () => this.threadId,
      getStoredThreadId: () =>
        (this.node.attrs.threadId as string | null) || null,
      getTypeKey: () => this.typeKey,
      getInstanceId: () => this.instanceId,
      isDestroyed: () => this.isDestroyed,
      renderThreadState: () => this.renderThreadState(),
      refreshAttrs: () => this.refreshAttrs(),
      refreshExternalAgentEmptySettings: () =>
        this.refreshExternalAgentEmptySettings(),
      isExternalSettingsOpen: () => this.externalAgentSettings.isOpen,
      renderCodexSettingsPopover: () => this.renderCodexSettingsPopover(),
      syncRuntimeBadge: () => this.chrome.syncRuntimeBadge(),
    });
    this.surface = new AgentConversationSurfaceController({
      dom: this.dom,
      body: this.body,
      loadingIndicator: this.loadingIndicator,
      composer: this.composer,
      input: this.input,
      inputDraft: this.inputDraft,
      sendButtonMount: this.sendButtonMount,
      messageOptions: {
      bottomFollowThresholdPx: BOTTOM_FOLLOW_THRESHOLD_PX,
      topHistoryLoadThresholdPx: TOP_HISTORY_LOAD_THRESHOLD_PX,
      scrollDeltaEpsilonPx: SCROLL_DELTA_EPSILON_PX,
      onAtBottomChange: (atBottom) => {
        domParts.scrollToLatestButton.hidden = atBottom || this.currentMessages().length === 0;
      },
      isDestroyed: () => this.isDestroyed,
      isCollapsed: () => this.collapsed,
      isFullscreen: () => this.isFullscreen,
      getThreadId: () => this.threadId,
      getRuntimeThreadId: () => this.runtimeThreadId,
      getConversationMessageState: () => this.currentConversationMessageState(),
      loadMoreMessages: (threadId) => {
        // Load the next history page directly into the canonical projection.
        void useAgentSessionStore
          .getState()
          .loadMoreMessages(this.typeKey, threadId);
      },
      getLanguage: () => this.language,
      getTypeKey: () => this.typeKey,
      getImageSpacePath: (filePath) => this.scopePathForLocalFile(filePath),
      getMessageCount: () => this.currentMessages().length,
      shouldLoadThreadMessages: () => this.shouldLoadThreadMessages(),
      renderThreadState: () => this.renderThreadState(),
      applyResolvedSession: (threadId, sessionId, typeKey) => {
        this.applyResolvedExternalSessionId(threadId, sessionId, typeKey);
      },
      t: (key) => this.t(key),
      createThreadCacheSkeleton: () => this.createThreadCacheSkeleton(),
      createExternalAgentEmptySettings: () =>
        this.createExternalAgentEmptySettings(),
      onForkMessage: (message) => this.forkFromMessage(message),
      },
      composerOptions: {
        draft: this.composerDraft,
        inputDraftMaxChars: AGENT_THREAD_CARD_INPUT_DRAFT_MAX_CHARS,
      getCurrentInputDraft: () => this.inputDraft,
      getUserHistoryMessages: () => this.getUserHistoryMessages(),
      getSendLabel: (label) => this.t(`editor.threadCard.${label}`),
      getRuntimeState: () => this.composerRuntimeState(),
      getHasAttachments: () => this.composerAttachments.hasAttachments,
      getHasPendingAttachments: () => this.composerAttachments.hasPending,
      agentType: this.typeKey,
      getSkillsScopeId: () => {
        const instance = this.instance;
        const runtime = instance?.runtimeConfig;
        return runtime?.notebookId
          ?? runtime?.workspaceSnapshot?.notebookId
          ?? instance?.source.notebookId
          ?? runtime?.workspaceSnapshot?.notebookPath
          ?? runtime?.cwd
          ?? undefined;
      },
      listDshSkills: async () => {
        if (this.typeKey !== "dsh") return [];
        const ensured = await this.ensureDshCommandConversation("/skill");
        return listDshSkills({
          threadId: ensured.threadId,
          runtimeConfig: ensured.runtimeConfig,
        });
      },
      listCodexSkills: async () => {
        if (this.typeKey !== "codex") return [];
        return listCodexSkills(this.notebookPath ?? "");
      },
      listPiSkills: async () => {
        if (this.typeKey !== "pi") return [];
        return listPiSkills(this.notebookPath ?? "");
      },
      listFolders: () => getCurrentNotebookComposerFolders(),
      folderGroupLabel: this.t("agent.files.referenceLocal"),
      noteGroupLabel: this.t("agent.files.projectNotes"),
      onModelSelect: () => {
        this.clearComposerAfterSettingsCommand();
        this.externalAgentSettings.openComposerModelPicker();
      },
      onPermissionSelect: () => {
        this.clearComposerAfterSettingsCommand();
        this.externalAgentSettings.openComposerPermissionPicker();
      },
      onDirectCommand: () => { void this.submit(); },
      submit: () => {
        void this.submit();
      },
      stop: () => {
        void stopExternalAgentThreadCardRun(this.runtimeHandleId, this.threadId);
      },
      },
    });
    this.messages = this.surface.messages;
    this.scrollToLatestButton.addEventListener("click", this.boundHandleScrollToLatest);
    this.composerController = this.surface.composer;
    this.composerAttachments.connectDocument(
      new ComposerAttachmentDocument(this.composerController.editorInstance),
    );
    this.composerController.setSendButtonState("");

    this.refreshAttrs();
    this.syncThreadInterest();
    this.renderThreadState();
    window.addEventListener(
      AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT,
      this.boundHandleRequestFullscreen,
    );
    document.addEventListener(
      "pointerdown",
      this.boundHandleOutsidePointerDown,
      true,
    );
    document.addEventListener(
      "pointerdown",
      this.boundHandleMessageScrollModePointerDown,
      true,
    );
    document.addEventListener(
      "pointerdown",
      this.boundHandleFullscreenPointerDown,
      true,
    );
    document.addEventListener(
      "keydown",
      this.boundHandleFullscreenKeyDown,
      true,
    );
    document.addEventListener(
      "focusin",
      this.boundHandleFullscreenFocusIn,
      true,
    );
    this.runtime.subscribe();
    this.composerController.updateMultiLineState();
    this.observeThreadCacheVisibility();
    this.requestThreadMessagesIfNeeded();
    this.runInitialPromptIfNeeded();
    queueMicrotask(() => this.ensureInstanceBinding());
    this.schedulePersistedFullscreenRestore();
  }

  private async forkFromMessage(message: ThreadState["messages"][number]): Promise<void> {
    if (!this.threadId) return;
    const isCodex = this.typeKey === "codex";
    const isDsh = this.typeKey === "dsh";
    const isPi = this.typeKey === "pi";
    if (!isCodex && !isDsh && !isPi) return;
    if (isCodex && !message.codexTurnId) return;
    if (isDsh && message.sourceSequence === undefined) return;
    if (isPi && !message.messageId) return;
    if (this.isDestroyed) return;
    try {
      const source = this.instance;
      const result = isCodex
        ? await agent.forkCodexThread(this.threadId, message.codexTurnId!)
        : isDsh
          ? await agent.forkDeepSeekHarnessThread(
            this.threadId,
            message.sourceSequence!,
          )
          : await agent.forkPiThread(this.threadId, message.messageId!);
      const fork = useAgentSessionStore.getState().createInstance({
        agentType: this.typeKey,
        title: `${source?.title || defaultThreadTitle(this.typeKey)} (fork)`,
        threadId: result.thread.threadId,
        runtimeConfig: {
          ...(source?.runtimeConfig ?? buildInitialInstanceRuntimeConfig(this.typeKey)),
          ...(isPi && "cwd" in result ? { cwd: result.cwd } : {}),
        },
        source: { kind: "dedicated", notebookId: source?.source.notebookId ?? null },
      });
      await openWorkspaceSurface({ host: 'main-third', target: { kind: 'agent-conversation', instanceId: fork.instanceId } });
    } catch (error) {
      logger.error(`Failed to fork ${this.typeKey} conversation`, { error });
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  private async openInBrowserColumn(): Promise<void> {
    if (this.isFullscreen || this.isDestroyed) return;
    try {
      // Legacy cards may not have been bound to an instance yet. Bind before
      // opening so the Browser Column receives this card's conversation ID.
      const instance = await this.ensureInstanceBinding();
      if (!instance || this.isDestroyed) return;
      await openWorkspaceSurface({
        host: "browser-column",
        target: { kind: "agent-conversation", instanceId: instance.instanceId },
      });
    } catch (error) {
      logger.error("Failed to open conversation in browser column", { error });
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  private get threadId(): string | null {
    const instance = this.instance;
    return instance
      ? instance.threadId
      : (this.node.attrs.threadId as string | null) || null;
  }

  private syncThreadInterest(): void {
    const nextThreadId = this.threadId;
    if (nextThreadId === this.interestedThreadId) return;
    this.releaseThreadInterest?.();
    this.releaseThreadInterest = nextThreadId
      ? acquireThreadInterest(nextThreadId)
      : null;
    this.interestedThreadId = nextThreadId;
  }

  private get runtimeHandleId(): string {
    return this.runtime.runtimeHandleId;
  }

  private get runtimeThreadId(): string | null {
    return this.runtime.runtimeThreadId;
  }

  private get renderThreadId(): string | null {
    // `runtime` 在构造函数里晚于 `chrome.attach()` 初始化,BadgeChromeController
    // 在 attach 时会立刻调用 renderHoverCardContent -> getThreadState ->
    // currentThreadState -> renderThreadId ── 那条路径下 `this.runtime` 还是
    // undefined,安全地回退到 `node.attrs.threadId`,后续 runtime 初始化完会再
    // 被 1s 定时器 / hover 触发时用真实 id 刷一次。
    return this.runtime?.renderThreadId ?? this.threadId;
  }

  private get title(): string {
    return this.chrome.getTitle();
  }

  private get typeKey(): AgentTypeKey {
    // `agent_conversation_instances` predates the current runtime registry and
    // can still contain retired values such as `flowix`.  Never let a persisted
    // value bypass the normalizer: runtime-spec consumers require a supported
    // AgentTypeKey and otherwise dereference an absent spec.
    return normalizeAgentTypeKey(
      this.instance?.agentType ?? (this.node.attrs.typeKey as string | null),
    );
  }

  private get instanceId(): string | null {
    const value = this.node.attrs.instanceId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private get instance() {
    return useAgentSessionStore.getState().getInstance(this.instanceId);
  }

  /**
   * 取本卡片的运行 cwd, 供 hover card 展示:
   *   1. 优先 `runtimeConfig.workspaceSnapshot.cwd` (新版冻结后的字段,带 workspace)
   *   2. 回退到 `runtimeConfig.cwd` (旧版裸 cwd)
   *   3. 都没有或都是空白字符串 → null (UI 隐藏整行)
   *
   * 解析时机: 每次 hover card 刷新时调用, 反映用户中途改 cwd 的最新值。
   */
  private get cwd(): string | null {
    return getAgentConversationRuntimeCwd(this.instance) ?? null;
  }

  /** Project AI settings always operate on the registered notebook root. */
  private get notebookPath(): string | null {
    const instance = this.instance;
    const runtimeConfig = instance?.runtimeConfig;
    const snapshot = runtimeConfig?.workspaceSnapshot;
    const snapshotNotebookPath = snapshot?.notebookPath?.trim();
    if (snapshotNotebookPath) return snapshotNotebookPath;

    const notebookId = runtimeConfig?.notebookId
      ?? snapshot?.notebookId
      ?? instance?.source.notebookId
      ?? null;
    const memoState = useNoteStore.getState();
    const notebook = (notebookId
      ? memoState.notebooks.find((item) => item.id === notebookId)
      : null) ?? memoState.selectedNotebook;
    return notebook?.path?.trim() || null;
  }

  private scopePathForLocalFile(filePath: string): string | null {
    return agentFileScopePathForRuntime(filePath, this.instance?.runtimeConfig);
  }

  private syncInstanceBindingAttrs(instance: AgentConversationInstance): void {
    const attrs: Record<string, unknown> = {};
    const threadChanged = this.node.attrs.threadId !== instance.threadId;
    if (threadChanged) attrs.threadId = instance.threadId;
    const typeKey = normalizeAgentTypeKey(instance.agentType);
    if (this.node.attrs.typeKey !== typeKey) attrs.typeKey = typeKey;
    // A blank instance title is meaningful after recovery: clear the stale
    // Markdown title only when the bound conversation itself has changed.
    if (threadChanged && !instance.title && this.node.attrs.title) attrs.title = "";
    if (Object.keys(attrs).length > 0) this.updateAttrs(attrs);
  }

  private ensureInstanceBinding(): Promise<AgentConversationInstance | null> {
    if (this.isDestroyed) return Promise.resolve(null);
    const existingInstanceId = this.instanceId;
    if (existingInstanceId) {
      const boundInstance = this.instance;
      if (boundInstance) {
        this.syncInstanceBindingAttrs(boundInstance);
        return Promise.resolve(boundInstance);
      } else if (this.hydratingInstanceId !== existingInstanceId) {
        this.hydratingInstanceId = existingInstanceId;
        const typeKey = this.typeKey;
        const threadId = createFreshExternalAgentThreadId(typeKey, existingInstanceId);
        const promise = (async (): Promise<AgentConversationInstance | null> => {
          const restored = await useAgentSessionStore.getState().hydrateInstance(existingInstanceId);
          if (this.isDestroyed || this.instanceId !== existingInstanceId) return null;
          if (restored) {
            this.syncInstanceBindingAttrs(restored);
            this.refreshAttrs();
            return restored;
          }

          // The card points at an instance that no longer exists. Give it a
          // new persisted identity and an empty local thread so opening the
          // surface cannot resurrect the stale provider session.
          const store = useAgentSessionStore.getState();
          const replacement = store.upsertInstance(existingInstanceId, {
            agentType: typeKey,
            title: "",
            threadId,
            source: getCurrentThreadCardSource(),
            runtimeConfig: buildInitialInstanceRuntimeConfig(typeKey),
          });
          await store.persistInstanceAndWait(existingInstanceId);
          if (this.isDestroyed || this.instanceId !== existingInstanceId) return null;
          this.updateAttrs({
            threadId: replacement.threadId,
            typeKey: replacement.agentType,
            title: "",
          });
          this.refreshAttrs();
          return replacement;
        })().catch((error) => {
          logger.error("Failed to hydrate conversation instance", { error });
          return null;
        }).finally(() => {
          if (this.hydratingInstanceId === existingInstanceId) {
            this.hydratingInstanceId = null;
          }
          if (this.instanceBindingPromise?.instanceId === existingInstanceId) {
            this.instanceBindingPromise = null;
          }
        });
        this.instanceBindingPromise = { instanceId: existingInstanceId, promise };
        return promise;
      }
      return this.instanceBindingPromise?.instanceId === existingInstanceId
        ? this.instanceBindingPromise.promise
        : Promise.resolve(null);
    }
    // Phase 5.3 修正 (2026-08-03): 改走 conv-store.createInstance, 让
    // setWithInstanceMirror 同时写两个 store. 旧路径走 session-store
    // 直接 createInstance, 但 renameAgentConversation 走 conv-store
    // renameInstance ── 在 conv-store 找不到 instance 就 no-op, 导致
    // session-store 的 instance.title 永远不更新, syncTitleText 卡在
    // 旧 title. 双写保证两个 store 的 instance 形状一致, 重命名 /
    // runtimeConfig 后续 mutation 都能正确收敛.
    const existingThreadId = this.threadId;
    const instance = useAgentSessionStore.getState().createInstance({
      agentType: this.typeKey,
      // A genuinely new card stays provisional until first send. An older
      // threaded card without instanceId keeps its Markdown title only as a
      // one-time recovery seed; INSERT OR IGNORE cannot overwrite threads.title.
      title: existingThreadId
        ? ((this.node.attrs.title as string | null) ?? "")
        : "",
      threadId: existingThreadId,
      source: getCurrentThreadCardSource(),
      // 这里只记录 notebookId；cwd / paths 在首次 send 前解析并冻结，避免
      // 此处 selectedNotebook / workspace 尚未 hydrate 时写入空快照。
      runtimeConfig: buildInitialInstanceRuntimeConfig(this.typeKey),
    });
    this.updateAttrs({
      instanceId: instance.instanceId,
      threadId: existingThreadId,
      typeKey: instance.agentType,
    });
    return Promise.resolve(instance);
  }

  private get collapsed(): boolean {
    return !!this.node.attrs.collapsed;
  }

  private get persistedFullscreen(): boolean {
    return !!this.node.attrs.fullscreen;
  }

  private get workspaceHost(): WorkspaceHostId | null {
    return this.hostId;
  }

  private get inputDraft(): string {
    const value = this.node.attrs.inputDraft;
    return typeof value === "string" ? value : "";
  }

  private get inputAttachments(): AgentThreadCardInputAttachment[] {
    const value = this.node.attrs.inputAttachments;
    return Array.isArray(value) ? value : [];
  }

  private flushPendingDraft(): void {
    this.composerController.flushPendingDraft();
  }

  private consumeInitialPrompt(): string | null {
    const initialPrompt =
      typeof this.node.attrs.initialPrompt === "string"
        ? this.node.attrs.initialPrompt.trim()
        : "";
    if (!initialPrompt || !this.node.attrs.autoSubmit) return null;

    this.updateAttrs({ initialPrompt: null, autoSubmit: false });
    return initialPrompt;
  }

  private runInitialPromptIfNeeded(): void {
    const initialPrompt = this.consumeInitialPrompt();
    if (!initialPrompt) return;

    this.composerController.setHistoryValue(initialPrompt);

    requestAnimationFrame(() => {
      if (this.isDestroyed) return;
      void this.submit();
    });
  }

  private loadCodexDefaultModel(): void {
    this.externalAgentSettings.loadDefaultModel();
  }

  private createExternalAgentEmptySettings(): HTMLElement {
    return this.externalAgentSettings.createEmptySettings();
  }

  private refreshExternalAgentEmptySettings(): void {
    this.externalAgentSettings.refreshEmptySettings();
  }

  private setCodexSettingsPopoverOpen(
    open: boolean,
    kind: AgentRuntimeSettingKind | null = null,
    anchor: HTMLButtonElement | null = null,
  ): void {
    this.externalAgentSettings.setSettingsPopoverOpen(open, kind, anchor);
  }

  private renderCodexSettingsPopover(): void {
    this.externalAgentSettings.renderPopover();
  }

  /** 文档引用 → composer 注入为一个可独立选中/删除的行内笔记卡片。 */
  private injectMemoReference(ref: MemoRef): void {
    this.composerController.insertMemoReference(ref);
  }

  private applyResolvedExternalSessionId(
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey = this.typeKey,
  ): void {
    this.runtime.applyResolvedSession(threadId, sessionId, typeKey);
  }

  private shouldLoadThreadMessages(): boolean {
    return (
      !this.submission.isSubmitting &&
      (!this.collapsed || this.isFullscreen) &&
      this.messages.canLoadForViewport(this.isFullscreen)
    );
  }

  private requestThreadMessagesIfNeeded(): void {
    this.messages.requestIfNeeded();
  }

  private observeThreadCacheVisibility(): void {
    this.messages.observeVisibility();
  }

  private updateAttrs(attrs: Record<string, unknown>): void {
    if (this.isDestroyed || this.view.isDestroyed) return;

    const pos = this.getPos?.();
    if (pos === undefined) return;

    // getPos is dynamic, but the NodeView's node is only refreshed by
    // ProseMirror after a transaction. Async callbacks can therefore have a
    // stale this.node snapshot. Read the node at the live position and make
    // sure it is still this card before merging attrs. This is a cheap O(depth)
    // guard on the normal path; importantly, it avoids a whole-document scan.
    const currentNode = this.view.state.doc.nodeAt(pos);
    if (!currentNode || currentNode.type.name !== "agentThreadCard") return;

    const currentInstanceId =
      typeof currentNode.attrs.instanceId === "string"
        ? currentNode.attrs.instanceId.trim()
        : "";
    const expectedInstanceId = this.instanceId ?? "";
    if (expectedInstanceId && currentInstanceId !== expectedInstanceId) {
      return;
    }

    // A legacy card may still be receiving its first instanceId. If another
    // update has already bound this position to a different instance, reject
    // the stale callback instead of overwriting that card's identity.
    const incomingInstanceId =
      typeof attrs.instanceId === "string" ? attrs.instanceId.trim() : "";
    if (
      incomingInstanceId &&
      expectedInstanceId &&
      incomingInstanceId !== expectedInstanceId
    ) {
      return;
    }
    if (
      incomingInstanceId &&
      currentInstanceId &&
      incomingInstanceId !== currentInstanceId
    ) {
      return;
    }

    const nextAttrs = { ...currentNode.attrs, ...attrs };
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs),
    );
    // 不再手动调 refreshAttrs / renderThreadState / requestThreadMessagesIfNeeded
    // ── ProseMirror 派发 update(node) 回调会做这些 (且会按 update(node) 里的
    // 消息影响检测决定走 lite / full 路径)。 旧代码这里手动调一次, 加上
    // ProseMirror 自己的回调, 等于每个 updateAttrs 双倍开销 ── 50 条对话
    // 下肉眼可见的输入卡顿的成因之一。
    //
    // this.node 也由 update(node) 内部统一刷新, 这里不再手动赋值, 避免
    // update(node) 拿到旧 this.node 做 attrs diff 时出现 false negative。
  }

  private refreshAttrs(): void {
    const instance = this.instance;
    if (instance) this.syncInstanceBindingAttrs(instance);
    this.dom.dataset.threadId = this.threadId ?? "";
    this.dom.dataset.title = this.title;
    this.dom.dataset.instanceId = this.instanceId ?? "";
    // typeKey getter 每次访问都跑 normalizeAgentTypeKey → getAgentType.find ──
    // 本方法同一函数内访问 2 次, 缓存到局部变量避免重复计算 (在 ProseMirror node
    // update 高频路径上累计调用很多)。
    const typeKey = this.typeKey;
    // the optional persona memo metadata.
    this.dom.dataset.agentType = typeKey;
    this.dom.dataset.collapsed = this.collapsed ? "true" : "false";
    this.dom.dataset.fullscreen = this.persistedFullscreen ? "true" : "false";
    this.dom.dataset.inputDraft = this.inputDraft;
    // type.name 已被 badge 承担, title 只显示对话标题 ── 避免与 badge 重复。
    this.chrome.syncTitleText();
    this.chrome.refreshBadge();
    if (this.externalSettingsLoadedTypeKey !== typeKey) {
      this.externalSettingsLoadedTypeKey = typeKey;
      this.loadCodexDefaultModel();
    }
    // Do not rewrite the live editor from attrs during refresh. inputDraft is
    // only the persisted remount value; submit and history navigation update
    // the editor explicitly.
    this.renderCollapseState();
    this.renderFullscreenState();
  }

  // 同步折叠态: 切 .--collapsed 修饰类, 同步按钮的 aria-label。
  // 图标视觉切换交给 CSS ── 构造器一次性挂 chevron-down SVG, 折叠态
  // 由 .agent-thread-card--collapsed .agent-thread-card__chevron-icon
  // { transform: rotate(180deg) } 翻成 chevron-up, transition: 150ms
  // 给一个柔和的翻转动画。不在 TS 端 replaceChildren+append 重建节点 ──
  // 重建会导致折叠/展开瞬间 SVG 闪一下, 与 150ms transition 节奏冲突。
  private renderCollapseState(): void {
    const collapsed = this.collapsed;
    this.dom.classList.toggle("agent-thread-card--collapsed", collapsed);
    this.collapseButton.setAttribute(
      "aria-label",
      collapsed
        ? this.t("editor.threadCard.expand")
        : this.t("editor.threadCard.collapse"),
    );
  }

  // 折叠态持久化到 node attrs, 后续由 ProseMirror update() 刷新视图。
  private toggleCollapsed(): void {
    this.updateAttrs({ collapsed: !this.collapsed });
  }

  private toggleFullscreen(): void {
    this.setFullscreen(!this.isFullscreen);
  }

  /**
   * Whether this surface may restore a persisted fullscreen marker.
   *
   * Persisted fullscreen is restored in the primary work column only. Users
   * can still enter fullscreen manually in either host; a browser-column copy
   * stays inline when a note opens so its surrounding text remains visible.
   */
  private shouldRestorePersistedFullscreen(): boolean {
    return this.workspaceHost === 'main-third';
  }

  /**
   * Markdown may contain more than one stale fullscreen marker (for example
   * after a merge). Only the first marked card in document order is restored.
   */
  private schedulePersistedFullscreenRestore(): void {
    const generation = ++this.fullscreenRestoreGeneration;
    this.fullscreenRestorePending = true;
    if (this.fullscreenRestoreFrame !== null) {
      window.cancelAnimationFrame(this.fullscreenRestoreFrame);
      this.fullscreenRestoreFrame = null;
    }
    if (this.persistedFullscreen && this.shouldRestorePersistedFullscreen()) {
      this.dom.classList.add(AGENT_THREAD_CARD_FULLSCREEN_RESTORE_CLASS);
    }
    queueMicrotask(() => this.restorePersistedFullscreenIfFirst(generation));
  }

  private cancelPersistedFullscreenRestore(): void {
    this.fullscreenRestoreGeneration += 1;
    this.fullscreenRestorePending = false;
    if (this.fullscreenRestoreFrame !== null) {
      window.cancelAnimationFrame(this.fullscreenRestoreFrame);
      this.fullscreenRestoreFrame = null;
    }
    this.dom.classList.remove(AGENT_THREAD_CARD_FULLSCREEN_RESTORE_CLASS);
  }

  private finishPersistedFullscreenRestore(generation: number): void {
    if (generation !== this.fullscreenRestoreGeneration) return;
    this.fullscreenRestorePending = false;
    this.fullscreenRestoreFrame = null;
    this.dom.classList.remove(AGENT_THREAD_CARD_FULLSCREEN_RESTORE_CLASS);
  }

  private restorePersistedFullscreenIfFirst(generation: number): void {
    if (generation !== this.fullscreenRestoreGeneration) return;
    if (this.isDestroyed || this.isFullscreen || !this.persistedFullscreen) {
      this.finishPersistedFullscreenRestore(generation);
      return;
    }

    if (!this.shouldRestorePersistedFullscreen()) {
      this.finishPersistedFullscreenRestore(generation);
      return;
    }

    if (!this.isFirstPersistedFullscreenCard()) {
      this.finishPersistedFullscreenRestore(generation);
      return;
    }
    this.setFullscreen(true, { persist: false, fromRestore: true });
    // Cached messages may already have rendered at the inline card height.
    // Entering fullscreen then reuses the same message references and takes
    // the renderer's noop path, so wait for the fullscreen layout before
    // applying the document-entry default bottom position again.
    this.fullscreenRestoreFrame = window.requestAnimationFrame(() => {
      if (generation !== this.fullscreenRestoreGeneration) return;
      if (!this.isDestroyed && this.isFullscreen) {
        this.messages.scrollToBottom();
      }
      this.finishPersistedFullscreenRestore(generation);
    });
  }

  private isFirstPersistedFullscreenCard(): boolean {
    const currentPos = this.getPos?.();
    if (currentPos === undefined) return false;

    let firstPersistedPos: number | null = null;
    this.view.state.doc.descendants((node, pos) => {
      if (
        firstPersistedPos === null &&
        node.type.name === this.node.type.name &&
        !!node.attrs.fullscreen
      ) {
        firstPersistedPos = pos;
        return false;
      }
      return firstPersistedPos === null;
    });

    return firstPersistedPos === currentPos;
  }

  private persistFullscreenState(fullscreen: boolean): void {
    if (!fullscreen) {
      this.updateAttrs({ fullscreen: false });
      return;
    }

    const currentPos = this.getPos?.();
    if (currentPos === undefined) return;

    let tr = this.view.state.tr;
    this.view.state.doc.descendants((node, pos) => {
      if (node.type.name !== this.node.type.name) return true;
      const shouldPersist = pos === currentPos;
      if (!!node.attrs.fullscreen !== shouldPersist) {
        tr = tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          fullscreen: shouldPersist,
        });
      }
      return false;
    });
    if (tr.docChanged) this.view.dispatch(tr);
  }

  private dispatchFullscreenChange(): void {
    window.dispatchEvent(
      new CustomEvent(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, {
        detail: {
          active: this.isFullscreen,
          element: this.dom,
          threadId: this.threadId,
        },
      }),
    );
  }

  private setFullscreen(
    fullscreen: boolean,
    options: { persist?: boolean; fromRestore?: boolean } = {},
  ): void {
    if (!options.fromRestore) {
      this.cancelPersistedFullscreenRestore();
    }
    if (this.isFullscreen === fullscreen) return;
    this.setMessageScrollActive(false);

    if (fullscreen) {
      this.captureFullscreenReturnAnchor();
    } else {
      this.blurFullscreenSurface();
    }

    this.isFullscreen = fullscreen;
    if (options.persist !== false) {
      this.persistFullscreenState(fullscreen);
    }
    this.renderFullscreenState();
    this.dispatchFullscreenChange();
    this.chrome.renderBadgeHoverCard();
    // 下一帧同步 badge 位置 ── 布局(全屏 container 切换)在当帧不一定完成,
    // 立即 getBoundingClientRect 可能拿到旧值
    if (this.badgePositionFrame !== null) {
      window.cancelAnimationFrame(this.badgePositionFrame);
    }
    this.badgePositionFrame = window.requestAnimationFrame(() => {
      this.badgePositionFrame = null;
      if (!this.isDestroyed) this.chrome.syncBadgeHoverCardPosition();
    });

    if (fullscreen) {
      this.enterFullscreenMode();
      this.requestThreadMessagesIfNeeded();
      this.renderThreadState();
    } else {
      this.exitFullscreenMode();
      // Rebuild the empty state so the setup controls return when a blank
      // fullscreen conversation becomes an inline Thread Card again.
      this.renderThreadState();
    }
  }

  private renderFullscreenState(): void {
    this.fullscreenButton.hidden = false;
    this.openInBrowserColumnButton.hidden = this.isFullscreen;
    this.actionsDivider.hidden = false;
    // 全屏模式下不展示删除按钮 ── 卡片铺满视口, 删除是破坏性操作,
    // 留出右上方空间给"退出全屏" 与"折叠" 等视图操作, 避免误删。
    this.deleteButton.hidden = this.isFullscreen;
    this.dom.classList.toggle(
      "agent-thread-card--fullscreen",
      this.isFullscreen,
    );
    this.composer.classList.toggle(
      "agent-composer--expanded",
      this.isFullscreen,
    );
    if (this.isFullscreen) {
      this.dom.classList.remove("ProseMirror-selectednode");
      this.dom.setAttribute("role", "dialog");
      this.dom.setAttribute("aria-modal", "true");
      this.dom.setAttribute("aria-label", this.title);
    } else {
      this.dom.removeAttribute("role");
      this.dom.removeAttribute("aria-modal");
      this.dom.removeAttribute("aria-label");
    }
    this.fullscreenButton.setAttribute(
      "aria-label",
      this.isFullscreen
        ? this.t("editor.threadCard.exitFullscreen")
        : this.t("editor.threadCard.enterFullscreen"),
    );
    this.fullscreenButton.replaceChildren(
      createFullscreenIcon(this.isFullscreen ? "exit" : "enter"),
    );
  }

  private enterFullscreenMode(): void {
    if (this.collapsed) {
      this.updateAttrs({ collapsed: false });
    }

    this.view.dom.blur();
    this.focusFullscreenSurface();
    this.fullscreenLayout.enter();
  }

  private exitFullscreenMode(): void {
    this.fullscreenLayout.exit();
  }

  private captureScrollSnapshot(): ScrollSnapshot {
    return this.fullscreenLayout.captureScrollSnapshot();
  }

  private restoreScrollSnapshotAfterFocusChange(snapshot: ScrollSnapshot): void {
    this.fullscreenLayout.restoreScrollSnapshotAfterFocusChange(snapshot);
  }

  private ownsNode(target: globalThis.Node | null): boolean {
    return !!(
      target &&
      (this.dom.contains(target) ||
        this.externalAgentSettings.popoverElement.contains(target) ||
        this.notePicker.popoverElement.contains(target))
    );
  }

  private blurOwnedFocusForOutsidePointer(event: PointerEvent): void {
    if (this.isDestroyed || this.isFullscreen) return;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !this.ownsNode(activeElement))
      return;
    // Editor chrome outside the NodeView (for example the shared block drag
    // handle) owns its pointer lifecycle and deliberately prevents native
    // focus transfer. Respect that contract at capture time so the nested
    // composer does not blur before the control can lock its interaction
    // target, which would otherwise make the handle flicker.
    const targetElement = getEventElement(event);
    if (targetElement?.closest('[data-editor-preserve-focus-on-pointerdown="true"]'))
      return;
    const target = event.target as globalThis.Node | null;
    if (this.ownsNode(target)) return;

    const snapshot = this.captureScrollSnapshot();
    activeElement.blur();
    this.restoreScrollSnapshotAfterFocusChange(snapshot);
  }

  /**
   * A nested composer owns keyboard focus independently from the outer editor.
   * Clear any outer agent-card NodeSelection when a composer receives focus,
   * not only the NodeSelection belonging to this NodeView. A different card
   * may still be selected from an earlier drag-handle/menu interaction while
   * the user starts typing in this card.
   */
  private clearAgentThreadCardNodeSelection(): void {
    if (this.isDestroyed || this.view.isDestroyed) return;

    const { doc, selection } = this.view.state;
    if (
      !(selection instanceof NodeSelection) ||
      selection.node.type.name !== "agentThreadCard"
    ) {
      return;
    }

    const afterPos = Math.min(
      selection.from + selection.node.nodeSize,
      doc.content.size,
    );
    let nextSelection = TextSelection.near(doc.resolve(afterPos), 1);
    if (nextSelection instanceof NodeSelection) {
      nextSelection = TextSelection.near(doc.resolve(selection.from), -1);
    }

    // A document containing only cards has no valid text cursor position.
    // Leave a gap cursor beside this card so the composer can own keyboard
    // input without keeping a destructive NodeSelection on the card.
    if (nextSelection instanceof NodeSelection) {
      nextSelection = new GapCursor(doc.resolve(afterPos));
    }

    this.view.dispatch(this.view.state.tr.setSelection(nextSelection));
  }

  private captureFullscreenReturnAnchor(): void {
    this.fullscreenLayout.captureReturnAnchor();
  }

  private focusFullscreenSurface(): void {
    window.requestAnimationFrame(() => {
      if (!this.isFullscreen || this.isDestroyed) return;
      this.composerController.focus();
    });
  }

  private isOutsideFullscreenCardTarget(target: EventTarget | null): boolean {
    return target instanceof Node &&
      this.view.dom.contains(target) &&
      !this.dom.contains(target);
  }

  private blurFullscreenSurface(): void {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      this.dom.contains(activeElement)
    ) {
      activeElement.blur();
    }
  }

  // Phase 5.3: 缓存 projection -> ThreadState 映射, 保证同一 projection 引用
  // 返回同一 ThreadState 引用 (ref-stable), 避免 composer 因新对象 identity
  // 触发重渲染清空 input draft.
  private _threadStateCache: { projection: ThreadProjection | undefined; state: ThreadState | undefined } = {
    projection: undefined,
    state: undefined,
  };

  private currentThreadState(): ThreadState | undefined {
    const threadId = this.renderThreadId;
    if (!threadId) return undefined;
    // Read the canonical ref-stable projection directly.
    const projection = useAgentSessionStore.getState().threadProjections[threadId];
    if (projection === this._threadStateCache.projection) {
      return this._threadStateCache.state;
    }
    if (!projection) {
      this._threadStateCache = { projection: undefined, state: undefined };
      return undefined;
    }
    const state: ThreadState = {
      messages: projection.messages,
      isLoading: projection.runs.isLoading,
      activeRunId: projection.runs.activeRunId,
      runs: projection.runs.runs,
      dshCommand: projection.runs.dshCommand,
      codexCommand: projection.runs.codexCommand,
      pendingAssistantId: projection.pending.assistantId,
      pendingReasoningId: projection.pending.reasoningId,
      lastRun: projection.runs.lastRun,
      oldestSequence: projection.pagination.oldestSequence,
      hasMoreHistory: projection.pagination.hasMoreHistory,
      loadingMore: projection.pagination.loadingMore,
    };
    this._threadStateCache = { projection, state };
    return state;
  }

  private currentRuntimeView(state: ThreadState | undefined = this.currentThreadState()) {
    return selectAgentThreadCardRuntimeView({
      state,
      isCreating: this.isCreating,
      isLoading: !!state?.isLoading,
      typeKey: this.typeKey,
    });
  }

  private currentConversationMessageState() {
    const threadId = this.renderThreadId;
    // Derived directly from the canonical projection.
    return threadId
      ? useAgentSessionStore.getState().getMessageState(threadId)
      : null;
  }

  private currentMessages(): ThreadState["messages"] {
    return selectRenderableThreadMessages(this.renderThreadId);
  }

  private isThreadCachePresentationHidden(): boolean {
    return this.messages.isCachePresentationHidden();
  }

  private createThreadCacheSkeleton(): HTMLDivElement {
    return createThreadCacheSkeleton(
      this.t("editor.threadCard.loadingThreadCache"),
    );
  }

  // 消息链接点击委托 ── AgentThreadCard 是只读 NodeView, 不使用编辑器正文的
  // link hover tooltip。这里本地接管点击, 保留 flowix:// 深链和普通外链打开能力。
  private handleBodyClick(event: MouseEvent): void {
    handleAgentLinkClick(event, this.instance?.runtimeConfig, (error, rawHref) => {
      logger.error("Failed to open Agent message link", { error, rawHref });
      toast.error(error instanceof Error ? error.message : this.t("agent.link.openLocalFileFailed"));
    });
  }

  private setMessageScrollActive(active: boolean): void {
    if (this.isMessageScrollActive === active) return;
    this.isMessageScrollActive = active;
    this.dom.classList.toggle(
      AGENT_THREAD_CARD_MESSAGE_SCROLL_ACTIVE_CLASS,
      active,
    );
  }

  private handleBodyWheel(event: WheelEvent): void {
    if (this.isFullscreen || this.isMessageScrollActive) {
      this.messages.handleUserScrollIntent(event.deltaY);
      return;
    }

    const editorScroller = this.body.closest<HTMLElement>(".editor-content");
    if (!editorScroller) {
      this.messages.handleUserScrollIntent(event.deltaY);
      return;
    }

    const { deltaX, deltaY } = wheelDeltaPixels(event, editorScroller);
    if (deltaX === 0 && deltaY === 0) return;

    // Before the message area is clicked, treat it as transparent to editor
    // scrolling. Clicking outside the viewport returns to this default mode.
    event.preventDefault();
    editorScroller.scrollTop += deltaY;
    editorScroller.scrollLeft += deltaX;
  }

  private renderMetaState(
    state: ThreadState | undefined,
    isLoading: boolean,
  ): void {
    renderAgentThreadCardMetaState({
      dom: this.dom,
      metaEl: this.metaEl,
      runStatusEl: this.runStatusEl,
      state,
      isCreating: this.isCreating,
      isLoading,
      typeKey: this.typeKey,
      t: (key) => this.t(key),
    });
  }

  private renderThreadState(): void {
    if (this.isDestroyed) return;
    const state = this.currentThreadState();
    const shouldRenderMessages = !this.collapsed || this.isFullscreen;
    const messages = shouldRenderMessages ? this.currentMessages() : [];
    const runtimeView = this.currentRuntimeView(state);
    this.dom.classList.toggle(
      "agent-thread-card--thread-cache-loading",
      this.isThreadCachePresentationHidden(),
    );
    this.dom.classList.toggle(
      "agent-thread-card--has-threadid",
      !!this.threadId,
    );

    // 运行中仍可输入并排队 Follow-up。Codex 空输入时显示运行中按钮
    // (点击仍可停止),已有输入时切换为发送。
    this.composerController.setSendButtonState();
    if (this.typeKey === "codex" && this.threadId && this.hydratedCodexQueueThreadId !== this.threadId) {
      this.hydratedCodexQueueThreadId = this.threadId;
      void useAgentSessionStore.getState().hydrateCodexFollowUps(this.threadId);
    } else if (this.typeKey !== "codex") {
      this.hydratedCodexQueueThreadId = null;
    }
    const queued = useAgentSessionStore.getState().pendingSteeringMessages[this.threadId ?? ""] ?? [];
    this.queuedMessages.hidden = queued.length === 0;
    this.queuedMessages.setAttribute("aria-label", this.t("agent.backgroundTerminals.queued"));
    this.queuedMessages.replaceChildren(
      ...queued.map((message) => {
        const row = document.createElement("div");
        row.className = "agent-background-terminals__queue-row";
        const mark = document.createElement("span");
        mark.className = "agent-background-terminals__queue-mark";
        mark.append(createArrowBendDownRightIcon());
        const text = document.createElement("span");
        text.className = "agent-background-terminals__queue-text";
        text.textContent = message.content;
        row.append(mark, text);
        if (this.typeKey === "pi" || this.typeKey === "codex") {
          const actions = document.createElement("span");
          actions.className = "agent-background-terminals__queue-actions";
          const actionsDisabled = !canActOnQueuedMessage(message, this.typeKey);
          if (message.deliveryStatus === "submitting") {
            const adding = document.createElement("span");
            adding.className = "agent-background-terminals__queue-soon";
            adding.setAttribute("role", "status");
            adding.textContent = this.t("agent.queue.adding");
            actions.append(adding);
          }
          if (message.deliveryStatus === "starting") {
            const soon = document.createElement("span");
            soon.className = "agent-background-terminals__queue-soon";
            soon.setAttribute("role", "status");
            soon.textContent = this.t("agent.queue.sendingSoon");
            actions.append(soon);
          }
          if (message.canDelete !== false) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "agent-background-terminals__queue-delete";
            remove.disabled = actionsDisabled;
            remove.setAttribute("aria-label", this.t("agent.queue.deleteQueued"));
            remove.title = this.t("agent.queue.deleteQueued");
            remove.textContent = this.t("agent.queue.deleteQueued");
            remove.addEventListener("click", () => {
              const threadId = this.renderThreadId;
              if (!threadId) return;
              void useAgentSessionStore.getState().deleteQueuedFollowUp(threadId, message.id)
                .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
            });
            actions.append(remove);
          }
          if (message.deliveryStatus !== "starting" && message.deliveryMode === "follow_up") {
            const steer = document.createElement("button");
            steer.type = "button";
            steer.className = "agent-background-terminals__queue-steer";
            steer.disabled = actionsDisabled;
            steer.textContent = this.t("agent.queue.steerNow");
            steer.addEventListener("click", () => {
              const threadId = this.renderThreadId;
              if (!threadId) return;
              void useAgentSessionStore.getState().promoteFollowUpToSteer(threadId, message.id)
                .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
            });
            actions.append(steer);
          } else if (message.deliveryMode === "steer") {
            const soon = document.createElement("span");
            soon.className = "agent-background-terminals__queue-soon";
            soon.setAttribute("role", "status");
            soon.textContent = message.deliveryStatus === "cleanup_failed"
              ? this.t("agent.queue.cleanupFailed")
              : this.t("agent.queue.sendingSoon");
            actions.append(soon);
          }
          row.append(actions);
        }
        return row;
      }),
    );
    this.renderMetaState(state, runtimeView.isBusy);

    this.messages.render({
      messages,
      isLoading: runtimeView.showLoadingIndicator,
      shouldRenderMessages,
    });
    this.ackReadAfterVisibleRender(shouldRenderMessages, runtimeView.isBusy);

    // 标题恢复: 没有显式标题 (孤儿卡片 / 持久化失败 / threadId 漂移) 时,
    // 消息加载完成后从首条 user 消息现取标题。syncTitleText 在标题编辑态
    // no-op, 已有真实标题的卡片 hasExplicitTitle 为 true 跳过, 零开销。
    if (!this.chrome.hasExplicitTitle()) {
      this.chrome.syncTitleText();
    }
  }

  /**
   * A document Card is an imperative NodeView, so it cannot use the React
   * conversation-detail read effect. Ack only after a visible message render;
   * this keeps completion notifications from being cleared by a collapsed or
   * disconnected Card while avoiding any per-token store writes.
   */
  private ackReadAfterVisibleRender(shouldRenderMessages: boolean, isBusy: boolean): void {
    if (!shouldRenderMessages || isBusy || !this.dom.isConnected) return;
    if (document.visibilityState === "hidden") return;
    const rect = this.dom.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (this.visibilityObserver && !this.isViewportVisible && !this.isFullscreen) return;
    const threadId = this.renderThreadId;
    if (!threadId) return;
    const state = useAgentSessionStore.getState();
    const completedRunId = state.latestCompletedRunIds[threadId];
    if (completedRunId) state.markThreadRead(threadId, completedRunId);
  }

  // 提取当前 thread 的 user 消息列表 (按时间顺序, 旧 → 新) ──
  // 仅做"前端有"的范围, 不主动去后台拉历史 (hasMoreHistory / loadMoreHistory),
  // 用前端可见数据即可，拉历史会拖慢键盘响应。跳过空 content 防止 typing 期
  // 的占位 user 消息污染历史。
  private getUserHistoryMessages(): string[] {
    return getAgentThreadCardUserHistoryMessagesFromMessages(
      this.currentMessages(),
    );
  }

  /**
   * 首条 user 消息原文 (已 strip 系统块) ── 供孤儿卡片标题恢复使用。
   * 复用 getUserHistoryMessages 的清洗逻辑, 取最早一条; 无则 undefined。
   */
  private firstUserMessageText(): string | undefined {
    const first = this.getUserHistoryMessages()[0];
    if (first && first.trim()) return first;
    return undefined;
  }

  private clearComposerAfterSettingsCommand(): void {
    this.composerController.clear();
    this.composerController.clearDraft();
    this.updateAttrs({ inputDraft: null });
    this.composerController.updateMultiLineState();
  }

  private async ensureDshCommandConversation(command: string) {
    if (this.typeKey !== "dsh") {
      throw new Error("This slash command is only available for DSH");
    }
    return ensureAgentThreadCardConversation({
      prompt: command,
      fallbackTitle: this.t("editor.threadCard.title"),
      typeKey: this.typeKey,
      currentThreadId: this.threadId,
      currentInstanceId: this.instanceId,
      currentTitle: this.instance?.title ?? "",
      runtimeHandleId: this.runtimeHandleId,
      source: getCurrentThreadCardSource(),
      buildTitle,
      onThreadBound: (binding) => {
        if (this.isDestroyed) return;
        this.updateAttrs({
          instanceId: binding.instanceId,
          threadId: binding.threadId,
          typeKey: binding.typeKey,
        });
      },
    });
  }

  private composerRuntimeState() {
    const projection = this.renderThreadId
      ? useAgentSessionStore.getState().threadProjections[this.renderThreadId]
      : undefined;
    return getComposerRuntimeState(this.typeKey, projection,
      this.submission.isSubmitting, !this.isDestroyed);
  }

  private async submit(): Promise<void> {
    const documentContext = extractDocumentContext(this.view);
    const isFirstMessage = this.currentMessages().length === 0;
    await this.submission.submit({
      composer: this.composerController,
      images: this.composerAttachments,
      getRuntime: () => this.composerRuntimeState(),
      isDisposed: () => this.isDestroyed,
      bind: (snapshot) => ensureAgentThreadCardConversation({
        prompt: snapshot.prompt,
        fallbackTitle: this.t("editor.threadCard.title"),
        typeKey: this.typeKey,
        currentThreadId: this.threadId,
        currentInstanceId: this.instanceId,
        currentTitle: this.instance?.title ?? "",
        runtimeHandleId: this.runtimeHandleId,
        source: getCurrentThreadCardSource(),
        buildTitle,
        onThreadBound: (binding) => {
          if (!this.isDestroyed) this.updateAttrs({
            instanceId: binding.instanceId,
            threadId: binding.threadId,
            typeKey: binding.typeKey,
          });
        },
      }),
      accept: (bound, snapshot, kind) => acceptComposerSubmission(
        { ...bound, isFirstMessage }, snapshot, kind, documentContext,
      ),
      clearPersistedDraft: () => this.updateAttrs({ inputDraft: null }),
      onPhaseChange: () => {
        this.isCreating = this.submission.phase === "binding" && !this.threadId;
        this.requestThreadMessagesIfNeeded();
        this.renderThreadState();
      },
      onError: (error) => {
        toast.error(errorMessage(error).trim() || this.t("editor.threadCard.sendFailed"));
      },
    });
    if (!this.isDestroyed) focusWithoutScroll(this.input);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== this.node.type.name) return false;
    const oldAttrs = this.node.attrs;
    const wasCollapsed = !!oldAttrs.collapsed;
    this.node = node;
    // Re-assert backend-owned instance/thread identity after Markdown updates.
    // This also repairs cards written by older builds with a provider session
    // id in the threadId attribute.
    this.ensureInstanceBinding();
    this.syncThreadInterest();
    if (
      this.isFullscreen &&
      (!this.persistedFullscreen || !this.isFirstPersistedFullscreenCard())
    ) {
      this.setFullscreen(false, { persist: false });
    } else if (!this.isFullscreen && this.persistedFullscreen) {
      this.schedulePersistedFullscreenRestore();
    } else if (!this.persistedFullscreen && this.fullscreenRestorePending) {
      this.cancelPersistedFullscreenRestore();
    }
    const isCollapsed = this.collapsed;
    this.refreshAttrs();
    // requestThreadMessagesIfNeeded 始终调用 ── shouldLoadThreadMessages
    // 自己会短路 (折叠态不加载, 已加载过不重复), 但"折叠→展开"这种
    // lite 路径下不能漏, 否则消息永远不被加载。
    this.requestThreadMessagesIfNeeded();
    if (wasCollapsed !== isCollapsed) {
      this.renderThreadState();
      return true;
    }
    // 仅"消息影响类" attrs 变化时才需要重建 body ── inputDraft /
    // title / collapsed / initialPrompt 等都不影响消息列表。 直接走
    // 轻量路径:
    //   - chrome (classes / send 按钮 / run status / loading 指示器) 由
    //     chat store subscription 驱动, 不依赖本次 update
    //   - body DOM 完全跳过, 长对话 (50+ 条) 下省掉 N 个消息节点重建
    //
    // 列表之外的 attrs 也覆盖到 ── 任何新加的"UI-only" attr 自动走 lite
    // 路径, 不会触发全量重建。
    if (canSkipMessageRebuild(oldAttrs, this.node.attrs)) {
      return true;
    }
    this.renderThreadState();
    return true;
  }

  stopEvent(event: Event): boolean {
    const target = getEventElement(event);
    if (!target || !this.dom.contains(target)) return false;
    if (this.isFullscreen) return true;
    if (event.type.startsWith("composition")) return false;
    return isAgentThreadCardInteractiveTarget(target);
  }

  selectNode(): void {
    if (this.isFullscreen) return;
    // Do not re-introduce the outer card highlight while a nested composer is
    // the active editing surface. The focus handler normally clears the
    // NodeSelection first; this guard also covers selection updates racing
    // with streaming/doc transactions.
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement.closest(".agent-composer")
    ) {
      return;
    }
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode(): void {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    // 落盘待写草稿 ── 卡片销毁时 (例如删整张卡 / 切文档) 必须把 inputDraft
    // 写进 ProseMirror attrs, 否则下一个 mount 会用旧值回填, 看起来
    // "刚打的字凭空消失"。
    this.flushPendingDraft();
    this.cancelPersistedFullscreenRestore();
    if (this.badgePositionFrame !== null) {
      window.cancelAnimationFrame(this.badgePositionFrame);
      this.badgePositionFrame = null;
    }
    this.setFullscreen(false, { persist: false, fromRestore: true });
    if (this.badgePositionFrame !== null) {
      window.cancelAnimationFrame(this.badgePositionFrame);
      this.badgePositionFrame = null;
    }
    window.removeEventListener(
      AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT,
      this.boundHandleRequestFullscreen,
    );
    this.setCodexSettingsPopoverOpen(false);
    this.dom.removeEventListener("mousedown", this.boundHandleCardMouseDown);
    this.input.removeEventListener("focus", this.boundHandleInputFocus);
    this.chrome.dispose();
    document.removeEventListener(
      "pointerdown",
      this.boundHandleOutsidePointerDown,
      true,
    );
    document.removeEventListener(
      "pointerdown",
      this.boundHandleMessageScrollModePointerDown,
      true,
    );
    document.removeEventListener(
      "pointerdown",
      this.boundHandleFullscreenPointerDown,
      true,
    );
    document.removeEventListener(
      "keydown",
      this.boundHandleFullscreenKeyDown,
      true,
    );
    document.removeEventListener(
      "focusin",
      this.boundHandleFullscreenFocusIn,
      true,
    );
    this.notePicker.setOpen(false);
    this.isDestroyed = true;
    this.releaseThreadInterest?.();
    this.releaseThreadInterest = null;
    this.interestedThreadId = null;
    this.surface.dispose();
    this.body.removeEventListener("scroll", this.boundHandleBodyScroll);
    this.scrollToLatestButton.removeEventListener("click", this.boundHandleScrollToLatest);
    this.disposeBodyScrollbar();
    this.disposeAgentMessageTypography();
    this.runtime.dispose();
    this.externalAgentSettings.dispose();
    this.notePicker.dispose();
    this.composerAddMenu.dispose();
    this.notebookAgentSettingsDialog.close();
    this.fullscreenLayout.dispose();
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.composerAttachments.dispose();
  }
}
