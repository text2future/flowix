import { openUrl } from "@tauri-apps/plugin-opener";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type {
  EditorView,
  NodeView as ProseMirrorNodeView,
} from "@tiptap/pm/view";
import { createRoot } from "react-dom/client";
import {
  useChatStore,
  type ThreadState,
} from "@features/agent/store/chat-store";
import {
  useAgentConversationStore,
} from "@features/agent/store/agent-conversation-store";
import { selectRenderableThreadMessages } from "@features/agent/store/thread-render-messages";
import { translate, type AppLanguage, type I18nKey } from "@features/i18n";
import type { AgentTypeKey } from "@/types/agent";
import type { QuickPhrase } from "@/lib/constants";
import { stripSystemBlock } from "@features/agent/message";
import { openNoteByDeepLink } from "@platform/open-target";
import { windows } from "@platform/tauri/client";
import { isWindowsPlatform } from "@features/shortcuts";
import { normalizePlainLinkHref } from "@features/editor/extensions/markdown-link";
import { normalizeAgentTypeKey } from "@/lib/agent-types";
import { useUserSettingsStore } from "@features/preferences/store/user-settings-store";
import type { AgentRuntimeSettingKind } from "@features/agent/runtime/agent-runtime-spec";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import {
  stopExternalAgentThreadCardRun,
} from "@features/agent/services/external-agent-runtime-service";
import { submitAgentThreadCardConversation } from "@features/editor/extensions/agent-thread-card/agent-thread-card-submit-controller";
import { createFullscreenIcon } from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";
import { createAgentThreadCardDom } from "@features/editor/extensions/agent-thread-card/view/agent-thread-card-dom-factory";
import { AgentThreadCardChromeController } from "@features/editor/extensions/agent-thread-card/chrome";
import { AccessPopoverController } from "@features/editor/extensions/agent-thread-card/access";
import { ExternalAgentSettingsController } from "@features/editor/extensions/agent-thread-card/settings/external-agent-settings-controller";
import { AgentRolePickerController } from "@features/editor/extensions/agent-thread-card/role/agent-role-picker-controller";
import { FullscreenLayoutController } from "@features/editor/extensions/agent-thread-card/fullscreen/fullscreen-layout-controller";
import {
  ComposerController,
  ComposerDraftController,
  getAgentThreadCardUserHistoryMessagesFromMessages,
} from "@features/editor/extensions/agent-thread-card/composer";
import {
  AgentThreadCardMessagesController,
  createThreadCacheSkeleton,
} from "@features/editor/extensions/agent-thread-card/messages";
import {
  AgentThreadCardRuntimeController,
  getCurrentThreadCardSource,
  renderAgentThreadCardMetaState,
} from "@features/editor/extensions/agent-thread-card/runtime";
import {
  canSkipMessageRebuild,
  consumeEditorPopoverDismissPointer,
  extractDocumentContext,
  focusWithoutScroll,
  getEventElement,
  isAgentThreadCardInteractiveTarget,
  isAgentThreadCardSelectableMessageText,
  type ScrollSnapshot,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-dom";
import {
  selectAgentThreadCardRuntimeView,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-selectors";

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
const WINDOWS_TITLEBAR_HEIGHT_PX = 36;
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
  const title = stripSystemBlock(prompt).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 28) : fallback;
}

const AGENT_THREAD_CARD_HEADER_DRAG_THRESHOLD_PX = 4;

export class AgentThreadCardView implements ProseMirrorNodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;

  private node: ProseMirrorNode;
  private view: EditorView;
  private getPos: (() => number | undefined) | undefined;
  private input: HTMLTextAreaElement;
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
  private errorEl: HTMLElement;
  // 消息区底部 loading 指示器 ── 24px 固定高度, 始终挂在 body 末尾。
  // 容器永远在 DOM 里 (保证 24px 空间不被流式更新挤掉), 内部的文字
  // "思考中" 仅在 isLoading 为 true 时显示 ── 与面板 agent-thinking-indicator
  // 反馈保持一致。
  private loadingIndicator: HTMLDivElement;
  private collapseButton: HTMLButtonElement;
  private deleteButton: HTMLButtonElement;
  private fullscreenButton: HTMLButtonElement;
  private fullscreenLayout: FullscreenLayoutController;
  private composerDraft: ComposerDraftController;
  private composerController: ComposerController;
  private messages: AgentThreadCardMessagesController;
  private runtime: AgentThreadCardRuntimeController;
  // 全屏 / 删除按钮之间的竖向分割线 ── 非交互元素, aria-hidden 让屏幕
  // 阅读器跳过; 视觉与按钮同高 (28px), 1px var(--border) 着色。
  // 可见性与 fullscreenButton 同步 (renderFullscreenState 一起切 hidden)。
  private actionsDivider: HTMLSpanElement;
  private accessButton: HTMLButtonElement;
  private accessPopover: HTMLDivElement;
  private accessPopoverController: AccessPopoverController;
  private externalAgentSettings: ExternalAgentSettingsController;
  private externalSettingsLoadedTypeKey: AgentTypeKey | null = null;
  private agentRolePicker: AgentRolePickerController;
  private isCreating = false;
  private isDestroyed = false;
  private isFullscreen = false;
  private fullscreenRestoreGeneration = 0;
  private fullscreenRestorePending = false;
  private fullscreenRestoreFrame: number | null = null;
  /** 偏好设置中 quickPhrases 数组引用变化时的 unsubscribe ── 弹窗打开时实时刷新。 */
  private unsubscribeQuickPhrases: (() => void) | null = null;
  private boundHandleBodyScroll = (): void => {
    this.messages.handleScroll();
    this.scheduleAccessPopoverPosition();
  };
  private boundHandleRequestFullscreen = (event: Event): void => {
    const detail = (event as CustomEvent<{
      element?: HTMLElement;
      threadId?: string | null;
      exitOthers?: boolean;
    }>).detail;
    const isTarget =
      detail?.element === this.dom ||
      (!!detail?.threadId && detail.threadId === this.threadId);

    if (isTarget) {
      this.setFullscreen(true);
      return;
    }

    if (detail?.exitOthers !== false && this.isFullscreen) {
      this.setFullscreen(false);
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
  /** 当前 AppLanguage ── NodeView 不在 React 树里, 不能用 useI18n,
   *  走 user-settings-store 读最新值 (跨窗口同步跟 I18nProvider 一致)。 */
  private get language(): AppLanguage {
    return useUserSettingsStore.getState().settings.language;
  }

  /** 翻译: NodeView 内部所有面向用户的字符串走这里, 切换语言时由
   *  rerender 文案刷新, 不依赖 React 重渲染整张卡片。 */
  private t(key: I18nKey): string {
    return translate(this.language, key);
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
      onBodyClick: this.handleBodyClick,
      onBodyScroll: this.boundHandleBodyScroll,
      onAccessClick: (event) => {
        // 指令按钮：暂时去掉弹窗，后续再设计
        event.stopPropagation();
      },
      onComposerMouseDown: (event) => {
        const target = event.target as HTMLElement | null;
        if (!target || target.closest("textarea, button")) return;
        event.stopPropagation();
        focusWithoutScroll(this.input);
      },
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
        this.setAccessPopoverOpen(false);
        this.setCodexSettingsPopoverOpen(false);
        this.setComposerRolePopoverOpen(false);
      },
      dragThresholdPx: AGENT_THREAD_CARD_HEADER_DRAG_THRESHOLD_PX,
      getAttrTitle: () => this.node.attrs.title as string | null,
      getAttrTypeKey: () => this.node.attrs.typeKey as string | null,
      getInstanceTitle: () => this.instance?.title,
      getThreadId: () => this.threadId,
      getInstanceId: () => this.instanceId,
      getTypeKey: () => this.typeKey,
      updateAttrs: (attrs) => this.updateAttrs(attrs),
      t: (key) => this.t(key),
      getThreadState: () => this.currentThreadState(),
      getPersistedRun: () => this.instance?.run ?? undefined,
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
    this.errorEl = domParts.errorEl;
    this.composer = domParts.composer;
    this.composerRoleIcon = domParts.composerRoleIcon;
    this.input = domParts.input;
    this.accessButton = domParts.accessButton;
    this.accessPopover = domParts.accessPopover;
    this.sendButtonMount = domParts.sendButtonMount;

    const { codexSettingsPopover, composerRolePopover } = domParts;
    this.externalAgentSettings = new ExternalAgentSettingsController({
      popover: codexSettingsPopover,
      getTypeKey: () => this.typeKey,
      getInstanceId: () => this.instanceId ?? undefined,
      getLanguage: () => this.language,
      t: (key) => this.t(key),
      isDestroyed: () => this.isDestroyed,
      isAccessPopoverOpen: () => this.accessPopoverController.isOpen,
      setAccessPopoverOpen: (open, anchor = null, preferBelow = true) => {
        this.setAccessPopoverOpen(open, anchor, preferBelow);
      },
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
    });

    this.agentRolePicker = new AgentRolePickerController({
      trigger: this.composerRoleIcon,
      popover: composerRolePopover,
      t: (key) => this.t(key),
      isDestroyed: () => this.isDestroyed,
      getCurrentMemoId: () => this.agentRoleMemoId,
      getCurrentName: () => this.agentRoleName,
      getMessageCount: () => this.currentMessages().length,
      updateRole: (role) => this.updateAgentRole(role),
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
      injectPrompt: (text) => this.injectQuickPhrasePrompt(text),
      openPreferences: () => this.openPreferencesForQuickPhrases(),
    });
    this.accessPopoverController = new AccessPopoverController({
      button: this.accessButton,
      popover: this.accessPopover,
      t: (key) => this.t(key),
      isDestroyed: () => this.isDestroyed,
      isInsideRelatedTarget: (target) =>
        !!(
          this.externalAgentSettings.filesControl?.contains(target) ||
          this.composerRoleIcon.contains(target)
      ),
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
      getInstanceId: () => this.instanceId ?? undefined,
    });
    this.fullscreenLayout = new FullscreenLayoutController({
      dom: this.dom,
      isFullscreen: () => this.isFullscreen,
      isDestroyed: () => this.isDestroyed,
      getTitlebarHeight: () =>
        isWindowsPlatform() ? WINDOWS_TITLEBAR_HEIGHT_PX : 0,
      minExitTopPx: FULLSCREEN_EXIT_FALLBACK_MIN_TOP_PX,
      maxExitTopPx: FULLSCREEN_EXIT_FALLBACK_MAX_TOP_PX,
      exitTopRatio: FULLSCREEN_EXIT_FALLBACK_TOP_RATIO,
      scrollDeltaEpsilonPx: SCROLL_DELTA_EPSILON_PX,
    });
    this.composerDraft = new ComposerDraftController({
      persistDelayMs: AGENT_THREAD_CARD_DRAFT_PERSIST_DEBOUNCE_MS,
      persist: (draft) => this.updateAttrs({ inputDraft: draft }),
    });
    this.runtime = new AgentThreadCardRuntimeController({
      getCurrentThreadId: () => this.threadId,
      getStoredThreadId: () =>
        (this.node.attrs.threadId as string | null) || null,
      getTypeKey: () => this.typeKey,
      getInstanceId: () => this.instanceId,
      isDestroyed: () => this.isDestroyed,
      updateConversationThread: (instanceId, update) => {
        useAgentConversationStore.getState().updateThread(instanceId, update);
      },
      updateAttrs: (attrs) => this.updateAttrs(attrs),
      renderThreadState: () => this.renderThreadState(),
      refreshAttrs: () => this.refreshAttrs(),
      refreshExternalAgentEmptySettings: () =>
        this.refreshExternalAgentEmptySettings(),
      isExternalSettingsOpen: () => this.externalAgentSettings.isOpen,
      renderCodexSettingsPopover: () => this.renderCodexSettingsPopover(),
      isAccessPopoverOpen: () => this.accessPopoverController.isOpen,
      renderAccessPopover: () => this.renderAccessPopover(),
      syncRuntimeBadge: () => this.chrome.syncRuntimeBadge(),
    });
    this.messages = new AgentThreadCardMessagesController({
      dom: this.dom,
      body: this.body,
      loadingIndicator: this.loadingIndicator,
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
        void useAgentConversationStore
          .getState()
          .loadMoreMessages(this.typeKey, threadId);
      },
      getLanguage: () => this.language,
      getTypeKey: () => this.typeKey,
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
    });

    this.composerController = new ComposerController({
      input: this.input,
      composer: this.composer,
      draft: this.composerDraft,
      sendButtonRoot: createRoot(this.sendButtonMount),
      inputDraftMaxChars: AGENT_THREAD_CARD_INPUT_DRAFT_MAX_CHARS,
      getCurrentInputDraft: () => this.inputDraft,
      getUserHistoryMessages: () => this.getUserHistoryMessages(),
      getSendLabel: (wantStop) =>
        wantStop
          ? this.t("editor.threadCard.stop")
          : this.t("editor.threadCard.send"),
      getSendButtonWantsStop: () =>
        this.currentRuntimeView().sendButtonWantsStop,
      submit: () => {
        void this.submit();
      },
      stop: () => {
        void stopExternalAgentThreadCardRun(this.runtimeHandleId, this.threadId);
      },
    });
    this.composerController.setSendButtonState("");

    this.refreshAttrs();
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
    this.subscribeQuickPhrases();
    queueMicrotask(() => this.ensureInstanceBinding());
    this.schedulePersistedFullscreenRestore();
  }

  private get threadId(): string | null {
    return (
      this.instance?.threadId ||
      (this.node.attrs.threadId as string | null) ||
      null
    );
  }

  private get runtimeHandleId(): string {
    return this.runtime.runtimeHandleId;
  }

  private get runtimeThreadId(): string | null {
    return this.runtime.runtimeThreadId;
  }

  private get renderThreadId(): string | null {
    return this.runtime.renderThreadId;
  }

  private get title(): string {
    return this.chrome.getTitle();
  }

  private get typeKey(): AgentTypeKey {
    return this.instance?.agentType ?? normalizeAgentTypeKey(this.node.attrs.typeKey as string | null);
  }

  private get instanceId(): string | null {
    const value = this.node.attrs.instanceId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private get instance() {
    return useAgentConversationStore.getState().getInstance(this.instanceId);
  }

  private ensureInstanceBinding(): void {
    if (this.isDestroyed || this.instanceId) return;
    const instance = useAgentConversationStore.getState().createInstance({
      agentType: this.typeKey,
      title: this.title,
      threadId: this.threadId,
      source: getCurrentThreadCardSource(),
      role: {
        memoId: this.agentRoleMemoId,
        name: this.agentRoleName,
      },
      // 把 cwd / folders 快照写进 instance, 不再只靠前端 runtimeConfig
      // 兜底链 (启动 race 窗口内 selectedNotebook / agent-access 还没
      // hydrate 时, 兜底链可能全断导致 Claude Code CLI exit 1).
      runtimeConfig: buildInitialInstanceRuntimeConfig(this.typeKey),
    });
    this.updateAttrs({
      instanceId: instance.instanceId,
      threadId: instance.threadId,
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

  private get inputDraft(): string {
    const value = this.node.attrs.inputDraft;
    return typeof value === "string" ? value : "";
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

    this.input.value = initialPrompt;
    this.composerController.updateMultiLineState();

    requestAnimationFrame(() => {
      if (this.isDestroyed) return;
      void this.submit();
    });
  }

  private loadCodexDefaultModel(): void {
    this.externalAgentSettings.loadDefaultModel();
  }

  private setAccessPopoverOpen(
    open: boolean,
    anchor: HTMLElement | null = null,
    preferBelow = true,
  ): void {
    this.accessPopoverController.setOpen(open, anchor, preferBelow);
  }

  private renderAccessPopover(): void {
    this.accessPopoverController.render();
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
    useAgentConversationStore.getState().upsertInstance(instanceId, {
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

  /** 订阅常用语列表变化 ── 弹窗打开时如果用户在偏好设置改了列表, 这里实时刷新。 */
  private subscribeQuickPhrases(): void {
    if (this.unsubscribeQuickPhrases) return;
    const readPhrases = (): QuickPhrase[] =>
      useUserSettingsStore.getState().settings.agents?.quickPhrases ?? [];
    let lastPhrases = readPhrases();
    this.unsubscribeQuickPhrases = useUserSettingsStore.subscribe((state) => {
      const next = state.settings.agents?.quickPhrases ?? [];
      if (next === lastPhrases) return;
      lastPhrases = next;
      this.agentRolePicker.refresh();
    });
  }

  /** 常用语 → composer 注入 prompt: 覆盖输入框 + 持久化 draft + 重置历史游标。 */
  private injectQuickPhrasePrompt(text: string): void {
    this.composerController.setHistoryValue(text, { persistDraft: true });
    this.composerController.resetHistoryNavigation();
    this.composerController.updateMultiLineState();
    this.input.focus();
  }

  /** 打开偏好设置, 跳到「工具」tab ── 弹窗内「添加常用语」按钮使用。 */
  private openPreferencesForQuickPhrases(): void | Promise<void> {
    return windows.openPreferences("tools");
  }

  private scheduleAccessPopoverPosition(): void {
    this.accessPopoverController.schedulePosition();
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
    const pos = this.getPos?.();
    if (pos === undefined) return;

    const nextAttrs = { ...this.node.attrs, ...attrs };
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
    if (
      this.composerDraft.oversizedValue !== null &&
      this.input.value === this.composerDraft.oversizedValue
    ) {
      // Oversized drafts are intentionally not persisted, but the user should
      // still be able to keep typing and send the current in-DOM value.
    }
    // Do not rewrite input.value from attrs during refresh. The textarea is
    // the live editing source; inputDraft is only the persisted remount value.
    // submit / initial prompt / history navigation update the DOM explicitly.
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
    window.requestAnimationFrame(() => this.chrome.syncBadgeHoverCardPosition());

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
    } else {
      this.dom.removeAttribute("role");
      this.dom.removeAttribute("aria-modal");
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
        this.accessPopoverController.popoverElement.contains(target) ||
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

  private captureFullscreenReturnAnchor(): void {
    this.fullscreenLayout.captureReturnAnchor();
  }

  private focusFullscreenSurface(): void {
    window.requestAnimationFrame(() => {
      if (!this.isFullscreen || this.isDestroyed) return;
      this.input.focus({ preventScroll: true });
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

  private currentThreadState(): ThreadState | undefined {
    const threadId = this.renderThreadId;
    return threadId
      ? useChatStore.getState().threadStates[threadId]
      : undefined;
  }

  private currentRuntimeView(state: ThreadState | undefined = this.currentThreadState()) {
    return selectAgentThreadCardRuntimeView({
      state,
      conversationRun: this.instance?.run ?? undefined,
      isCreating: this.isCreating,
      isLoading: !!state?.isLoading,
      typeKey: this.typeKey,
    });
  }

  private currentConversationMessageState() {
    const threadId = this.renderThreadId;
    return threadId
      ? useAgentConversationStore.getState().getMessageState(threadId)
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
    const href = normalizePlainLinkHref(a.getAttribute("href"));
    if (!href) return;
    if (href.startsWith("flowix://")) {
      void openNoteByDeepLink(href);
      return;
    }
    void openUrl(href).catch((error) => {
      console.error("Failed to open agent thread card link:", error);
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
      conversationRun: this.instance?.run ?? undefined,
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

    // 输入框运行期不再 disabled ── 允许用户继续输入 / 改稿, 草稿保留
    // 在 this.input.value, 等运行结束后再次按 Enter 即可投递。 真正的
    // 拦截在 submit() 里: isBusy 时早返, 不清空 input.value, 也不触发
    // ensureAgentThreadCardThread / sendMessageToThread。
    //
    // send 按钮仍交给 ComposerController 处理 ── runtimeView 判定忙碌时
    // wantStop=true, 渲染 stop 图标 + 走 stopExternalAgentThreadCardRun。
    this.composerController.setSendButtonState();
    this.renderMetaState(state, runtimeView.isBusy);

    this.messages.render({
      messages,
      isLoading: runtimeView.showLoadingIndicator,
      shouldRenderMessages,
    });
  }

  private setError(message: string | null): void {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message ?? "";
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

  private async submit(): Promise<void> {
    // 落盘待写草稿 ── 提交时 input 即将被清空, 之前的 debounce 必须
    // 立刻写入 ProseMirror attr, 否则卡片重新挂载会丢稿。
    this.flushPendingDraft();
    const rawPrompt = this.input.value.trim();
    if (!rawPrompt) return;

    // 运行期 (thread state isLoading / 正在创建 thread) 阻止发送 ──
    // 输入框保持可用 (允许用户继续输入 / 改稿), 但 Enter 与 send 按钮
    // (按钮在 isLoading 时是 stop 图标) 都无法真正投递消息。 当前草稿
    // 保留在 this.input.value, 不调 persistInputDraft("") / input.value=""
    // 清空; 用户可在运行结束后再次按 Enter 投递同一段草稿。
    //
    // 输入框不 disabled; busy 时只阻止发送, 用户仍可继续编辑草稿。
    if (this.currentRuntimeView().isBusy) return;

    // 提取全文档作为隐藏 LLM 上下文 ── 跳过本卡 (agentThreadCard), 避免把
    // LLM 自己之前的回答 / 工具结果当成'笔记内容'再喂回去造成循环。
    // 空文档 / 全部是 card 的笔记会得到空上下文。
    const documentContext = extractDocumentContext(this.view);

    this.input.value = "";
    this.composerController.resetHistoryNavigation();
    // 清空草稿是"已知终态", 不必走 debounce ── 直接 updateAttrs 同步
    // 落 ProseMirror attr, 避免后续 reload / 跨卡片挂载时拿到旧 draft。
    // 同时把 pending draft 清掉 (若之前有未触发的 debounce), 防止空 input
    // 被旧 snapshot 误保护。
    this.composerController.clearDraft();
    this.updateAttrs({ inputDraft: null });
    this.composerController.updateMultiLineState();
    this.setError(null);
    this.renderThreadState();

    const source = getCurrentThreadCardSource();
    try {
      if (!this.threadId) {
        this.isCreating = true;
        this.renderThreadState();
      }
      await submitAgentThreadCardConversation({
        prompt: rawPrompt,
        fallbackTitle: this.t("editor.threadCard.title"),
        typeKey: this.typeKey,
        currentThreadId: this.threadId,
        currentInstanceId: this.instanceId,
        currentTitle: this.title,
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
      this.setError(
        typeof err === "string" ? err : this.t("editor.threadCard.sendFailed"),
      );
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
    this.setFullscreen(false, { persist: false, fromRestore: true });
    window.removeEventListener(
      AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT,
      this.boundHandleRequestFullscreen,
    );
    this.setAccessPopoverOpen(false);
    this.setCodexSettingsPopoverOpen(false);
    this.unsubscribeQuickPhrases?.();
    this.unsubscribeQuickPhrases = null;
    this.dom.removeEventListener("mousedown", this.boundHandleCardMouseDown);
    this.chrome.dispose();
    document.removeEventListener(
      "pointerdown",
      this.boundHandleOutsidePointerDown,
      true,
    );
    this.setComposerRolePopoverOpen(false);
    this.isDestroyed = true;
    this.messages.dispose();
    this.body.removeEventListener("scroll", this.boundHandleBodyScroll);
    this.runtime.dispose();
    this.accessPopoverController.dispose();
    this.externalAgentSettings.dispose();
    this.agentRolePicker.dispose();
    this.fullscreenLayout.dispose();
    this.composerController.dispose();
  }
}
