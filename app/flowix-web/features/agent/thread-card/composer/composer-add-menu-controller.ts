import type { I18nKey } from "@/lib/i18n";
import type { AgentRolePickerController } from "@features/agent/thread-card/role/agent-role-picker-controller";
import type { ComposerImageController } from "./composer-image-controller";
import { COMPOSER_ATTACHMENT_ACCEPT } from "./composer-image-controller";
import type { AgentTypeKey } from "@/types/agent";

export interface ComposerAddMenuControllerOptions {
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  rolePopover: HTMLDivElement;
  rolePicker: AgentRolePickerController;
  images: ComposerImageController;
  t: (key: I18nKey) => string;
  isDestroyed: () => boolean;
  getAgentType: () => AgentTypeKey;
  openCodexSettings: () => void;
}

export class ComposerAddMenuController {
  private open = false;
  private disposed = false;
  private noteItem: HTMLButtonElement | null = null;
  private submenuCloseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ComposerAddMenuControllerOptions) {
    options.trigger.addEventListener("click", this.handleTriggerClick);
    options.rolePopover.addEventListener("pointerenter", this.cancelSubmenuClose);
    options.rolePopover.addEventListener("pointerleave", this.handleSubmenuBoundaryLeave);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSubmenuClose();
    this.setOpen(false);
    this.options.trigger.removeEventListener("click", this.handleTriggerClick);
    this.options.rolePopover.removeEventListener("pointerenter", this.cancelSubmenuClose);
    this.options.rolePopover.removeEventListener("pointerleave", this.handleSubmenuBoundaryLeave);
    this.options.popover.remove();
  }

  private readonly handleTriggerClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.setOpen(!this.open);
  };

  private setOpen(open: boolean): void {
    this.open = open;
    this.options.popover.hidden = !open;
    this.options.trigger.setAttribute("aria-expanded", String(open));
    this.options.trigger.classList.toggle("agent-thread-card__composer-role-icon--open", open);
    if (open) {
      this.render();
      this.position();
      document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    } else {
      this.noteItem = null;
      this.options.rolePicker.setOpen(false);
      document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    }
  }

  private readonly handleOutsidePointer = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (target && (this.options.popover.contains(target) || this.options.rolePopover.contains(target) || this.options.trigger.contains(target))) return;
    this.setOpen(false);
  };

  private render(): void {
    this.noteItem?.removeEventListener("pointerleave", this.handleSubmenuBoundaryLeave);
    const note = this.createItem(this.options.t("editor.threadCard.addNote"), true);
    const attachment = this.createItem(this.options.t("editor.threadCard.addAttachment"), false);
    const items = [note, attachment];
    if (this.options.getAgentType() === "codex") {
      const codex = this.createItem(this.options.t("editor.threadCard.codexSettings"), false, () => {
        this.setOpen(false);
        this.options.openCodexSettings();
      });
      items.push(codex);
    }
    this.options.popover.replaceChildren(...items);
    this.noteItem = note;
    // The parent item and level-2 popover form one continuous hover region.
    note.addEventListener("pointerleave", this.handleSubmenuBoundaryLeave);
  }

  private createItem(label: string, isNote: boolean, onClick?: () => void): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    // Reuse the permission/model dropdown item contract so copy and controls
    // keep exactly the same typography, spacing and hover treatment.
    item.className = "agent-thread-card__codex-settings-item agent-thread-card__composer-add-item";
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    if (isNote) {
      item.append(this.chevron());
      item.addEventListener("pointerenter", () => {
        this.cancelSubmenuClose();
        this.options.rolePicker.openFromParent(item);
      });
      item.addEventListener("focus", () => this.options.rolePicker.openFromParent(item));
    } else if (onClick) {
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
      });
    } else {
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        this.pickAttachments();
      });
    }
    return item;
  }

  private readonly handleSubmenuBoundaryLeave = (event: PointerEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next && (this.noteItem?.contains(next) || this.options.rolePopover.contains(next))) return;
    // A short grace period is the usual cascade-menu behavior and covers the
    // pointer crossing the shared edge between the two fixed popovers.
    this.cancelSubmenuClose();
    this.submenuCloseTimer = setTimeout(() => {
      this.submenuCloseTimer = null;
      this.options.rolePicker.setOpen(false);
    }, 100);
  };

  private readonly cancelSubmenuClose = (): void => {
    if (this.submenuCloseTimer !== null) {
      clearTimeout(this.submenuCloseTimer);
      this.submenuCloseTimer = null;
    }
  };

  private pickAttachments(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = COMPOSER_ATTACHMENT_ACCEPT;
    input.multiple = true;
    input.hidden = true;
    input.addEventListener("change", () => {
      this.options.images.addFiles(Array.from(input.files ?? []));
      input.remove();
    }, { once: true });
    document.body.append(input);
    input.click();
    this.setOpen(false);
  }

  private position(): void {
    if (!this.open || this.disposed || this.options.isDestroyed()) return;
    const rect = this.options.trigger.getBoundingClientRect();
    const padding = 8;
    const offset = 6;
    const popoverRect = this.options.popover.getBoundingClientRect();
    const width = popoverRect.width || 168;
    const height = popoverRect.height || 80;
    const left = Math.max(padding, Math.min(rect.left, window.innerWidth - width - padding));
    const top = rect.top >= height + offset + padding
      ? rect.top - height - offset
      : rect.bottom + offset;
    Object.assign(this.options.popover.style, { left: `${left}px`, top: `${top}px` });
  }

  private chevron(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("agent-thread-card__composer-add-chevron");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m9 6 6 6-6 6");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }
}
