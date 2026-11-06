import type { I18nKey } from "@/lib/i18n";
import {
  createChevronIcon,
  createFullscreenIcon,
  createOpenInColumnIcon,
  createTrashIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";
import { createAgentComposerDom } from "@features/agent/thread-card/composer";
import { createOverlayScrollbarDom } from "@shared/ui/overlay-scrollbar-dom";

export interface AgentThreadCardDomFactoryOptions {
  inputDraft: string;
  t: (key: I18nKey) => string;
  onCardMouseDown: (event: MouseEvent) => void;
  onTitleDoubleClick: (event: MouseEvent) => void;
  onDeleteClick: (event: MouseEvent) => void;
  onOpenInBrowserColumnClick: (event: MouseEvent) => void;
  onFullscreenClick: (event: MouseEvent) => void;
  onCollapseClick: (event: MouseEvent) => void;
  onBodyClick: (event: MouseEvent) => void;
  onBodyScroll: (event: Event) => void;
  onBodyWheel: (event: WheelEvent) => void;
  // onComposerMouseDown 已废弃 ── composer 内部委托现由
  // createAgentComposerDom 自带 pointerdown 监听统一负责 (详见
  // composer-dom-factory.ts COMPOSER_FOCUS_INTERACTIVE_SELECTOR 注释),
  // 不必再从外层透传。保留位置仅占位, 实际未消费。
}

export interface AgentThreadCardDomParts {
  dom: HTMLElement;
  container: HTMLDivElement;
  header: HTMLDivElement;
  titleEl: HTMLElement;
  badgeEl: HTMLSpanElement;
  badgeIcon: HTMLSpanElement;
  badgeName: HTMLSpanElement;
  badgeHoverCardMount: HTMLSpanElement;
  metaEl: HTMLElement;
  runStatusEl: HTMLSpanElement;
  actionsDivider: HTMLSpanElement;
  deleteButton: HTMLButtonElement;
  openInBrowserColumnButton: HTMLButtonElement;
  fullscreenButton: HTMLButtonElement;
  collapseButton: HTMLButtonElement;
  body: HTMLElement;
  disposeBodyScrollbar: () => void;
  loadingIndicator: HTMLDivElement;
  queuedMessages: HTMLDivElement;
  /** Mount point for the Cloud access card (signed out / no credits). */
  cloudAccess: HTMLDivElement;
  composer: HTMLElement;
  inputRow: HTMLDivElement;
  composerActions: HTMLDivElement;
  composerRoleIcon: HTMLButtonElement;
  composerAddPopover: HTMLDivElement;
  input: HTMLDivElement;
  codexSettingsPopover: HTMLDivElement;
  composerRolePopover: HTMLDivElement;
  sendButtonMount: HTMLSpanElement;
  scrollToLatestButton: HTMLButtonElement;
}

export function createAgentThreadCardDom(
  options: AgentThreadCardDomFactoryOptions,
): AgentThreadCardDomParts {
  const dom = document.createElement("section");
  dom.className = "agent-thread-card agent-conversation-surface";
  dom.contentEditable = "false";
  dom.tabIndex = -1;
  dom.dataset.agentThreadCard = "true";
  dom.addEventListener("mousedown", options.onCardMouseDown);

  const container = document.createElement("div");
  container.className = "agent-thread-card__container";

  const header = document.createElement("div");
  header.className = "agent-thread-card__header";

  const agentWrap = document.createElement("div");
  agentWrap.className = "agent-thread-card__agent";

  const badgeEl = document.createElement("span");
  badgeEl.className = "agent-type-badge";
  const badgeIcon = document.createElement("span");
  badgeIcon.className = "agent-type-badge__icon";
  badgeIcon.setAttribute("aria-hidden", "true");
  const badgeName = document.createElement("span");
  badgeName.className = "agent-type-badge__name";
  badgeName.hidden = true;
  badgeEl.append(badgeIcon, badgeName);

  const titleEl = document.createElement("div");
  titleEl.className = "agent-thread-card__title";
  titleEl.addEventListener("dblclick", options.onTitleDoubleClick);

  const badgeHoverCardMount = document.createElement("span");
  badgeHoverCardMount.className =
    "agent-thread-card__badge-hover-card-mount";
  badgeHoverCardMount.setAttribute("aria-hidden", "true");
  agentWrap.append(badgeEl, badgeHoverCardMount, titleEl);

  const metaEl = document.createElement("div");
  metaEl.className = "agent-thread-card__meta";
  const runStatusEl = document.createElement("span");
  runStatusEl.className =
    "agent-thread-card__run-status agent-thread-card__run-status--idle";
  runStatusEl.textContent = "";
  runStatusEl.hidden = true;

  const actions = document.createElement("div");
  actions.className = "agent-thread-card__actions";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className =
    "agent-thread-card__icon-btn agent-thread-card__delete";
  deleteButton.setAttribute(
    "aria-label",
    options.t("editor.threadCard.delete"),
  );
  deleteButton.append(createTrashIcon());
  deleteButton.addEventListener("click", options.onDeleteClick);

  const openInBrowserColumnButton = document.createElement("button");
  openInBrowserColumnButton.type = "button";
  openInBrowserColumnButton.className =
    "agent-thread-card__icon-btn agent-thread-card__open-in-browser-column";
  openInBrowserColumnButton.setAttribute(
    "aria-label",
    options.t("editor.threadCard.openInBrowserColumn"),
  );
  openInBrowserColumnButton.title = options.t("editor.threadCard.openInBrowserColumn");
  openInBrowserColumnButton.append(createOpenInColumnIcon());
  openInBrowserColumnButton.addEventListener("click", options.onOpenInBrowserColumnClick);

  const fullscreenButton = document.createElement("button");
  fullscreenButton.type = "button";
  fullscreenButton.className =
    "agent-thread-card__icon-btn agent-thread-card__fullscreen";
  fullscreenButton.setAttribute(
    "aria-label",
    options.t("editor.threadCard.enterFullscreen"),
  );
  fullscreenButton.append(createFullscreenIcon("enter"));
  fullscreenButton.addEventListener("click", options.onFullscreenClick);

  const actionsDivider = document.createElement("span");
  actionsDivider.className = "agent-thread-card__actions-divider";
  actionsDivider.setAttribute("aria-hidden", "true");
  actionsDivider.hidden = true;

  const collapseButton = document.createElement("button");
  collapseButton.type = "button";
  collapseButton.className =
    "agent-thread-card__icon-btn agent-thread-card__collapse";
  collapseButton.setAttribute(
    "aria-label",
    options.t("editor.threadCard.collapse"),
  );
  collapseButton.append(createChevronIcon("down"));
  collapseButton.addEventListener("click", options.onCollapseClick);

  actions.append(
    metaEl,
    openInBrowserColumnButton,
    deleteButton,
    actionsDivider,
    fullscreenButton,
    collapseButton,
  );
  header.append(agentWrap, actions);

  const bodyScrollbar = document.documentElement.dataset.platform === "mac"
    ? createOverlayScrollbarDom(document, {
        frameClassName: "agent-thread-card__body-frame overlay-scrollbar-frame--custom-mac",
        scrollerClassName: "agent-thread-card__body",
        observeContent: true,
      })
    : null;
  const body = bodyScrollbar?.scroller ?? document.createElement("div");
  if (!bodyScrollbar) body.className = "agent-thread-card__body";
  // streaming 期间 MessageViewportController 每帧写 body.scrollTop, scroll 事件
  // capture 冒泡到 window 会触发 ContextMenu 的 setOpen(false) ── 标记为豁免
  // 容器, 让右键菜单不被自身内容增长牵连关闭。
  body.dataset.noContextMenuScroll = "";
  body.addEventListener("click", options.onBodyClick);
  body.addEventListener("scroll", options.onBodyScroll, { passive: true });
  // Inline cards may route wheel input to the document until the message
  // viewport is explicitly activated, so this listener must be cancellable.
  body.addEventListener("wheel", options.onBodyWheel, { passive: false });
  const disposeBodyScrollbar = () => bodyScrollbar?.destroy();

  const loadingIndicator = document.createElement("div");
  loadingIndicator.className = "agent-thread-card__loading-indicator";
  loadingIndicator.setAttribute("role", "status");
  loadingIndicator.setAttribute("aria-live", "polite");
  const loadingCells = document.createElement("span");
  loadingCells.className = "agent-thread-card__loading-cells";
  loadingCells.setAttribute("aria-hidden", "true");
  /*
   * 4 格按 DOM 顺序顺序点亮: 0 → 1 → 2 → 3 → 0 → 1 → …—
   * DOM 顺序对应 2×2 grid:
   *   [0] [1]
   *   [2] [3]
   * 视觉序列: 左上 → 右上 → 左下 → 右下。每格的 --cell-step 给出在
   * 4 步循环里的位置 (0..3), CSS 用它算 delay 让每格各差 2.4s/4 = 0.6s
   * 起始 (cell 0 已在峰值相位, 后续各延迟 0.6s)。
   */
  for (let step = 0; step < 4; step += 1) {
    const cell = document.createElement("span");
    cell.className = "agent-thread-card__loading-cell";
    cell.style.setProperty("--cell-step", String(step));
    loadingCells.append(cell);
  }
  const loadingText = document.createElement("span");
  loadingText.className = "agent-thread-card__loading-text";
  loadingText.textContent = options.t("editor.threadCard.thinking");
  loadingText.hidden = true;
  loadingIndicator.append(loadingCells, loadingText);

  const composerParts = createAgentComposerDom({
    inputDraft: options.inputDraft,
    t: options.t,
  });
  const {
    composer,
    inputRow,
    composerActions,
    composerRoleIcon,
    composerAddPopover,
    input,
    codexSettingsPopover,
    composerRolePopover,
    sendButtonMount,
    scrollToLatestButton,
  } = composerParts;
  codexSettingsPopover.addEventListener("mousedown", (event) =>
    event.stopPropagation(),
  );
  codexSettingsPopover.addEventListener("click", (event) =>
    event.stopPropagation(),
  );
  composerRolePopover.addEventListener("mousedown", (event) =>
    event.stopPropagation(),
  );
  composerRolePopover.addEventListener("click", (event) =>
    event.stopPropagation(),
  );
  /*
   * composer 自身的 pointerdown 委托 (点击空区域 → focus 输入框) 已由
   * createAgentComposerDom 在工厂内部挂上, 这里不重复添加。 详见
   * composer-dom-factory.ts 的 COMPOSER_FOCUS_INTERACTIVE_SELECTOR
   * 注释 ── contenteditable/button/role=button/[data-no-composer-focus]
   * 命中即放行, 其他位置抢焦。
   *
   * loadingIndicator 作为 body 的最后一个持久子节点 (body.append 在此之前完成) —
   * 后续 render 路径必须用 insertBefore / removeChild 操作消息列表, 而不能把
   * indicator 作为 body.replaceChildren / body.append 的参数, 否则 WebKit 会
   * 把它断开后重连, 重启 @keyframes 计时到 t=0, 高频 streaming 下亮峰永远到不了。
   */
  body.append(loadingIndicator);
  const queuedMessages = document.createElement("div");
  queuedMessages.className = "agent-background-terminals agent-thread-card__queued-messages";
  queuedMessages.hidden = true;
  // Sits at the end of the message stream: a blocking Cloud state has to read as
  // the next row of the conversation, not as a dialog stacked on the composer.
  const cloudAccess = document.createElement("div");
  cloudAccess.className = "agent-thread-card__cloud-access";
  cloudAccess.hidden = true;
  body.append(cloudAccess);
  dom.append(container);
  container.append(header, bodyScrollbar?.frame ?? body, queuedMessages, composer);

  return {
    dom,
    container,
    header,
    titleEl,
    badgeEl,
    badgeIcon,
    badgeName,
    badgeHoverCardMount,
    metaEl,
    runStatusEl,
    actionsDivider,
    deleteButton,
    openInBrowserColumnButton,
    fullscreenButton,
    collapseButton,
    body,
    disposeBodyScrollbar,
    loadingIndicator,
    queuedMessages,
    cloudAccess,
    composer,
    inputRow,
    composerActions,
    composerRoleIcon,
    composerAddPopover,
    input,
    codexSettingsPopover,
    composerRolePopover,
    sendButtonMount,
    scrollToLatestButton,
  };
}
