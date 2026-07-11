import { getPropertyIconOption } from "@features/document/properties/property-icons";
import {
  getNotebookIconLetter,
  getNotebookIconMarkup,
} from "@features/memo/components/notebook-icon";
import type { I18nKey } from "@features/i18n";
import { displayTitleFromFilename } from "@/lib/utils";
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
  private readonly positionController: AnchoredPopoverController;

  private roleOptions: AgentRoleOption[] | null = null;
  private isLoadingRoleOptions = false;
  private roleOptionsRequestSeq = 0;
  private cachedRoleBodies: Map<string, string | null> = new Map();
  private open = false;

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
    this.positionController = createAnchoredPopoverController({
      isOpen: () => this.open,
      isDestroyed: () => this.isDestroyed(),
      isHidden: () => this.popover.hidden,
      position: () => this.positionPopover(),
      observe: () => [this.trigger],
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
    const entries = this.getRoleOptions();
    const currentMemoId = this.getCurrentMemoId();
    const isLocked = this.getMessageCount() > 0;

    const header = document.createElement("div");
    header.className = "agent-thread-card__composer-role-popover-header";
    const title = document.createElement("div");
    title.className = "agent-thread-card__composer-role-popover-title";
    title.textContent = isLocked
      ? `${this.t("editor.threadCard.selectRole")} ${this.t(
          "editor.threadCard.selectRoleLocked",
        )}`
      : this.t("editor.threadCard.selectRole");
    header.append(title);
    if (this.isLoadingRoleOptions) {
      header.append(createRoleOptionsLoadingIcon());
    }
    this.popover.append(header);

    if (this.isLoadingRoleOptions && this.roleOptions === null) {
      this.popover.append(
        this.createDisabledItem("...", "加载角色", "正在读取所有笔记本"),
      );
      return;
    }

    if (entries.length === 0) {
      this.popover.append(
        this.createDisabledItem("-", "没有角色", "在笔记属性中设置 agent-role"),
      );
      return;
    }

    for (const entry of entries) {
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
      const desc = document.createElement("span");
      desc.className = "agent-thread-card__composer-role-item-desc";
      desc.textContent = displayTitleFromFilename(entry.filename);

      body.append(name, desc);
      item.append(sourceIcon, body);

      if (!isLocked || isCurrent) {
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          this.updateRole({ memoId: entry.memoId, name: entry.name });
          this.setOpen(false);
        });
      }

      this.popover.append(item);
    }
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
