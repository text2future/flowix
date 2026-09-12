import { openPath, openUrl } from "@platform/tauri/opener";
import { dialogs } from "@platform/tauri/client/desktop";
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
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { acquireThreadInterest } from "@features/agent/store/thread-interest";
import type { ThreadProjection } from "@features/agent/store/session-reducer";
import { selectRenderableThreadMessages } from "@features/agent/store/thread-render-messages";
import { translate, type AppLanguage, type I18nKey, type I18nParams } from "@/lib/i18n";
import { createLogger } from "@/lib/logger";
import { errorMessage } from "@/lib/error-message";
import type { AgentTypeKey } from "@/types/agent";
import type { WorkspaceHostId } from "@features/workspace/store/workspace-focus-store";
import { deriveThreadTitleFromPrompt, defaultThreadTitle } from "@features/agent/store/thread-titles";
import { toast } from "@/lib/toast";
import { useMemoStore } from "@features/memo/store/memo-store";
import { openNoteByDeepLink } from "@features/memo/use-cases/open-by-target";
import { agent } from "@platform/tauri/client/agent";
import { normalizePlainLinkHref } from "@features/editor/extensions/markdown-link";
import { isEditableTextFilePath } from "@features/editor/code-file";
import { normalizeAgentTypeKey } from "@/lib/agent-types";
import { getCurrentAppLanguage } from "@features/preferences/public/runtime-api";
import type { AgentRuntimeSettingKind } from "@features/agent/runtime/agent-runtime-spec";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import {
  stopExternalAgentThreadCardRun,
} from "@features/agent/services/external-agent-runtime-service";
import {
  ensureAgentThreadCardConversation,
  submitAgentThreadCardConversation,
} from "@features/agent/thread-card/agent-thread-card-submit-controller";
import {
  runDshCommand,
  hasPendingDshCommand,
  listDshSkills,
} from "@features/agent/services/dsh-command-service";
import {
  createArrowBendDownRightIcon,
  createFullscreenIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";
import { createAgentThreadCardDom } from "@features/agent/thread-card/view/agent-thread-card-dom-factory";
import { AgentThreadCardChromeController } from "@features/agent/thread-card/chrome";
import { ExternalAgentSettingsController } from "@features/agent/thread-card/settings/external-agent-settings-controller";
import { CodexSettingsDialogController } from "@features/agent/thread-card/settings/codex-settings-dialog";
import { AgentRolePickerController } from "@features/agent/thread-card/role/agent-role-picker-controller";
import { FullscreenLayoutController } from "@features/agent/thread-card/fullscreen/fullscreen-layout-controller";
import {
  ComposerController,
  ComposerDraftController,
  ComposerImageController,
  ComposerAddMenuController,
  type AgentThreadCardInputImage,
  getAgentThreadCardUserHistoryMessagesFromMessages,
} from "@features/agent/thread-card/composer";

import {
  AgentThreadCardMessagesController,
  createThreadCacheSkeleton,
} from "@features/agent/thread-card/messages";
import { AgentConversationSurfaceController } from "@features/agent/thread-card/surface/agent-conversation-surface-controller";
import { getAgentConversationRuntimeCwd } from "@features/agent/conversation-presentation";
import { selectAndOpenAgentConversation } from "@features/workspace/use-cases/agent-conversation-navigation";
import {
  openBrowserColumnFileBrowser,
  openBrowserColumnText,
  openBrowserColumnWebpage,
} from "@features/workspace/use-cases/browser-column-navigation";

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
  localFilePathFromAgentHref,
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
const AGENT_THREAD_CARD_INPUT_DRAFT_MAX_CHARS = 500;
// inputDraft 落盘 debounce: typing 停 2s 后写入 ProseMirror attrs。
// submit / destroy / blur 会主动 flush, 避免卡片重挂载时用旧 attr 回填。
const AGENT_THREAD_CARD_DRAFT_PERSIST_DEBOUNCE_MS = 2000;

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
  // 输入框左侧 role 图标 ── 升级为 button (之前是 span), 让点击直接打开
  // 「选择角色」弹窗。 字段类型用 HTMLButtonElement, 以便调用 `.type = 'button'`
  // 等 button 专属 API (HTMLElement 上没有)。 HTMLElement 的所有 API
  // (replaceChildren / classList / setAttribute / addEventListener) 在 button
  // 上仍然可用 ── 不影响其它调用方。
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
  private collapseButton: HTMLButtonElement;
  private deleteButton: HTMLButtonElement;
  private fullscreenButton: HTMLButtonElement;
  private fullscreenLayout: FullscreenLayoutController;
  private composerDraft: ComposerDraftController;
  private composerController: ComposerController;
  private composerImages: ComposerImageController;
  private messages: AgentThreadCardMessagesController;
  private surface: AgentConversationSurfaceController;
  private runtime: AgentThreadCardRuntimeController;
  // 全屏 / 删除按钮之间的竖向分割线 ── 非交互元素, aria-hidden 让屏幕
  // 阅读器跳过; 视觉与按钮同高 (28px), 1px var(--border) 着色。
  // 可见性与 fullscreenButton 同步 (renderFullscreenState 一起切 hidden)。
  private actionsDivider: HTMLSpanElement;
  private externalAgentSettings: ExternalAgentSettingsController;
  private externalSettingsLoadedTypeKey: AgentTypeKey | null = null;
  private agentRolePicker: AgentRolePickerController;
  private composerAddMenu: ComposerAddMenuController;
  private codexSettingsDialog = new CodexSettingsDialogController();
  private isCreating = false;
  private isDestroyed = false;
  // Guards late async completions (thread creation / role loading) from
  // writing attrs after a newer submit or a document lifecycle change.
  private submitGeneration = 0;
  private interestedThreadId: string | null = null;
  private hydratingInstanceId: string | null = null;
  private releaseThreadInterest: (() => void) | null = null;
  private isFullscreen = false;
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
  private boundHandleInputFocus = (): void => {
    this.clearCardNodeSelection();
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
      onBodyWheel: (event) => this.messages.handleUserScrollIntent(event.deltaY),
      // composer 空区域 → 输入框 focus 已由 createAgentComposerDom
      // 工厂内部挂的 pointerdown 委托统一处理 (详见
      // composer-dom-factory.ts COMPOSER_FOCUS_INTERACTIVE_SELECTOR),
      // 这里不再单独接 onComposerMouseDown ── 否则会与工厂委托重复
      // 触发, 同一次点击会跑两遍 focus, caret 闪烁。
    });

    this.dom = domParts.dom;
    if (this.persistedFullscreen) {
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
        this.setCodexSettingsPopoverOpen(false);
        this.setComposerRolePopoverOpen(false);
      },
      dragThresholdPx: AGENT_THREAD_CARD_HEADER_DRAG_THRESHOLD_PX,
      getAttrTitle: () => this.node.attrs.title as string | null,
      getInstanceTitle: () => this.instance?.title,
      getFirstUserMessageText: () => this.firstUserMessageText(),
      getDefaultTitle: () => defaultThreadTitle(this.typeKey),
      getThreadId: () => this.threadId,
      getSessionId: () => this.instance?.sessionId ?? null,
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
    this.fullscreenButton = domParts.fullscreenButton;
    this.actionsDivider = domParts.actionsDivider;
    this.collapseButton = domParts.collapseButton;
    this.body = domParts.body;
    this.loadingIndicator = domParts.loadingIndicator;
    this.queuedMessages = domParts.queuedMessages;
    this.composer = domParts.composer;
    this.composerRoleIcon = domParts.composerRoleIcon;
    this.input = domParts.input;
    this.sendButtonMount = domParts.sendButtonMount;
    this.input.addEventListener("focus", this.boundHandleInputFocus);

    const { codexSettingsPopover, composerRolePopover, composerAddPopover } = domParts;
    this.externalAgentSettings = new ExternalAgentSettingsController({
      popover: codexSettingsPopover,
      getTypeKey: () => this.typeKey,
      getInstanceId: () => this.instanceId ?? undefined,
      getLanguage: () => this.language,
      t: (key) => this.t(key),
      isDestroyed: () => this.isDestroyed,
      isRunning: () => this.currentRuntimeView().isRunning,
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
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
    this.agentRolePicker = new AgentRolePickerController({
      trigger: this.composerRoleIcon,
      popover: composerRolePopover,
      // 必须把 params 透传给 this.t ── formatTimeAgo 走的是
      // t('memo.time.minutesAgo', { m }) 这种带参调用, 老 wrapper
      // (key) => this.t(key) 会丢掉 params, 让 translate 拿到 undefined,
      // 文案就只剩 "{m} 分钟前" 字面量, 数字永远不替换。
      t: (key, params) => this.t(key, params),
      isDestroyed: () => this.isDestroyed,
      getCurrentMemoId: () => this.agentRoleMemoId,
      getCurrentName: () => this.agentRoleName,
      getMessageCount: () => this.currentMessages().length,
      updateRole: (role) => this.updateAgentRole(role),
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
      injectMemoReference: (ref) => this.injectMemoReference(ref),
      triggerManagedExternally: true,
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
    this.composerImages = new ComposerImageController({
      input: this.input,
      container: domParts.composerImages,
      initialImages: this.inputImages,
      onChange: (images) => this.updateAttrs({ inputImages: images }),
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
      rolePopover: composerRolePopover,
      rolePicker: this.agentRolePicker,
      images: this.composerImages,
      t: (key) => this.t(key),
      isDestroyed: () => this.isDestroyed,
      getAgentType: () => this.typeKey,
      openCodexSettings: () => {
        const notebookPath = this.cwd ?? useMemoStore.getState().selectedNotebook?.path;
        if (notebookPath) this.codexSettingsDialog.open(notebookPath);
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
      getMessageCount: () => this.currentMessages().length,
      shouldLoadThreadMessages: () => this.shouldLoadThreadMessages(),
      renderThreadState: () => this.renderThreadState(),
      renderResolvedSessionMessages: (messages) =>
        this.renderResolvedSessionMessages(messages),
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
      getSendLabel: (wantStop, isRunning) =>
        isRunning
          ? this.t("editor.threadCard.running")
          : wantStop
            ? this.t("editor.threadCard.stop")
            : this.t("editor.threadCard.send"),
      getSendButtonWantsStop: () =>
        this.currentRuntimeView().sendButtonWantsStop &&
        !((this.typeKey === "codex" || this.typeKey === "deepseek-harness") &&
          !!this.composerController?.getPrompt().trim()),
      getSendButtonRunning: () => this.currentRuntimeView().isDshCommandRunning,
      getHasAttachments: () => this.composerImages.hasImages,
      getHasPendingAttachments: () => this.composerImages.hasPending,
      agentType: this.typeKey,
      listDshSkills: async () => {
        if (this.typeKey !== "deepseek-harness") return [];
        const ensured = await this.ensureDshCommandConversation("/skill");
        return listDshSkills({
          threadId: ensured.threadId,
          runtimeConfig: ensured.runtimeConfig,
        });
      },
      onDshModelSelect: () => {
        this.clearComposerAfterSlashCommand();
        this.externalAgentSettings.openComposerModelPicker();
      },
      onPermissionSelect: () => {
        this.clearComposerAfterSlashCommand();
        this.externalAgentSettings.openComposerPermissionPicker();
      },
      onDirectCommand: (command) => {
        this.clearComposerAfterSlashCommand();
          void this.runDshCommandFromCard(`/${command.name}`);
      },
      submit: () => {
        void this.submit();
      },
      stop: () => {
        void stopExternalAgentThreadCardRun(this.runtimeHandleId, this.threadId);
      },
      },
    });
    this.messages = this.surface.messages;
    this.composerController = this.surface.composer;
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
    const isDsh = this.typeKey === "deepseek-harness";
    if (!isCodex && !isDsh) return;
    if (isCodex && !message.codexTurnId) return;
    if (isDsh && message.sourceSequence === undefined) return;
    if (this.isDestroyed) return;
    try {
      const source = this.instance;
      const result = isCodex
        ? await agent.forkCodexThread(this.threadId, message.codexTurnId!)
        : await agent.forkDeepSeekHarnessThread(
            this.threadId,
            message.sourceSequence!,
          );
      const fork = useAgentSessionStore.getState().createInstance({
        agentType: this.typeKey,
        title: `${source?.title || defaultThreadTitle(this.typeKey)} (fork)`,
        threadId: result.thread.threadId,
        runtimeConfig: source?.runtimeConfig ?? buildInitialInstanceRuntimeConfig(this.typeKey),
        source: { kind: "dedicated", notebookId: source?.source.notebookId ?? null },
        role: source?.role ?? undefined,
      });
      await selectAndOpenAgentConversation(fork.instanceId);
    } catch (error) {
      logger.error(`Failed to fork ${this.typeKey} conversation`, { error });
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  private get threadId(): string | null {
    return (
      this.instance?.threadId ||
      (this.node.attrs.threadId as string | null) ||
      null
    );
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
    return this.runtime?.renderThreadId ?? this.node.attrs.threadId ?? null;
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

  private scopePathForLocalFile(filePath: string): string | null {
    return agentFileScopePathForRuntime(filePath, this.instance?.runtimeConfig);
  }

  private ensureInstanceBinding(): void {
    if (this.isDestroyed) return;
    const existingInstanceId = this.instanceId;
    if (existingInstanceId) {
      const boundInstance = this.instance;
      if (boundInstance) {
        const attrs: Record<string, unknown> = {};
        if (this.node.attrs.threadId !== boundInstance.threadId) {
          attrs.threadId = boundInstance.threadId;
        }
        const typeKey = normalizeAgentTypeKey(boundInstance.agentType);
        if (this.node.attrs.typeKey !== typeKey) {
          attrs.typeKey = typeKey;
        }
        if (Object.keys(attrs).length > 0) this.updateAttrs(attrs);
      } else if (this.hydratingInstanceId !== existingInstanceId) {
        this.hydratingInstanceId = existingInstanceId;
        void useAgentSessionStore.getState().hydrateInstance(existingInstanceId).then(
          (instance) => {
            if (this.isDestroyed || this.instanceId !== existingInstanceId) return;
            if (instance) {
              const attrs: Record<string, unknown> = {};
              if (this.node.attrs.threadId !== instance.threadId) {
                attrs.threadId = instance.threadId;
              }
              const typeKey = normalizeAgentTypeKey(instance.agentType);
              if (this.node.attrs.typeKey !== typeKey) {
                attrs.typeKey = typeKey;
              }
              if (Object.keys(attrs).length > 0) this.updateAttrs(attrs);
              this.refreshAttrs();
            }
          },
        );
      }
      return;
    }
    // Phase 5.3 修正 (2026-08-03): 改走 conv-store.createInstance, 让
    // setWithInstanceMirror 同时写两个 store. 旧路径走 session-store
    // 直接 createInstance, 但 renameAgentConversation 走 conv-store
    // renameInstance ── 在 conv-store 找不到 instance 就 no-op, 导致
    // session-store 的 instance.title 永远不更新, syncTitleText 卡在
    // 旧 title. 双写保证两个 store 的 instance 形状一致, 重命名 /
    // 角色 / runtimeConfig 后续 mutation 都能正确收敛.
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
      role: {
        memoId: this.agentRoleMemoId,
        name: this.agentRoleName,
      },
      // 这里只记录 notebookId；cwd / paths 在首次 send 前解析并冻结，避免
      // 此处 selectedNotebook / agent-access 尚未 hydrate 时写入空快照。
      runtimeConfig: buildInitialInstanceRuntimeConfig(this.typeKey),
    });
    this.updateAttrs({
      instanceId: instance.instanceId,
      threadId: existingThreadId,
      typeKey: instance.agentType,
    });
  }

  private get agentRoleMemoId(): string | null {
    const instanceValue = this.instance?.role?.memoId;
    if (typeof instanceValue === "string" && instanceValue.trim()) {
      return instanceValue.trim();
    }
    const value = this.node.attrs.agentRoleMemoId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private get agentRoleName(): string | null {
    const instanceValue = this.instance?.role?.name;
    if (typeof instanceValue === "string" && instanceValue.trim()) {
      return instanceValue.trim();
    }
    const value = this.node.attrs.agentRoleName;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private get collapsed(): boolean {
    return !!this.node.attrs.collapsed;
  }

  private get persistedFullscreen(): boolean {
    return !!this.node.attrs.fullscreen;
  }

  private get workspaceHost(): WorkspaceHostId | null {
    const host = this.dom.closest<HTMLElement>("[data-workspace-host]")
      ?.dataset.workspaceHost;
    return host === "main-third" || host === "browser-column" ? host : null;
  }

  private get inputDraft(): string {
    const value = this.node.attrs.inputDraft;
    return typeof value === "string" ? value : "";
  }

  private get inputImages(): AgentThreadCardInputImage[] {
    const value = this.node.attrs.inputImages;
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

  private updateAgentRole(role: { memoId: string; name: string }): void {
    this.updateAttrs({
      agentRoleMemoId: role.memoId,
      agentRoleName: role.name,
    });

    const instanceId = this.instanceId;
    if (!instanceId) return;
    useAgentSessionStore.getState().upsertInstance(instanceId, {
      role,
    });
  }

  private async loadAgentRoleBody(memoId: string): Promise<string | null> {
    return this.agentRolePicker.loadRoleBody(memoId);
  }

  private setComposerRolePopoverOpen(open: boolean): void {
    this.agentRolePicker.setOpen(open);
  }

  private refreshComposerRoleIcon(): void {
    this.agentRolePicker.refreshIcon();
  }

  /** 文档引用 → composer 注入为一个可独立选中/删除的行内笔记卡片。 */
  private injectMemoReference(ref: { id: string; filename: string; title: string }): void {
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
    this.dom.dataset.threadId = this.threadId ?? "";
    this.dom.dataset.title = this.title;
    this.dom.dataset.instanceId = this.instanceId ?? "";
    // typeKey getter 每次访问都跑 normalizeAgentTypeKey → getAgentType.find ──
    // 本方法同一函数内访问 2 次, 缓存到局部变量避免重复计算 (在 ProseMirror node
    // update 高频路径上累计调用很多)。
    const typeKey = this.typeKey;
    // data-agent-type carries the Agent Type key; data-agent-role-* carries
    // the optional persona memo metadata.
    this.dom.dataset.agentType = typeKey;
    this.dom.dataset.agentRoleMemoId = this.agentRoleMemoId ?? "";
    this.dom.dataset.agentRoleName = this.agentRoleName ?? "";
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
    this.refreshComposerRoleIcon();
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
    if (this.persistedFullscreen) {
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
    }
  }

  private renderFullscreenState(): void {
    this.fullscreenButton.hidden = false;
    this.actionsDivider.hidden = false;
    // 全屏模式下不展示删除按钮 ── 卡片铺满视口, 删除是破坏性操作,
    // 留出右上方空间给"退出全屏" 与"折叠" 等视图操作, 避免误删。
    this.deleteButton.hidden = this.isFullscreen;
    this.dom.classList.toggle(
      "agent-thread-card--fullscreen",
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
        this.agentRolePicker.popoverElement.contains(target))
    );
  }

  private blurOwnedFocusForOutsidePointer(event: PointerEvent): void {
    if (this.isDestroyed || this.isFullscreen) return;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !this.ownsNode(activeElement))
      return;
    const target = event.target as globalThis.Node | null;
    if (this.ownsNode(target)) return;

    const snapshot = this.captureScrollSnapshot();
    activeElement.blur();
    this.restoreScrollSnapshotAfterFocusChange(snapshot);
  }

  private clearCardNodeSelection(): void {
    if (this.isDestroyed || this.view.isDestroyed) return;
    const pos = this.getPos?.();
    if (pos === undefined) return;

    const { doc, selection } = this.view.state;
    if (
      !(selection instanceof NodeSelection) ||
      selection.from !== pos ||
      selection.node.type.name !== "agentThreadCard"
    ) {
      return;
    }

    const afterPos = Math.min(pos + this.node.nodeSize, doc.content.size);
    let nextSelection = TextSelection.near(doc.resolve(afterPos), 1);
    if (nextSelection instanceof NodeSelection) {
      nextSelection = TextSelection.near(doc.resolve(pos), -1);
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

  // 外部 session 历史 (由 thread-cache-controller 经 renderResolvedSessionMessages
  // 直接渲染、未必进 projection) 的首条 user 消息快照 ── 供孤儿卡片标题恢复。
  private resolvedFirstUserText: string | undefined;

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
    return selectRenderableThreadMessages({
      typeKey: this.typeKey,
      threadId: this.renderThreadId,
    });
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
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const a = target.closest<HTMLAnchorElement>("a[href]");
    if (!a) return;
    event.preventDefault();
    // 阻止冒泡到外层可能存在的 React handler (例如把 click 解读为'打开卡片')
    event.stopPropagation();
    const rawHref = a.getAttribute("href");
    const localPath = localFilePathFromAgentHref(rawHref);
    if (localPath) {
      const scopePath = this.scopePathForLocalFile(localPath);
      if (scopePath) {
        void Promise.resolve(openBrowserColumnFileBrowser(scopePath, localPath)).catch((error) => {
          logger.error("Failed to open workspace file link", { error });
          toast.error(this.t("agent.link.openLocalFileFailed"));
        });
        return;
      }

      if (isEditableTextFilePath(localPath)) {
        const parentPath = localPath.replace(/[\\/][^\\/]*$/, '') || localPath;
        void Promise.resolve(openBrowserColumnText(localPath, parentPath)).catch((error) => {
          logger.error("Failed to open standalone text file link", { error });
          toast.error(this.t("agent.link.openLocalFileFailed"));
        });
        return;
      }
      void openPath(localPath).catch((error) => {
        logger.error("Failed to open local file link", { error });
        toast.error(this.t("agent.link.openLocalFileFailed"));
      });
      return;
    }
    const href = normalizePlainLinkHref(rawHref);
    if (!href) return;
    if (href.startsWith("flowix://")) {
      void openNoteByDeepLink(href);
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      void Promise.resolve(openBrowserColumnWebpage(href)).catch((error) => {
        logger.error("Failed to open webpage link in browser column", { error });
      });
      return;
    }
    void openUrl(href).catch((error) => {
      logger.error("Failed to open external link", { error });
    });
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

    // 输入框运行期不再 disabled ── Codex 可以继续输入并转入串行队列；
    // 其它 agent 仍在 submit() 中等待当前运行结束。空输入时 send 按钮
    // 继续显示 stop，已有输入时切换为 send。
    this.composerController.setSendButtonState();
    const queued = useAgentSessionStore.getState().pendingSteeringMessages[this.threadId ?? ""] ?? [];
    this.queuedMessages.hidden = queued.length === 0;
    this.queuedMessages.replaceChildren(
      ...queued.map((message) => {
        const row = document.createElement("div");
        row.className = "agent-background-terminals__queue-row";
        const mark = document.createElement("span");
        mark.className = "agent-background-terminals__queue-mark";
        mark.append(createArrowBendDownRightIcon());
        const text = document.createElement("span");
        text.textContent = message.content;
        row.append(mark, text);
        return row;
      }),
    );
    this.renderMetaState(state, runtimeView.isBusy);

    this.messages.render({
      messages,
      isLoading: runtimeView.showLoadingIndicator,
      shouldRenderMessages,
    });

    // 标题恢复: 没有显式标题 (孤儿卡片 / 持久化失败 / threadId 漂移) 时,
    // 消息加载完成后从首条 user 消息现取标题。syncTitleText 在标题编辑态
    // no-op, 已有真实标题的卡片 hasExplicitTitle 为 true 跳过, 零开销。
    if (!this.chrome.hasExplicitTitle()) {
      this.chrome.syncTitleText();
    }
  }

  private renderResolvedSessionMessages(
    messages: ThreadState["messages"],
  ): void {
    if (this.isDestroyed || !this.dom.isConnected) return;
    if (messages.length === 0) return;
    // 缓存首条 user 消息, 供孤儿卡片标题恢复 (见 firstUserMessageText)。
    const firstUser = getAgentThreadCardUserHistoryMessagesFromMessages(messages)[0];
    this.resolvedFirstUserText = firstUser && firstUser.trim() ? firstUser : undefined;
    const shouldRenderMessages = !this.collapsed || this.isFullscreen;
    this.dom.classList.remove("agent-thread-card--thread-cache-loading");
    this.messages.render({
      messages: shouldRenderMessages ? messages : [],
      isLoading: false,
      shouldRenderMessages,
    });
    // 同 renderThreadState: 外部 session (如 claude jsonl) 消息异步到位后,
    // 给孤儿卡片一次标题恢复机会。
    if (!this.chrome.hasExplicitTitle()) {
      this.chrome.syncTitleText();
    }
  }

  // 提取当前 thread 的 user 消息列表 (按时间顺序, 旧 → 新) ──
  // 仅做"前端有"的范围, 不主动去后台拉历史 (hasMoreHistory / loadMoreHistory),
  // 也不读 agent role memo ── 用户的措辞是"次级需求", 用前端可见数据
  // 就够了, 拉历史会拖慢键盘响应。 跳过空 content 防止 typing 期
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
    // 外部 session 的历史消息由 thread-cache-controller 经
    // renderResolvedSessionMessages 直接渲染, 不一定进 projection ──
    // 孤儿卡片 (无 DB 行) 的消息只走这条路径, 故此处回退到缓存的
    // resolved 快照里的首条 user 消息。
    if (this.resolvedFirstUserText && this.resolvedFirstUserText.trim()) {
      return this.resolvedFirstUserText;
    }
    return undefined;
  }

  private clearComposerAfterSlashCommand(): void {
    this.composerController.clear();
    this.composerController.clearDraft();
    this.composerImages.clearAfterSubmit();
    this.updateAttrs({ inputDraft: null });
    this.composerController.updateMultiLineState();
  }

  private async ensureDshCommandConversation(command: string) {
    if (this.typeKey !== "deepseek-harness") {
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
      role: {
        memoId: this.agentRoleMemoId,
        name: this.agentRoleName,
      },
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

  private async runDshCommandFromCard(command: string, imagePaths: string[] = []): Promise<void> {
    if (this.isDestroyed || this.typeKey !== "deepseek-harness") return;
    await runDshCommand({
      command,
      imagePaths,
      ensureConversation: (value) => this.ensureDshCommandConversation(value),
      onError: (message) => toast.error(message),
      onLogError: (message, error) => logger.error(message, { error }),
      onSaveExport: async (filename, content) => {
        const target = await dialogs.saveFile(
          filename,
          [{ name: "JSON", extensions: ["json"] }],
        );
        if (!target) return;
        const written = await dialogs.writeExportFile(target, content);
        toast[written ? "success" : "error"](
          written ? "DSH 会话已导出。" : "DSH 会话导出失败。",
        );
      },
      onFocus: () => {
        if (!this.isDestroyed) focusWithoutScroll(this.input);
      },
      sendFailedText: this.t("editor.threadCard.sendFailed"),
    });
  }

  private async submit(): Promise<void> {
    // 落盘待写草稿 ── 提交时 input 即将被清空, 之前的 debounce 必须
    // 立刻写入 ProseMirror attr, 否则卡片重新挂载会丢稿。
    this.flushPendingDraft();
    const rawPrompt = this.composerController.getPrompt().trim();
    const imagePaths = this.composerImages.readyImages.map((image) => image.path);
    if ((!rawPrompt && imagePaths.length === 0) || this.composerImages.hasPending) return;

    // Human DSH commands are handled by the command registry. Keep them out
    // of chat_stream so `/goal` and `/plan` retain their upstream semantics.
    if (
      this.typeKey === "deepseek-harness" &&
      /^\/(?:goal|plan)(?:\s|$)/iu.test(rawPrompt)
    ) {
      this.clearComposerAfterSlashCommand();
      void this.runDshCommandFromCard(rawPrompt, imagePaths);
      return;
    }

    // 运行期 (thread state isLoading / 正在创建 thread) 阻止发送 ──
    // 输入框保持可用 (允许用户继续输入 / 改稿), 但 Enter 与 send 按钮
    // (按钮在 isLoading 时是 stop 图标) 都无法真正投递消息。 当前草稿
    // 保留在编辑器内, 不调 persistInputDraft("") / 直接改 DOM 清空。
    // 清空; 用户可在运行结束后再次按 Enter 投递同一段草稿。
    //
    // 输入框不 disabled; busy 时只阻止发送, 用户仍可继续编辑草稿。
    if (
      this.currentRuntimeView().isBusy &&
      this.typeKey !== "codex" &&
      this.typeKey !== "deepseek-harness"
    ) return;
    if (this.typeKey === "deepseek-harness" && hasPendingDshCommand(this.threadId)) return;

    // 提取全文档作为隐藏 LLM 上下文 ── 跳过本卡 (agentThreadCard), 避免把
    // LLM 自己之前的回答 / 工具结果当成'笔记内容'再喂回去造成循环。
    // 空文档 / 全部是 card 的笔记会得到空上下文。
    const documentContext = extractDocumentContext(this.view);
    const submitGeneration = ++this.submitGeneration;

    this.composerController.resetHistoryNavigation();
    // 清空草稿是"已知终态", 不必走 debounce ── 直接 updateAttrs 同步
    // 落 ProseMirror attr, 避免后续 reload / 跨卡片挂载时拿到旧 draft。
    // 同时把 pending draft 清掉 (若之前有未触发的 debounce), 防止空 input
    // 被旧 snapshot 误保护。
    this.composerController.clearDraft();
    this.composerController.clear();
    this.composerImages.clearAfterSubmit();
    this.updateAttrs({ inputDraft: null, inputImages: [] });
    this.composerController.updateMultiLineState();

    const source = getCurrentThreadCardSource();
    try {
      if (!this.threadId) {
        this.isCreating = true;
        this.renderThreadState();
      }
      await submitAgentThreadCardConversation({
        prompt: rawPrompt || "Analyze the attached image(s).",
        imagePaths,
        fallbackTitle: this.t("editor.threadCard.title"),
        typeKey: this.typeKey,
        currentThreadId: this.threadId,
        currentInstanceId: this.instanceId,
        currentTitle: this.instance?.title ?? "",
        runtimeHandleId: this.runtimeHandleId,
        source,
        role: {
          memoId: this.agentRoleMemoId,
          name: this.agentRoleName,
        },
        isFirstMessage: this.currentMessages().length === 0,
        documentContext,
        buildTitle,
        loadAgentRoleBody: (memoId) => this.loadAgentRoleBody(memoId),
        onThreadBound: (binding) => {
          if (
            this.isDestroyed ||
            submitGeneration !== this.submitGeneration
          ) {
            return;
          }
          // Persist the card binding only after the optimistic user message has
          // entered the store. Otherwise the node attr update schedules history
          // cache loading while the message list is still empty, producing a
          // visible delay before the just-sent message appears.
          this.updateAttrs({
            instanceId: binding.instanceId,
            threadId: binding.threadId,
            typeKey: binding.typeKey,
          });
        },
      });
    } catch (err) {
      const message = errorMessage(err).trim();
      toast.error(message || this.t("editor.threadCard.sendFailed"));
    } finally {
      this.isCreating = false;
      this.renderThreadState();
      focusWithoutScroll(this.input);
    }
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
    this.setComposerRolePopoverOpen(false);
    this.isDestroyed = true;
    this.releaseThreadInterest?.();
    this.releaseThreadInterest = null;
    this.interestedThreadId = null;
    this.surface.dispose();
    this.body.removeEventListener("scroll", this.boundHandleBodyScroll);
    this.runtime.dispose();
    this.externalAgentSettings.dispose();
    this.agentRolePicker.dispose();
    this.composerAddMenu.dispose();
    this.codexSettingsDialog.close();
    this.fullscreenLayout.dispose();
    this.composerImages.dispose();
  }
}
