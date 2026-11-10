import type { I18nKey } from "@/lib/i18n";
import { replayEnterAnimation } from "@/lib/replay-enter-animation";
import type { NotePickerController } from "@features/agent/thread-card/note/note-picker-controller";
import type { ComposerAttachmentController } from "./composer-attachment-controller";
import { COMPOSER_ATTACHMENT_ACCEPT } from "./composer-attachment-controller";

export interface ComposerAddMenuControllerOptions {
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  notePopover: HTMLDivElement;
  settingsPopover?: HTMLDivElement;
  notePicker: NotePickerController;
  attachments: ComposerAttachmentController;
  t: (key: I18nKey) => string;
  isDestroyed: () => boolean;
  openNotebookAgentSettings: () => void;
  settings?: readonly {
    label: I18nKey;
    popupRole?: "menu" | "dialog";
    onHover: (anchor: HTMLButtonElement) => void;
  }[];
  showSettings?: () => boolean;
  closeSettingsSubmenu?: (anchor?: HTMLButtonElement) => void;
  consumeOutsidePointer?: (event: PointerEvent) => void;
}

export class ComposerAddMenuController {
  private open = false;
  private disposed = false;
  private noteItem: HTMLButtonElement | null = null;
  private activeSettingsItem: HTMLButtonElement | null = null;
  private suppressSettingsFocusOpen = false;
  private submenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private settingsCloseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ComposerAddMenuControllerOptions) {
    options.trigger.addEventListener("click", this.handleTriggerClick);
    options.notePopover.addEventListener("pointerenter", this.cancelSubmenuClose);
    options.notePopover.addEventListener("pointerleave", this.handleSubmenuBoundaryLeave);
    options.popover.addEventListener("pointerleave", this.handleSettingsBoundaryLeave);
    options.popover.addEventListener("keydown", this.handleMenuKeydown);
    options.settingsPopover?.addEventListener("pointerenter", this.cancelSettingsClose);
    options.settingsPopover?.addEventListener("pointerleave", this.handleSettingsBoundaryLeave);
    options.settingsPopover?.addEventListener("keydown", this.handleSettingsKeydown);
  }

  close(): void { this.setOpen(false); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSubmenuClose();
    this.cancelSettingsClose();
    this.setOpen(false);
    this.options.trigger.removeEventListener("click", this.handleTriggerClick);
    this.options.notePopover.removeEventListener("pointerenter", this.cancelSubmenuClose);
    this.options.notePopover.removeEventListener("pointerleave", this.handleSubmenuBoundaryLeave);
    this.options.popover.removeEventListener("pointerleave", this.handleSettingsBoundaryLeave);
    this.options.popover.removeEventListener("keydown", this.handleMenuKeydown);
    this.options.settingsPopover?.removeEventListener("pointerenter", this.cancelSettingsClose);
    this.options.settingsPopover?.removeEventListener("pointerleave", this.handleSettingsBoundaryLeave);
    this.options.settingsPopover?.removeEventListener("keydown", this.handleSettingsKeydown);
    this.options.popover.remove();
  }

  private readonly handleTriggerClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const shouldOpen = !this.open;
    this.setOpen(shouldOpen);
    if (shouldOpen && event.detail === 0) {
      this.options.popover.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    }
  };

  private setOpen(open: boolean): void {
    this.open = open;
    this.options.popover.hidden = !open;
    this.options.trigger.setAttribute("aria-expanded", String(open));
    this.options.trigger.classList.toggle("agent-composer__add-button--open", open);
    if (open) {
      this.replayEnterAnimation();
      this.render();
      this.position();
      document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    } else {
      this.cancelSettingsClose();
      this.noteItem = null;
      this.options.notePicker.setOpen(false);
      this.options.closeSettingsSubmenu?.(this.activeSettingsItem ?? undefined);
      this.activeSettingsItem = null;
      document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    }
  }

  /** 打开时重放标准入场动画 (见 lib/replay-enter-animation.ts)。 */
  private replayEnterAnimation(): void {
    replayEnterAnimation(this.options.popover);
  }

  private readonly handleOutsidePointer = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (
      target
      && (
        this.options.popover.contains(target)
        || this.options.notePopover.contains(target)
        || this.options.settingsPopover?.contains(target)
        || this.options.trigger.contains(target)
      )
    ) return;
    if (
      this.activeSettingsItem
      && this.options.settingsPopover
      && !this.options.settingsPopover.hidden
    ) {
      // The settings controller also listens for outside pointers. Closing the
      // parent removes that listener, so consume editor clicks here first.
      this.options.consumeOutsidePointer?.(event);
    }
    this.setOpen(false);
  };

  private render(): void {
    this.noteItem?.removeEventListener("pointerleave", this.handleSubmenuBoundaryLeave);
    const note = this.createItem(this.options.t("editor.threadCard.addNote"), true);
    const attachment = this.createItem(this.options.t("editor.threadCard.addAttachment"), false);
    const items: HTMLElement[] = [note, attachment];
    const settings = this.options.showSettings?.() === false
      ? []
      : (this.options.settings ?? []);
    if (settings.length > 0) {
      items.push(this.createSeparator());
      settings.forEach(({ label, onHover, popupRole }) => {
        items.push(this.createSettingsItem(this.options.t(label), onHover, popupRole));
      });
    }
    const projectAiSettings = this.createItem(this.options.t("editor.threadCard.projectAiSettings"), false, () => {
      this.setOpen(false);
      this.options.openNotebookAgentSettings();
    });
    if (settings.length > 0) items.push(this.createSeparator());
    items.push(projectAiSettings);
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
    item.className = "agent-thread-card__codex-settings-item agent-composer__add-item";
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    if (isNote) {
      item.append(this.chevron());
      item.addEventListener("pointerenter", () => {
        this.cancelSubmenuClose();
        this.options.notePicker.openFromParent(item);
      });
      item.addEventListener("focus", () => this.options.notePicker.openFromParent(item));
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.notePicker.openFromParent(item);
      });
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

  private createSettingsItem(
    label: string,
    onHover: (anchor: HTMLButtonElement) => void,
    popupRole: "menu" | "dialog" = "menu",
  ): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "agent-thread-card__codex-settings-item agent-composer__add-item";
    item.classList.add("agent-composer__add-setting-item");
    item.setAttribute("role", "menuitem");
    item.setAttribute("aria-haspopup", popupRole);
    item.setAttribute("aria-expanded", "false");
    item.textContent = label;
    item.append(this.chevron());
    item.addEventListener("pointerenter", () => {
      this.cancelSettingsClose();
      this.activateSettingsItem(item);
      onHover(item);
    });
    item.addEventListener("focus", () => {
      if (this.suppressSettingsFocusOpen) return;
      this.cancelSettingsClose();
      this.activateSettingsItem(item);
      onHover(item);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight") return;
      if (!this.options.settingsPopover || this.options.settingsPopover.hidden) return;
      const firstSubmenuItem = this.options.settingsPopover?.querySelector<HTMLButtonElement>(
        "button:not([disabled])",
      );
      if (!firstSubmenuItem) return;
      event.preventDefault();
      firstSubmenuItem.focus();
    });
    item.addEventListener("pointerleave", this.handleSettingsBoundaryLeave);
    return item;
  }

  syncSettingsSubmenuState(open: boolean, anchor: HTMLButtonElement | null): void {
    const activeItem = this.activeSettingsItem;
    if (!activeItem) return;
    if (open && anchor !== activeItem) {
      activeItem.setAttribute("aria-expanded", "false");
      this.activeSettingsItem = null;
      return;
    }
    if (!open && anchor && anchor !== activeItem) return;
    const focusWasInSubmenu =
      !open && Boolean(this.options.settingsPopover?.contains(document.activeElement));
    activeItem.setAttribute("aria-expanded", String(open));
    if (!open) {
      this.activeSettingsItem = null;
      if (focusWasInSubmenu) this.focusSettingsItemWithoutOpening(activeItem);
    }
  }

  private activateSettingsItem(item: HTMLButtonElement): void {
    if (this.activeSettingsItem === item) return;
    this.activeSettingsItem?.setAttribute("aria-expanded", "false");
    this.activeSettingsItem = item;
    item.setAttribute("aria-expanded", "false");
  }

  private focusSettingsItemWithoutOpening(item: HTMLButtonElement | null): void {
    if (!item || !item.isConnected || document.activeElement === item) return;
    this.suppressSettingsFocusOpen = true;
    item.focus();
    this.suppressSettingsFocusOpen = false;
  }

  private readonly handleMenuKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (
      this.activeSettingsItem
      && this.options.settingsPopover
      && !this.options.settingsPopover.hidden
    ) {
      const activeItem = this.activeSettingsItem;
      this.options.closeSettingsSubmenu?.(activeItem ?? undefined);
      this.focusSettingsItemWithoutOpening(activeItem);
      return;
    }
    this.setOpen(false);
    this.options.trigger.focus();
  };

  private readonly handleSettingsKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
    if (
      event.key === "ArrowLeft"
      && !(event.target instanceof Element && event.target.closest("[role='menuitem']"))
    ) return;
    const activeItem = this.activeSettingsItem;
    if (!activeItem) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      this.options.closeSettingsSubmenu?.(activeItem ?? undefined);
    }
    this.focusSettingsItemWithoutOpening(activeItem);
  };

  private createSeparator(): HTMLDivElement {
    const separator = document.createElement("div");
    separator.className = "agent-composer__add-separator";
    separator.setAttribute("role", "separator");
    return separator;
  }

  private readonly handleSubmenuBoundaryLeave = (event: PointerEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next && (this.noteItem?.contains(next) || this.options.notePopover.contains(next))) return;
    // A short grace period is the usual cascade-menu behavior and covers the
    // pointer crossing the shared edge between the two fixed popovers.
    this.cancelSubmenuClose();
    this.submenuCloseTimer = setTimeout(() => {
      this.submenuCloseTimer = null;
      this.options.notePicker.setOpen(false);
    }, 100);
  };

  private readonly cancelSubmenuClose = (): void => {
    if (this.submenuCloseTimer !== null) {
      clearTimeout(this.submenuCloseTimer);
      this.submenuCloseTimer = null;
    }
  };

  private readonly handleSettingsBoundaryLeave = (event: PointerEvent): void => {
    const next = event.relatedTarget as Node | null;
    const current = event.currentTarget as Node | null;
    if (next && current?.contains(next)) return;
    if (next && this.options.settingsPopover?.contains(next)) return;
    if (next instanceof Element && this.options.popover.contains(next)) {
      if (next.closest(".agent-composer__add-setting-item")) return;
    }
    this.cancelSettingsClose();
    this.settingsCloseTimer = setTimeout(() => {
      this.settingsCloseTimer = null;
      this.options.closeSettingsSubmenu?.(this.activeSettingsItem ?? undefined);
      this.activeSettingsItem = null;
    }, 100);
  };

  private readonly cancelSettingsClose = (): void => {
    if (this.settingsCloseTimer !== null) {
      clearTimeout(this.settingsCloseTimer);
      this.settingsCloseTimer = null;
    }
  };

  private pickAttachments(): void {
    this.options.attachments.captureInsertionAnchor();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = COMPOSER_ATTACHMENT_ACCEPT;
    input.multiple = true;
    input.hidden = true;
    input.addEventListener("change", () => {
      this.options.attachments.addFiles(Array.from(input.files ?? []));
      input.remove();
    }, { once: true });
    input.addEventListener("cancel", () => {
      this.options.attachments.cancelInsertionAnchor();
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
    const preferredTop = rect.top >= height + offset + padding
      ? rect.top - height - offset
      : rect.bottom + offset;
    const top = Math.max(padding, Math.min(preferredTop, window.innerHeight - height - padding));
    Object.assign(this.options.popover.style, { left: `${left}px`, top: `${top}px` });
  }

  private chevron(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("agent-composer__add-chevron");
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
