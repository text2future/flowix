import type { I18nKey } from "@features/i18n";
import {
  createChevronIcon,
  createFullscreenIcon,
  createTrashIcon,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";

export interface AgentThreadCardDomFactoryOptions {
  inputDraft: string;
  t: (key: I18nKey) => string;
  onCardMouseDown: (event: MouseEvent) => void;
  onTitleDoubleClick: (event: MouseEvent) => void;
  onDeleteClick: (event: MouseEvent) => void;
  onFullscreenClick: (event: MouseEvent) => void;
  onCollapseClick: (event: MouseEvent) => void;
  onBodyClick: (event: MouseEvent) => void;
  onBodyScroll: (event: Event) => void;
  onAccessClick: (event: MouseEvent) => void;
  onComposerMouseDown: (event: MouseEvent) => void;
}

export interface AgentThreadCardDomParts {
  dom: HTMLElement;
  container: HTMLDivElement;
  header: HTMLDivElement;
  titleEl: HTMLElement;
  badgeEl: HTMLSpanElement;
  badgeIcon: HTMLImageElement;
  badgeName: HTMLSpanElement;
  badgeHoverCardMount: HTMLSpanElement;
  metaEl: HTMLElement;
  runStatusEl: HTMLSpanElement;
  actionsDivider: HTMLSpanElement;
  deleteButton: HTMLButtonElement;
  fullscreenButton: HTMLButtonElement;
  collapseButton: HTMLButtonElement;
  body: HTMLElement;
  loadingIndicator: HTMLDivElement;
  errorEl: HTMLElement;
  composer: HTMLElement;
  composerRoleIcon: HTMLButtonElement;
  input: HTMLTextAreaElement;
  accessButton: HTMLButtonElement;
  accessPopover: HTMLDivElement;
  codexSettingsPopover: HTMLDivElement;
  composerRolePopover: HTMLDivElement;
  sendButtonMount: HTMLSpanElement;
}

export function createAgentThreadCardDom(
  options: AgentThreadCardDomFactoryOptions,
): AgentThreadCardDomParts {
  const dom = document.createElement("section");
  dom.className = "agent-thread-card";
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
  const badgeIcon = document.createElement("img");
  badgeIcon.className = "agent-type-badge__icon";
  badgeIcon.draggable = false;
  badgeIcon.alt = "";
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
    deleteButton,
    actionsDivider,
    fullscreenButton,
    collapseButton,
  );
  header.append(agentWrap, actions);

  const body = document.createElement("div");
  body.className = "agent-thread-card__body";
  body.addEventListener("click", options.onBodyClick);
  body.addEventListener("scroll", options.onBodyScroll, { passive: true });

  const loadingIndicator = document.createElement("div");
  loadingIndicator.className = "agent-thread-card__loading-indicator";
  const loadingDot = document.createElement("span");
  loadingDot.className = "agent-thread-card__loading-dot";
  loadingDot.setAttribute("aria-hidden", "true");
  const loadingText = document.createElement("span");
  loadingText.className = "agent-thread-card__loading-text";
  loadingText.textContent = options.t("editor.threadCard.thinking");
  loadingText.hidden = true;
  loadingIndicator.append(loadingDot, loadingText);

  const errorEl = document.createElement("div");
  errorEl.className = "agent-thread-card__error";
  errorEl.hidden = true;

  const composer = document.createElement("div");
  composer.className = "agent-thread-card__composer";

  const composerRoleIcon = document.createElement("button");
  composerRoleIcon.type = "button";
  composerRoleIcon.className = "agent-thread-card__composer-role-icon";
  composerRoleIcon.setAttribute("aria-haspopup", "menu");
  composerRoleIcon.setAttribute("aria-expanded", "false");
  composerRoleIcon.setAttribute(
    "aria-label",
    options.t("editor.threadCard.selectRole"),
  );
  composerRoleIcon.title = options.t("editor.threadCard.roleIconTooltip");

  const input = document.createElement("textarea");
  input.rows = 1;
  input.placeholder = options.t("editor.threadCard.inputPlaceholder");
  input.value = options.inputDraft;

  const accessButton = document.createElement("button");
  accessButton.type = "button";
  accessButton.className = "agent-thread-card__access-trigger";
  accessButton.textContent = options.t("editor.threadCard.accessButton");
  accessButton.setAttribute("aria-haspopup", "menu");
  accessButton.setAttribute("aria-expanded", "false");
  accessButton.addEventListener("click", options.onAccessClick);

  const accessPopover = document.createElement("div");
  accessPopover.className = "agent-thread-card__access-popover";
  accessPopover.setAttribute("role", "menu");
  accessPopover.hidden = true;
  // click 由 AccessPopoverController 顶层 delegation 接管 (看
  // handleClick); 这里不再挂额外 listener, 避免双重派发。 mousedown
  // 也不挂 ── AccessPopoverController.handleOutsidePointer 在 pointerdown
  // 捕获阶段判断"inside popover"早返, 不会因 click/mousedown 误关弹窗。
  document.body.appendChild(accessPopover);

  const codexSettingsPopover = document.createElement("div");
  codexSettingsPopover.className =
    "agent-thread-card__codex-settings-popover";
  codexSettingsPopover.setAttribute("role", "menu");
  codexSettingsPopover.hidden = true;
  codexSettingsPopover.addEventListener("mousedown", (event) =>
    event.stopPropagation(),
  );
  codexSettingsPopover.addEventListener("click", (event) =>
    event.stopPropagation(),
  );
  document.body.appendChild(codexSettingsPopover);

  const composerRolePopover = document.createElement("div");
  composerRolePopover.className =
    "agent-thread-card__composer-role-popover";
  composerRolePopover.setAttribute("role", "menu");
  composerRolePopover.hidden = true;
  composerRolePopover.addEventListener("mousedown", (event) =>
    event.stopPropagation(),
  );
  composerRolePopover.addEventListener("click", (event) =>
    event.stopPropagation(),
  );
  document.body.appendChild(composerRolePopover);

  const sendButtonMount = document.createElement("span");
  sendButtonMount.className = "agent-thread-card__send-tooltip";

  composer.append(
    composerRoleIcon,
    input,
    // accessButton, // “指令”入口暂时隐藏，保留节点与控制器以便后续恢复。
    sendButtonMount,
  );
  composer.addEventListener("mousedown", options.onComposerMouseDown);
  dom.append(container);
  container.append(header, body, errorEl, composer);

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
    fullscreenButton,
    collapseButton,
    body,
    loadingIndicator,
    errorEl,
    composer,
    composerRoleIcon,
    input,
    accessButton,
    accessPopover,
    codexSettingsPopover,
    composerRolePopover,
    sendButtonMount,
  };
}
