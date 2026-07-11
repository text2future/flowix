import type { I18nKey } from "@features/i18n";
import { useMemoStore } from "@features/memo";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { createPlusIcon } from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";
import {
  createAccessDivider,
  createAccessEntryRow,
  createAccessSectionLabel,
} from "@features/editor/extensions/agent-thread-card/access/access-entries";
import { attachAccessPopoverScrollbar } from "@features/editor/extensions/agent-thread-card/access/access-popover-scrollbar";

const ACCESS_POPOVER_OFFSET_ABOVE_PX = 15;
const ACCESS_POPOVER_OFFSET_BELOW_PX = 2;
const ACCESS_POPOVER_VIEWPORT_PADDING_PX = 8;
const ACCESS_POPOVER_WIDTH_PX = 208;
const ACCESS_POPOVER_MAX_HEIGHT_PX = 320;
const ACCESS_POPOVER_MIN_HEIGHT_PX = 96;

export interface AccessPopoverControllerOptions {
  button: HTMLButtonElement;
  popover: HTMLDivElement;
  t: (key: I18nKey) => string;
  isDestroyed: () => boolean;
  isInsideRelatedTarget: (target: globalThis.Node) => boolean;
  consumeOutsidePointer: (event: PointerEvent) => void;
}

export class AccessPopoverController {
  private readonly button: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly t: (key: I18nKey) => string;
  private readonly isDestroyed: () => boolean;
  private readonly isInsideRelatedTarget: (target: globalThis.Node) => boolean;
  private readonly consumeOutsidePointer: (event: PointerEvent) => void;

  private anchor: HTMLElement | null = null;
  private preferBelow = false;
  private open = false;
  private resizeObserver: ResizeObserver | null = null;
  private positionFrame: number | null = null;
  private detachScrollbar: (() => void) | null = null;

  constructor(options: AccessPopoverControllerOptions) {
    this.button = options.button;
    this.popover = options.popover;
    this.t = options.t;
    this.isDestroyed = options.isDestroyed;
    this.isInsideRelatedTarget = options.isInsideRelatedTarget;
    this.consumeOutsidePointer = options.consumeOutsidePointer;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get popoverElement(): HTMLDivElement {
    return this.popover;
  }

  setOpen(
    open: boolean,
    anchor: HTMLElement | null = null,
    preferBelow = false,
  ): void {
    if (this.open === open) return;
    this.open = open;
    this.anchor = open ? (anchor ?? this.button) : null;
    this.preferBelow = open && preferBelow;
    this.popover.hidden = !open;
    this.button.setAttribute("aria-expanded", open ? "true" : "false");
    this.button.classList.toggle(
      "agent-thread-card__access-trigger--open",
      open,
    );

    if (open) {
      const accessState = useAgentAccessStore.getState();
      const memoState = useMemoStore.getState();
      if (!accessState.isLoading && accessState.config.entries.length === 0) {
        void accessState.loadInitial();
      }
      if (memoState.notebooks.length === 0) {
        void memoState.loadNotebooks().catch(() => {});
      }
      this.render();
      this.schedulePosition();
      this.startPositionTracking();
      document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    } else {
      this.stopPositionTracking();
      document.removeEventListener(
        "pointerdown",
        this.handleOutsidePointer,
        true,
      );
      this.detachScrollbar?.();
      this.detachScrollbar = null;
    }
  }

  render(): void {
    const { config, isLoading, toggle, addFolderFromPicker, removeFolder } =
      useAgentAccessStore.getState();
    const { notebooks } = useMemoStore.getState();
    const notebookEntries = config.entries.filter(
      (entry) => entry.kind === "notebook",
    );
    const folderEntries = config.entries.filter(
      (entry) => entry.kind === "folder",
    );

    this.popover.replaceChildren();

    const scrollFrame = document.createElement("div");
    scrollFrame.className = "overlay-scrollbar-frame";
    this.popover.append(scrollFrame);

    const scrollWrap = document.createElement("div");
    scrollWrap.className =
      "agent-thread-card__access-popover-scroll overlay-scrollbar";
    scrollFrame.append(scrollWrap);

    const thumb = document.createElement("div");
    thumb.className = "overlay-scrollbar-thumb";
    thumb.setAttribute("aria-hidden", "true");
    scrollFrame.append(thumb);

    const footerWrap = document.createElement("div");
    footerWrap.className = "agent-thread-card__access-popover-footer";

    if (notebookEntries.length === 0 && folderEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agent-thread-card__access-empty";
      empty.textContent = isLoading
        ? this.t("agent.access.empty.loading")
        : this.t("agent.access.empty.empty");
      scrollWrap.append(empty, footerWrap);
    } else {
      if (folderEntries.length > 0) {
        scrollWrap.append(
          createAccessSectionLabel(this.t("agent.access.sectionFolder")),
        );
        folderEntries.forEach((entry) => {
          scrollWrap.append(
            createAccessEntryRow({
              entry,
              notebooks,
              t: (key) => this.t(key as I18nKey),
              toggle,
              removeFolder,
            }),
          );
        });
        scrollWrap.append(footerWrap);
      }
      if (notebookEntries.length > 0 && folderEntries.length > 0) {
        scrollWrap.append(createAccessDivider());
      }
      if (notebookEntries.length > 0) {
        scrollWrap.append(
          createAccessSectionLabel(this.t("agent.access.sectionNotebook")),
        );
        notebookEntries.forEach((entry) => {
          scrollWrap.append(
            createAccessEntryRow({
              entry,
              notebooks,
              t: (key) => this.t(key as I18nKey),
              toggle,
              removeFolder,
            }),
          );
        });
        if (folderEntries.length === 0) {
          scrollWrap.append(footerWrap);
        }
      }
    }

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "agent-thread-card__access-add";
    const addIconWrap = document.createElement("span");
    addIconWrap.className = "agent-thread-card__access-add-icon-wrap";
    addIconWrap.append(createPlusIcon());
    const addLabel = document.createElement("span");
    addLabel.className = "agent-thread-card__access-add-label";
    addLabel.textContent = this.t("agent.access.addFolder");
    addButton.append(addIconWrap, addLabel);
    addButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void addFolderFromPicker().then((result) => {
        if (!result.ok && result.code !== "not-selected") {
          console.error(`addFolderFromPicker error: ${result.code}`);
        }
      });
    });
    footerWrap.append(addButton);

    this.detachScrollbar?.();
    this.detachScrollbar = attachAccessPopoverScrollbar(scrollWrap);
    this.schedulePosition();
  }

  schedulePosition(): void {
    if (!this.open || this.popover.hidden || this.isDestroyed()) return;
    if (this.positionFrame !== null) return;
    this.positionFrame = window.requestAnimationFrame(() => {
      this.positionFrame = null;
      this.positionPopover();
    });
  }

  dispose(): void {
    this.setOpen(false);
    this.stopPositionTracking();
    document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    this.detachScrollbar?.();
    this.detachScrollbar = null;
    this.popover.remove();
  }

  private handleOutsidePointer = (event: PointerEvent): void => {
    if (!this.open) return;
    const target = event.target as globalThis.Node | null;
    if (
      target &&
      (this.popover.contains(target) ||
        this.button.contains(target) ||
        this.isInsideRelatedTarget(target))
    ) {
      return;
    }
    this.setOpen(false);
    this.consumeOutsidePointer(event);
  };

  private readonly boundPosition = (): void => {
    this.schedulePosition();
  };

  private startPositionTracking(): void {
    window.addEventListener("resize", this.boundPosition);
    window.addEventListener("scroll", this.boundPosition, true);

    if ("ResizeObserver" in window) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => {
        this.schedulePosition();
      });
      this.resizeObserver.observe(this.button);
      this.resizeObserver.observe(this.popover);
    }
  }

  private stopPositionTracking(): void {
    window.removeEventListener("resize", this.boundPosition);
    window.removeEventListener("scroll", this.boundPosition, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.positionFrame !== null) {
      window.cancelAnimationFrame(this.positionFrame);
      this.positionFrame = null;
    }
  }

  private positionPopover(): void {
    if (!this.open || this.popover.hidden || this.isDestroyed()) return;
    const anchor = this.anchor ?? this.button;
    if (!anchor.isConnected || !this.popover.isConnected) {
      this.setOpen(false);
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = ACCESS_POPOVER_VIEWPORT_PADDING_PX;
    const spaceAbove =
      anchorRect.top - padding - ACCESS_POPOVER_OFFSET_ABOVE_PX;
    const spaceBelow =
      viewportHeight -
      anchorRect.bottom -
      padding -
      ACCESS_POPOVER_OFFSET_BELOW_PX;
    const placeAbove = this.preferBelow
      ? spaceBelow < ACCESS_POPOVER_MIN_HEIGHT_PX && spaceAbove > spaceBelow
      : spaceAbove >= 160 || spaceAbove >= spaceBelow;
    const availableHeight = Math.max(
      ACCESS_POPOVER_MIN_HEIGHT_PX,
      Math.min(
        ACCESS_POPOVER_MAX_HEIGHT_PX,
        placeAbove ? spaceAbove : spaceBelow,
      ),
    );

    const scrollEl = this.popover.querySelector<HTMLDivElement>(
      ".agent-thread-card__access-popover-scroll",
    );
    if (scrollEl) {
      scrollEl.style.maxHeight = `${availableHeight}px`;
    }

    const popoverRect = this.popover.getBoundingClientRect();
    const popoverWidth = popoverRect.width || ACCESS_POPOVER_WIDTH_PX;
    const popoverHeight = Math.min(
      popoverRect.height || availableHeight,
      availableHeight,
    );
    const maxLeft = Math.max(padding, viewportWidth - padding - popoverWidth);
    const left = Math.min(
      Math.max(anchorRect.right - popoverWidth, padding),
      maxLeft,
    );
    const offset = placeAbove
      ? ACCESS_POPOVER_OFFSET_ABOVE_PX
      : ACCESS_POPOVER_OFFSET_BELOW_PX;
    const rawTop = placeAbove
      ? anchorRect.top - offset - popoverHeight
      : anchorRect.bottom + offset;
    const maxTop = Math.max(padding, viewportHeight - padding - popoverHeight);
    const top = Math.min(Math.max(rawTop, padding), maxTop);

    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }
}
