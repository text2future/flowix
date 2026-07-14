import { getPropertyIconOption } from "@features/document/properties/property-icons";
import {
  getNotebookIconLetter,
  getNotebookIconMarkup,
} from "@features/memo/components/notebook-icon";
import type { I18nKey } from "@features/i18n";
import {
  createComposerRoleEmptyIcon,
  createRoleOptionsLoadingIcon,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";
import {
  appendRoleIconContent,
  type AgentRoleOption,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-role";
import {
  fallbackAgentRoleOptionsFromStore,
  listAgentRoleMemosWithTimeout,
  loadAgentRoleBodyFromMemo,
} from "@features/editor/extensions/agent-thread-card/role/role-options-loader";
import {
  createAnchoredPopoverController,
  type AnchoredPopoverController,
} from "@features/editor/extensions/agent-thread-card/anchored-popover-controller";
import { useUserSettingsStore } from "@features/preferences/store/user-settings-store";
import type { QuickPhrase } from "@/lib/constants";

const ROLE_POPOVER_OFFSET_ABOVE_PX = 15;
const ROLE_POPOVER_OFFSET_BELOW_PX = 2;
const ROLE_POPOVER_VIEWPORT_PADDING_PX = 8;
const ROLE_POPOVER_WIDTH_PX = 208;
const ROLE_POPOVER_MAX_HEIGHT_PX = 320;
const ROLE_POPOVER_MIN_HEIGHT_PX = 96;

export interface AgentRolePickerControllerOptions {
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  t: (key: I18nKey) => string;
  isDestroyed: () => boolean;
  getCurrentMemoId: () => string | null;
  getCurrentName: () => string | null;
  getMessageCount: () => number;
  updateRole: (role: { memoId: string; name: string }) => void;
  consumeOutsidePointer: (event: PointerEvent) => void;
  /** 把常用语的 prompt 注入到 composer 输入框。 */
  injectPrompt: (text: string) => void;
  /** 打开偏好设置 (默认跳 aiAgent tab)。 */
  openPreferences: () => void | Promise<void>;
}

export class AgentRolePickerController {
  private readonly trigger: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly t: (key: I18nKey) => string;
  private readonly isDestroyed: () => boolean;
  private readonly getCurrentMemoId: () => string | null;
  private readonly getCurrentName: () => string | null;
  private readonly getMessageCount: () => number;
  private readonly updateRole: (role: { memoId: string; name: string }) => void;
  private readonly consumeOutsidePointer: (event: PointerEvent) => void;
  private readonly injectPrompt: (text: string) => void;
  private readonly openPreferences: () => void | Promise<void>;
  private readonly positionController: AnchoredPopoverController;

  private roleOptions: AgentRoleOption[] | null = null;
  private isLoadingRoleOptions = false;
  private roleOptionsRequestSeq = 0;
  private cachedRoleBodies: Map<string, string | null> = new Map();
  private open = false;
  /** 保存搜索 input / 常用语 list 的引用, 方便 refresh() 重渲染时复用 query。 */
  private quickPhraseFilter = "";

  constructor(options: AgentRolePickerControllerOptions) {
    this.trigger = options.trigger;
    this.popover = options.popover;
    this.t = options.t;
    this.isDestroyed = options.isDestroyed;
    this.getCurrentMemoId = options.getCurrentMemoId;
    this.getCurrentName = options.getCurrentName;
    this.getMessageCount = options.getMessageCount;
    this.updateRole = options.updateRole;
    this.consumeOutsidePointer = options.consumeOutsidePointer;
    this.injectPrompt = options.injectPrompt;
    this.openPreferences = options.openPreferences;
    this.positionController = createAnchoredPopoverController({
      isOpen: () => this.open,
      isDestroyed: () => this.isDestroyed(),
      isHidden: () => this.popover.hidden,
      position: () => this.positionPopover(),
      // 同时观察 trigger 与 popover 自身: 搜索过滤 / 异步加载角色
      // 都会让 popover 内容高度变化, 触发 ResizeObserver → 重新定位,
      // 避免 popover 因内容收缩 / 扩张而漂离触发按钮。
      observe: () => [this.trigger, this.popover],
    });

    this.trigger.addEventListener("click", this.handleTriggerClick);
  }

  get isOpen(): boolean {
    return this.open;
  }

  get popoverElement(): HTMLDivElement {
    return this.popover;
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.popover.hidden = !open;
    this.syncTriggerOpenState();

    if (open) {
      this.quickPhraseFilter = "";
      this.loadRoleOptions();
      this.renderOptionsList();
      this.positionController.schedule();
      this.positionController.start();
      document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    } else {
      this.positionController.stop();
      document.removeEventListener(
        "pointerdown",
        this.handleOutsidePointer,
        true,
      );
    }
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  /** 外部 (例如 store 订阅) 想刷新弹窗内容时调用 ── 弹窗隐藏时直接 no-op。 */
  refresh(): void {
    if (!this.open || this.popover.hidden) return;
    this.renderOptionsList();
    this.positionController.schedule();
  }

  refreshIcon(): void {
    const roleName = this.getCurrentName();
    this.trigger.replaceChildren();
    this.trigger.className = "agent-thread-card__composer-role-icon";
    this.syncTriggerOpenState();

    if (!roleName) {
      this.trigger.append(createComposerRoleEmptyIcon());
      this.trigger.title = this.t("editor.threadCard.roleIconTooltip");
      return;
    }

    const entry = this.selectedRoleOption();
    const memoIcon = entry?.memoIcon?.trim() ?? "";
    if (
      !memoIcon &&
      this.getCurrentMemoId() &&
      this.roleOptions === null &&
      !this.isLoadingRoleOptions
    ) {
      this.loadRoleOptions();
    }

    if (!appendRoleIconContent(this.trigger, memoIcon, roleName)) {
      this.trigger.textContent = getNotebookIconLetter(roleName);
    }
    this.trigger.title = roleName;
  }

  async loadRoleBody(memoId: string): Promise<string | null> {
    return loadAgentRoleBodyFromMemo({
      memoId,
      roleOptions: this.getRoleOptions(),
      cache: this.cachedRoleBodies,
      isDestroyed: this.isDestroyed,
    });
  }

  dispose(): void {
    this.setOpen(false);
    this.positionController.dispose();
    document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    this.trigger.removeEventListener("click", this.handleTriggerClick);
    this.popover.remove();
  }

  private handleTriggerClick = (event: MouseEvent): void => {
    event.stopPropagation();
    this.toggle();
  };

  private handleOutsidePointer = (event: PointerEvent): void => {
    if (!this.open) return;
    const target = event.target as globalThis.Node | null;
    if (
      target &&
      (this.popover.contains(target) || this.trigger.contains(target))
    ) {
      return;
    }
    this.setOpen(false);
    this.consumeOutsidePointer(event);
  };

  private syncTriggerOpenState(): void {
    this.trigger.setAttribute("aria-expanded", this.open ? "true" : "false");
    this.trigger.classList.toggle(
      "agent-thread-card__composer-role-icon--open",
      this.open,
    );
  }

  private getRoleOptions(): AgentRoleOption[] {
    return this.roleOptions ?? fallbackAgentRoleOptionsFromStore();
  }

  private getQuickPhrases(): QuickPhrase[] {
    return useUserSettingsStore.getState().settings.agents?.quickPhrases ?? [];
  }

  private loadRoleOptions(): void {
    if (this.isLoadingRoleOptions) return;
    if (this.roleOptions === null) {
      this.roleOptions = fallbackAgentRoleOptionsFromStore();
    }
    const requestSeq = ++this.roleOptionsRequestSeq;
    this.isLoadingRoleOptions = true;
    void listAgentRoleMemosWithTimeout()
      .then((items) => {
        if (this.isDestroyed() || requestSeq !== this.roleOptionsRequestSeq)
          return;
        this.roleOptions = items.map((item) => ({
          memoId: item.memoId,
          name: item.roleName,
          filename: item.filename,
          memoIcon: item.memoIcon,
          notebookId: item.notebookId,
          notebookName: item.notebookName,
          notebookIcon: item.notebookIcon,
        }));
      })
      .catch((error) => {
        console.error(
          "[AgentThreadCard] Failed to load agent-role memos:",
          error,
        );
        if (
          !this.isDestroyed() &&
          requestSeq === this.roleOptionsRequestSeq
        ) {
          this.roleOptions = fallbackAgentRoleOptionsFromStore();
        }
      })
      .finally(() => {
        if (this.isDestroyed() || requestSeq !== this.roleOptionsRequestSeq)
          return;
        this.isLoadingRoleOptions = false;
        this.refreshIcon();
        if (this.open && !this.popover.hidden) {
          this.renderOptionsList();
          this.positionController.schedule();
        }
      });
  }

  private renderOptionsList(): void {
    this.popover.replaceChildren();
    // 单一入口: 搜索框 + 双分组 (常用语 / 选择角色) 列表。
    // 搜索 active 时跨两组按 title 过滤; 无命中组整体隐藏 header。
    this.popover.append(this.renderUnifiedSection());
  }

  /** 搜索框 + 双分组 section ── 替换旧的「常用语 + 选择角色」独立 render。
   *  - 搜索 active 时同时过滤两组 (按 title.toLowerCase().includes(filter))
   *  - 两组互不干扰: 没匹配的组连 header 一起隐藏
   *  - 全无命中时显示统一的未找到占位
   *  - 视觉继续复用 .agent-thread-card__composer-role-item* ── 不另写样式 */
  private renderUnifiedSection(): DocumentFragment {
    const frag = document.createDocumentFragment();

    // ── 搜索框 ── 无图标, 无边框, 无背景; 仅保留底部 1px divider 与 popover 节奏一致
    const search = document.createElement("input");
    search.type = "text";
    search.className =
      "agent-thread-card__composer-quick-phrase-search";
    search.placeholder = this.t(
      "editor.threadCard.quickPhrases.searchPlaceholder",
    );
    search.spellcheck = false;
    search.autocomplete = "off";
    search.setAttribute(
      "aria-label",
      this.t("editor.threadCard.quickPhrases.sectionTitle"),
    );
    search.value = this.quickPhraseFilter;

    // ── 容器 ── 装两个分组, 由 helper 各自渲染 (动态)
    const groupsContainer = document.createElement("div");
    groupsContainer.className =
      "agent-thread-card__composer-quick-phrase-list";

    const rerenderGroups = (): void => {
      groupsContainer.replaceChildren();

      const filter = this.quickPhraseFilter.trim().toLowerCase();
      const phrases = this.getQuickPhrases();
      const roleEntries = this.getRoleOptions();

      // 过滤: filter 为空时全量, 非空时按 title 包含匹配
      const matchedPhrases = filter
        ? phrases.filter((p) => p.title.toLowerCase().includes(filter))
        : phrases;
      const matchedRoles = filter
        ? roleEntries.filter((r) => r.name.toLowerCase().includes(filter))
        : roleEntries;

      let hasAny = false;

      // ── 常用语分组 ──
      if (phrases.length === 0 && !filter) {
        // 完全未配置: 显示「添加常用语」入口项, 视觉等同菜单项
        groupsContainer.append(this.renderQuickPhrasesGroup([], filter));
        hasAny = true;
      } else if (matchedPhrases.length > 0) {
        groupsContainer.append(
          this.renderQuickPhrasesGroup(matchedPhrases, filter),
        );
        hasAny = true;
      }

      // ── 选择角色分组 ──
      if (matchedRoles.length > 0) {
        groupsContainer.append(this.renderRoleGroup(matchedRoles));
        hasAny = true;
      }

      // ── 搜索无任何命中 ──
      if (!hasAny) {
        groupsContainer.append(
          this.createDisabledItem(
            "✦",
            this.t("editor.threadCard.quickPhrases.emptyNoMatch"),
            "",
          ),
        );
      }
    };

    search.addEventListener("input", () => {
      this.quickPhraseFilter = search.value;
      rerenderGroups();
      // 内容高度变化后重新定位, 让 popover 相对 trigger 重新锚定
      // (虽然 ResizeObserver 也应该触发, 但显式 schedule 兼容
      //  jsdom 等无 ResizeObserver 环境 + 兜底首次渲染抖动)。
      this.positionController.schedule();
    });
    search.addEventListener("keydown", (event) => {
      // 屏蔽 ↑/↓/Enter 冒泡到 composer, 避免和 composer 历史导航 / 提交冲突。
      // Esc 关闭弹窗。
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.setOpen(false);
        return;
      }
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter"
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.navigateQuickPhraseList(groupsContainer, event.key);
        return;
      }
      event.stopPropagation();
    });

    rerenderGroups();
    frag.append(search, groupsContainer);

    // 打开弹窗时自动聚焦搜索框
    requestAnimationFrame(() => {
      if (this.open && !this.popover.hidden) search.focus();
    });
    return frag;
  }

  /** 常用语分组: header + 列表项 (含未配置时的「添加常用语」入口) */
  private renderQuickPhrasesGroup(
    matched: QuickPhrase[],
    filter: string,
  ): DocumentFragment {
    const frag = document.createDocumentFragment();
    frag.append(this.createGroupHeader(
      this.t("editor.threadCard.quickPhrases.sectionTitle"),
    ));

    if (matched.length === 0 && filter === "") {
      // 未配置常用语 + 没在搜索: 显示「添加常用语」入口项
      frag.append(this.createQuickPhraseAddItem());
      return frag;
    }
    for (const phrase of matched) {
      frag.append(this.createQuickPhraseItem(phrase));
    }
    return frag;
  }

  /** 选择角色分组: header + 列表项 */
  private renderRoleGroup(matched: AgentRoleOption[]): DocumentFragment {
    const frag = document.createDocumentFragment();

    const isLocked = this.getMessageCount() > 0;
    const headerText = isLocked
      ? `${this.t("editor.threadCard.selectRole")} ${this.t(
          "editor.threadCard.selectRoleLocked",
        )}`
      : this.t("editor.threadCard.selectRole");
    const header = this.createGroupHeader(headerText);
    if (this.isLoadingRoleOptions) {
      header.append(createRoleOptionsLoadingIcon());
    }
    frag.append(header);

    const currentMemoId = this.getCurrentMemoId();
    for (const entry of matched) {
      const item = this.createRoleItem(entry, currentMemoId, isLocked);
      frag.append(item);
    }
    return frag;
  }

  /** 创建 popover group header (复用 role-popover-header 样式) */
  private createGroupHeader(text: string): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "agent-thread-card__composer-role-popover-header";
    const title = document.createElement("div");
    title.className = "agent-thread-card__composer-role-popover-title";
    title.textContent = text;
    header.append(title);
    return header;
  }

  /** 创建单条角色项 — 不再渲染 desc (副标题已移除) */
  private createRoleItem(
    entry: AgentRoleOption,
    currentMemoId: string | null,
    isLocked: boolean,
  ): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "agent-thread-card__composer-role-item";
    item.setAttribute("role", "menuitem");

    const isCurrent = entry.memoId === currentMemoId;
    if (isCurrent) {
      item.classList.add("agent-thread-card__composer-role-item--selected");
    }
    if (isLocked && !isCurrent) {
      item.classList.add("agent-thread-card__composer-role-item--disabled");
      item.disabled = true;
      item.setAttribute("aria-disabled", "true");
    }

    const sourceIcon = document.createElement("span");
    sourceIcon.className = "agent-thread-card__composer-role-item-icon";
    const memoIcon = entry.memoIcon?.trim() || "";
    if (appendRoleIconContent(sourceIcon, memoIcon, entry.name)) {
      sourceIcon.classList.toggle(
        "agent-thread-card__composer-role-item-icon--svg",
        !!getNotebookIconMarkup(memoIcon) && !getPropertyIconOption(memoIcon),
      );
    } else {
      sourceIcon.textContent = getNotebookIconLetter(entry.name);
    }

    const body = document.createElement("span");
    body.className = "agent-thread-card__composer-role-item-body";
    const name = document.createElement("span");
    name.className = "agent-thread-card__composer-role-item-name";
    name.textContent = entry.name;
    body.append(name);
    item.append(sourceIcon, body);

    if (!isLocked || isCurrent) {
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        this.updateRole({ memoId: entry.memoId, name: entry.name });
        this.setOpen(false);
      });
    }
    return item;
  }

  /** 单条常用语项 ── 只显示标题, prompt 走原生 title (hover tooltip) 暴露。 */
  private createQuickPhraseItem(phrase: QuickPhrase): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "agent-thread-card__composer-role-item";
    item.setAttribute("role", "menuitem");
    item.title = phrase.prompt;

    const icon = document.createElement("span");
    icon.className = "agent-thread-card__composer-role-item-icon";
    icon.textContent = "✦";
    icon.setAttribute("aria-hidden", "true");

    const body = document.createElement("span");
    body.className = "agent-thread-card__composer-role-item-body";
    const name = document.createElement("span");
    name.className = "agent-thread-card__composer-role-item-name";
    name.textContent = phrase.title;
    body.append(name);
    item.append(icon, body);
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      this.injectPrompt(phrase.prompt);
      this.setOpen(false);
    });
    return item;
  }

  /** 未配置常用语时的「添加常用语」入口项。 */
  private createQuickPhraseAddItem(): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "agent-thread-card__composer-role-item";
    item.setAttribute("role", "menuitem");

    const icon = document.createElement("span");
    icon.className = "agent-thread-card__composer-role-item-icon";
    icon.textContent = "+";
    icon.setAttribute("aria-hidden", "true");

    const body = document.createElement("span");
    body.className = "agent-thread-card__composer-role-item-body";
    const name = document.createElement("span");
    name.className = "agent-thread-card__composer-role-item-name";
    name.textContent = this.t("editor.threadCard.quickPhrases.emptyAction");
    body.append(name);
    item.append(icon, body);
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setOpen(false);
      void this.openPreferences();
    });
    return item;
  }

  /** ↑/↓ 在所有可见项间移动焦点; Enter 选中当前高亮项。
   *  容器内所有 role-item 都是可选项 (常用语 + 角色)。 */
  private navigateQuickPhraseList(
    list: HTMLElement,
    key: "ArrowDown" | "ArrowUp" | "Enter",
  ): void {
    const items = Array.from(
      list.querySelectorAll<HTMLButtonElement>(
        ".agent-thread-card__composer-role-item",
      ),
    );
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const currentIndex = active
      ? items.findIndex((el) => el === active)
      : -1;
    if (key === "Enter") {
      if (currentIndex >= 0) items[currentIndex].click();
      else items[0]?.click();
      return;
    }
    const delta = key === "ArrowDown" ? 1 : -1;
    const next = currentIndex < 0
      ? (delta > 0 ? 0 : items.length - 1)
      : Math.max(0, Math.min(items.length - 1, currentIndex + delta));
    items[next]?.focus();
  }

  private createDisabledItem(
    fallbackText: string,
    nameText: string,
    descText: string,
  ): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className =
      "agent-thread-card__composer-role-item agent-thread-card__composer-role-item--disabled";
    item.disabled = true;
    item.setAttribute("role", "menuitem");

    const fallback = document.createElement("span");
    fallback.className = "agent-thread-card__composer-role-item-fallback";
    fallback.textContent = fallbackText;
    const body = document.createElement("span");
    body.className = "agent-thread-card__composer-role-item-body";
    const name = document.createElement("span");
    name.className = "agent-thread-card__composer-role-item-name";
    name.textContent = nameText;
    const desc = document.createElement("span");
    desc.className = "agent-thread-card__composer-role-item-desc";
    desc.textContent = descText;
    body.append(name, desc);
    item.append(fallback, body);
    return item;
  }

  private selectedRoleOption(): AgentRoleOption | null {
    const memoId = this.getCurrentMemoId();
    const roleName = this.getCurrentName();
    if (!memoId && !roleName) return null;
    const entries = this.getRoleOptions();
    return (
      entries.find((entry) => entry.memoId === memoId) ??
      entries.find((entry) => roleName !== null && entry.name === roleName) ??
      null
    );
  }

  private positionPopover(): void {
    if (!this.open || this.popover.hidden || this.isDestroyed()) return;
    if (!this.trigger.isConnected || !this.popover.isConnected) {
      this.setOpen(false);
      return;
    }

    const anchorRect = this.trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = ROLE_POPOVER_VIEWPORT_PADDING_PX;
    const spaceAbove =
      anchorRect.top - padding - ROLE_POPOVER_OFFSET_ABOVE_PX;
    const spaceBelow =
      viewportHeight -
      anchorRect.bottom -
      padding -
      ROLE_POPOVER_OFFSET_BELOW_PX;
    const placeAbove =
      spaceAbove >= ROLE_POPOVER_MIN_HEIGHT_PX || spaceAbove >= spaceBelow;

    const popoverRect = this.popover.getBoundingClientRect();
    const popoverWidth = popoverRect.width || ROLE_POPOVER_WIDTH_PX;
    const popoverHeight = popoverRect.height || ROLE_POPOVER_MAX_HEIGHT_PX;
    const maxLeft = Math.max(padding, viewportWidth - padding - popoverWidth);
    const left = Math.min(Math.max(anchorRect.left, padding), maxLeft);
    const offset = placeAbove
      ? ROLE_POPOVER_OFFSET_ABOVE_PX
      : ROLE_POPOVER_OFFSET_BELOW_PX;
    const rawTop = placeAbove
      ? anchorRect.top - offset - popoverHeight
      : anchorRect.bottom + offset;
    const maxTop = Math.max(padding, viewportHeight - padding - popoverHeight);
    const top = Math.min(Math.max(rawTop, padding), maxTop);

    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }
}
