import type { I18nKey } from "@features/i18n";
import { useMemoStore } from "@features/memo";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useChatStore } from "@features/agent/store/chat-store";
import type { AgentAccessEntry } from "@/lib/types/agent-access";
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
  /**
   * Phase 4: 返回当前卡片绑定的 threadId ── 用于把"勾选 / 主工作目录"
   * 路由到 per-thread 的 `chat-store.threadRuntimeConfig[tid].files`。
   * undefined 时退化为全局 agent-access-store 行为, 兼容现有 fallback 路径。
   */
  getThreadId?: () => string | undefined;
}

export class AccessPopoverController {
  private readonly button: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly t: (key: I18nKey) => string;
  private readonly isDestroyed: () => boolean;
  private readonly isInsideRelatedTarget: (target: globalThis.Node) => boolean;
  private readonly consumeOutsidePointer: (event: PointerEvent) => void;
  private readonly getThreadId?: () => string | undefined;

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
    this.getThreadId = options.getThreadId;
  }

  /**
   * Phase 4: 计算 entry 在当前 thread 的有效勾选状态 ── 优先读
   * `threadRuntimeConfig[tid].files.folders / notebooks`, 没设置则 fallback
   * 到全局 `entry.enabled` (向后兼容, 老 thread 不动行为)。
   *
   * 注意：entry list 仍由全局 `useAgentAccessStore` 提供 ── 用户新增/删除
   * 的目录是全应用共享的元数据；只"勾选"是 per-thread。
   */
  private isEntryEnabledByThread(entry: AgentAccessEntry): boolean {
    const tid = this.getThreadId?.();
    if (!tid) return entry.enabled;
    const files = useChatStore.getState().threadRuntimeConfig[tid]?.files;
    if (!files) return entry.enabled;
    const list = entry.kind === "notebook" ? files.notebooks : files.folders;
    return list.includes(entry.path);
  }

  /**
   * Phase 4: 勾选 entry → per-thread toggle。
   * 把 entry.path 加入 / 移出 `threadRuntimeConfig[tid].files.{folders|notebooks}`。
   * 没 threadId 时退化到全局 `useAgentAccessStore.toggle`。
   */
  private readonly toggleEntryByThread = async (
    entry: AgentAccessEntry,
  ): Promise<void> => {
    const tid = this.getThreadId?.();
    if (!tid) {
      await useAgentAccessStore.getState().toggle(entry.id);
      return;
    }
    const state = useChatStore.getState();
    const current = state.threadRuntimeConfig[tid];
    const files = current?.files ?? { folders: [], notebooks: [] };
    const isNotebook = entry.kind === "notebook";
    const list = isNotebook ? files.notebooks : files.folders;
    const next = list.includes(entry.path)
      ? list.filter((p) => p !== entry.path)
      : [...list, entry.path];
    state.setThreadRuntimeConfig(tid, {
      files: {
        workspace: files.workspace,
        folders: isNotebook ? files.folders : next,
        notebooks: isNotebook ? next : files.notebooks,
      },
    });
  };

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
    const { config, isLoading, addFolderFromPicker, removeFolder } =
      useAgentAccessStore.getState();
    const { notebooks } = useMemoStore.getState();
    const notebookEntries = config.entries.filter(
      (entry) => entry.kind === "notebook",
    );
    const folderEntries = config.entries.filter(
      (entry) => entry.kind === "folder",
    );

    // Phase 4: 构造 effective entry 列表 ── 覆盖 `enabled` 字段为 thread 维度
    // 的勾选状态。entry.id / entry.path / entry.kind 等元数据保持原样,
    // 让 createAccessEntryRow 复用。
    const overrideEnabled = (entry: AgentAccessEntry): AgentAccessEntry => ({
      ...entry,
      enabled: this.isEntryEnabledByThread(entry),
    });
    const effectiveFolderEntries = folderEntries.map(overrideEnabled);
    const effectiveNotebookEntries = notebookEntries.map(overrideEnabled);

    // Phase 4: per-thread toggle ── 包一层, 写入 threadRuntimeConfig.files。
    const effectiveToggle = async (id: string): Promise<void> => {
      const entry = config.entries.find((e) => e.id === id);
      if (!entry) return;
      await this.toggleEntryByThread(entry);
    };

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

    if (
      effectiveNotebookEntries.length === 0 &&
      effectiveFolderEntries.length === 0
    ) {
      const empty = document.createElement("div");
      empty.className = "agent-thread-card__access-empty";
      empty.textContent = isLoading
        ? this.t("agent.access.empty.loading")
        : this.t("agent.access.empty.empty");
      scrollWrap.append(empty, footerWrap);
    } else {
      if (effectiveFolderEntries.length > 0) {
        scrollWrap.append(
          createAccessSectionLabel(this.t("agent.access.sectionFolder")),
        );
        effectiveFolderEntries.forEach((entry) => {
          scrollWrap.append(
            createAccessEntryRow({
              entry,
              notebooks,
              t: (key) => this.t(key as I18nKey),
              toggle: effectiveToggle,
              removeFolder,
            }),
          );
        });
        scrollWrap.append(footerWrap);
      }
      if (
        effectiveNotebookEntries.length > 0 &&
        effectiveFolderEntries.length > 0
      ) {
        scrollWrap.append(createAccessDivider());
      }
      if (effectiveNotebookEntries.length > 0) {
        scrollWrap.append(
          createAccessSectionLabel(this.t("agent.access.sectionNotebook")),
        );
        effectiveNotebookEntries.forEach((entry) => {
          scrollWrap.append(
            createAccessEntryRow({
              entry,
              notebooks,
              t: (key) => this.t(key as I18nKey),
              toggle: effectiveToggle,
              removeFolder,
            }),
          );
        });
        if (effectiveFolderEntries.length === 0) {
          scrollWrap.append(footerWrap);
        }
      }
    }

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "agent-thread-card__access-add";
    // P2#5 提示: addFolder 是全局行为 (写 useAgentAccessStore), 不是 per-thread。
    // 在按钮上加 title 提示, 避免用户误以为"加到本卡片"。
    addButton.title = this.t("agent.access.addFolderHint");
    addButton.setAttribute(
      "aria-label",
      this.t("agent.access.addFolderHint"),
    );
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
