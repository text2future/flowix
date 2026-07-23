import type { I18nKey } from "@features/i18n";
import { useMemoStore } from "@features/memo";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import type { AgentAccessEntry } from "@/lib/types/agent-access";
import { createPlusIcon } from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";
import {
  ACCESS_ACTION,
  createAccessDivider,
  createAccessEntryRow,
  createAccessSectionLabel,
  resolveAccessAction,
} from "@features/editor/extensions/agent-thread-card/access/access-entries";
import { attachAccessPopoverScrollbar } from "@features/editor/extensions/agent-thread-card/access/access-popover-scrollbar";

const ACCESS_POPOVER_OFFSET_ABOVE_PX = 15;
const ACCESS_POPOVER_OFFSET_BELOW_PX = 2;
const ACCESS_POPOVER_HORIZONTAL_PADDING_PX = 8;
const ACCESS_POPOVER_VERTICAL_PADDING_PX = 26;
const ACCESS_POPOVER_WIDTH_PX = 208;
const ACCESS_POPOVER_MAX_HEIGHT_PX = 320;
const ACCESS_POPOVER_MIN_HEIGHT_PX = 96;
// 默认仍向下；底部空间低于两倍最小可用高度时提前翻转到上方。
const ACCESS_POPOVER_FLIP_THRESHOLD_PX = ACCESS_POPOVER_MIN_HEIGHT_PX * 2;

export interface AccessPopoverControllerOptions {
  button: HTMLButtonElement;
  popover: HTMLDivElement;
  t: (key: I18nKey) => string;
  isDestroyed: () => boolean;
  isInsideRelatedTarget: (target: globalThis.Node) => boolean;
  consumeOutsidePointer: (event: PointerEvent) => void;
  /**
   * 返回当前卡片绑定的 instanceId ── 用于把"勾选"路由到
   * instance.runtimeConfig.files 快照。 undefined 时退化到全局
   * agent-access-store 行为, 兼容无 instance 的 fallback 路径。
   */
  getInstanceId?: () => string | undefined;
}

export class AccessPopoverController {
  private readonly button: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly t: (key: I18nKey) => string;
  private readonly isDestroyed: () => boolean;
  private readonly isInsideRelatedTarget: (target: globalThis.Node) => boolean;
  private readonly consumeOutsidePointer: (event: PointerEvent) => void;
  private readonly getInstanceId?: () => string | undefined;

  private anchor: HTMLElement | null = null;
  private preferBelow = true;
  private open = false;
  private resizeObserver: ResizeObserver | null = null;
  private positionFrame: number | null = null;
  private detachScrollbar: (() => void) | null = null;
  private unsubscribeAccess: (() => void) | null = null;
  private unsubscribeNotebooks: (() => void) | null = null;

  constructor(options: AccessPopoverControllerOptions) {
    this.button = options.button;
    this.popover = options.popover;
    this.t = options.t;
    this.isDestroyed = options.isDestroyed;
    this.isInsideRelatedTarget = options.isInsideRelatedTarget;
    this.consumeOutsidePointer = options.consumeOutsidePointer;
    this.getInstanceId = options.getInstanceId;

    // 单一 click handler ── 用 event delegation 派发到 [data-action] 子元素。
    // 行内 button 不再各自挂 listener, 因此不再需要三层 stopPropagation。
    // popover 整体被点中时, 由 delegation 回退到 row 自身 (整行 toggle)。
    this.popover.addEventListener("click", this.handleClick);

    // 弹窗控制器自己接管订阅 ── 之前依赖外部
    // AgentThreadCardSubscriptionsController.subscribeAccess 转发, 一旦
    // 转发链出问题 (例如线程顺序、HMR 重载) 弹窗就不重渲。 在控制器
    // 构造时直接订阅两份 store, open 期间任一变化都触发重渲, dispose
    // 时一并退订。 这样 setWorkspace / toggle / removeFolder / 加 folder
    // 之后, 弹窗不依赖任何外部组件也能更新。
    this.unsubscribeAccess = useAgentAccessStore.subscribe(() => {
      if (this.open && !this.isDestroyed()) this.render();
    });
    this.unsubscribeNotebooks = useMemoStore.subscribe(() => {
      if (this.open && !this.isDestroyed()) this.render();
    });
  }

  /**
   * 计算 entry 在当前 card instance 的有效勾选状态 ── 优先读
   * `instance.runtimeConfig.files.folders / notebooks`, 没设置则 fallback
   * 到全局 `entry.enabled`。
   *
   * 注意：entry list 仍由全局 `useAgentAccessStore` 提供 ── 用户新增/删除
   * 的目录是全应用共享的元数据；只"勾选"是 per-instance。
   */
  private isEntryEnabledByThread(entry: AgentAccessEntry): boolean {
    const instanceId = this.getInstanceId?.();
    if (!instanceId) return entry.enabled;
    const files =
      useAgentConversationStore.getState().instances[instanceId]?.runtimeConfig
        ?.files;
    if (!files) return entry.enabled;
    const list = entry.kind === "notebook" ? files.notebooks : files.folders;
    return list.includes(entry.path);
  }

  /**
   * 勾选 entry → per-instance toggle。 没 instanceId 时退化到全局 store。
   * 首次勾选 (instance 上还没有 `runtimeConfig.files` 时) ── 把全局
   * `useAgentAccessStore` 里 `enabled && !missing` 的目录同步 seed 到
   * `folders` / `notebooks`, 避免"首次勾选把所有默认 enabled 项当成
   * instance-level 关闭"的回归。
   *
   * 取消勾选 workspace folder 时, 触发 workspace 槽位重置 ── 否则 workspace
   * 还指着已取消勾选的 folder, runtime 时 cwd 会指向一个本 thread 不可用的
   * 目录。重置目标按用户要求: 选中的第一个 → 当前笔记本路径兜底。
   */
  private readonly toggleEntryByThread = async (
    entry: AgentAccessEntry,
  ): Promise<void> => {
    const instanceId = this.getInstanceId?.();
    // `entry.workspace` 是 toggle 之前的快照 ── 注意 entry 是 render() 传进来
    // 的 in-memory 对象, 它的 workspace 字段与 store 当时的 workspace 标志
    // 同步, 但 store 内部的 `set({...})` 不会写穿入参对象, 所以读 entry 即可。
    const wasWorkspace = entry.workspace === true;
    const nextEnabled = !entry.enabled;

    if (!instanceId) {
      // 全局 store 的 toggle 已自带 reassign (取第一个 enabled folder),
      // 再补一道"笔记本路径兜底"的统一 reassign ── 两条路径最终落到同一个
      // 一致状态。
      await useAgentAccessStore.getState().toggle(entry.id);
      if (wasWorkspace && !nextEnabled) {
        await this.reassignWorkspaceAfterUncheck(undefined, undefined);
      }
      return;
    }
    const state = useAgentConversationStore.getState();
    const current = state.instances[instanceId]?.runtimeConfig;
    const files =
      current?.files ?? {
        workspace: undefined,
        folders: this.collectDefaultEnabledPaths("folder"),
        notebooks: this.collectDefaultEnabledPaths("notebook"),
      };
    const isNotebook = entry.kind === "notebook";
    const list = isNotebook ? files.notebooks : files.folders;
    const next = list.includes(entry.path)
      ? list.filter((p) => p !== entry.path)
      : [...list, entry.path];
    // 取消勾选的恰是 workspace entry 时, per-thread workspace (instanceFiles.workspace)
    // 必须一并清掉 ── 否则它会继续指向已被取消勾选的 path, cascade 把 cwd 落到
    // 一个本 thread 不可用的目录上。 新 workspace 的承载交给 reassign (全局 flag)
    // + cascade (effectiveWorkspacePaths[0])。
    const clearingWorkspace = wasWorkspace && !nextEnabled;
    const nextFiles = {
        workspace: clearingWorkspace ? undefined : files.workspace,
        folders: isNotebook ? files.folders : next,
        notebooks: isNotebook ? next : files.notebooks,
      };
    state.setRuntimeConfig(instanceId, { files: nextFiles });
    void useAgentAccessStore.getState().setDefaultFiles(nextFiles);

    if (wasWorkspace && !nextEnabled) {
      // `next` 是 toggle 之后 per-thread 列表 (被勾掉的那一项已移除) ── 比
      // prev 更合适作为新 workspace 的候选池。 同时把另一 kind 的 per-thread
      // 列表也带上, 让 reassign 在 folder + notebook 范围里挑 "选中的第一个"。
      const postToggleFolders = isNotebook ? files.folders : next;
      const postToggleNotebooks = isNotebook ? next : files.notebooks;
      await this.reassignWorkspaceAfterUncheck(
        postToggleFolders,
        postToggleNotebooks,
      );
    }
  };

  /**
   * workspace 槽位重置 ── 用户取消勾选 workspace entry (folder 或 notebook) 后触发。
   * 重置优先级:
   *   1. 第一个 per-thread 勾选的 folder (post-toggle 视角) ── 用户要求的
   *      "选中的第一个", 优先尊重 thread 已选的范围。
   *   2. 没有 per-thread 勾选时, 清空所有 entries 的 workspace 标志 ──
   *      弹窗里"没有任何 folder 标 workspace"。 真正的 cwd 兜底交给
   *      `agent-runtime-spec::buildAgentRuntimeConfig` 的 cascade:
   *      `instanceFiles?.workspace || firstChecked || global workspace ||
   *      firstGlobalEnabled || cwd` ── cwd 来自 systemReminderDirectory
   *      (= 当前 notebook 路径), 由用户在提交消息时注入。 这样 cwd 兜底
   *      依旧生效, 但不污染 UI 让"新增一个 entry 标 workspace"。
   */
  private async reassignWorkspaceAfterUncheck(
    postToggleFolders: string[] | undefined,
    postToggleNotebooks: string[] | undefined,
  ): Promise<void> {
    const access = useAgentAccessStore.getState();
    const allEntries = access.config.entries;
    const normalizePath = (p: string): string => p.replace(/[\\/]+$/, "");

    // 1. 选中的第一个 ── per-thread 范围内 (folder 优先, 其次 notebook) 按
    // path 匹配的 global entry。 notebook 现在也可被设为主空间, 故不再按
    // kind 过滤候选。
    const candidatePaths = [
      ...(postToggleFolders ?? []),
      ...(postToggleNotebooks ?? []),
    ];
    for (const candidatePath of candidatePaths) {
      const target = allEntries.find(
        (e) => normalizePath(e.path) === normalizePath(candidatePath),
      );
      if (target) {
        await access.setWorkspace(target.id);
        return;
      }
    }

    // 2. 没有 per-thread 勾选 ── 清空所有 workspace 标志, 避免"新增一个
    // notebook entry, 上挂 workspace 标记" 的视觉残留。 cwd 兜底交给
    // agent-runtime-spec 的 cascade (从 systemReminderDirectory 路径流入)。
    await access.clearWorkspace();
  }

  private collectDefaultEnabledPaths(
    kind: AgentAccessEntry["kind"],
  ): string[] {
    const config = useAgentAccessStore.getState().config;
    return config.entries
      .filter((e) => e.kind === kind && e.enabled && !e.missing)
      .map((e) => e.path);
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
    preferBelow = true,
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
      // pointerdown 捕获阶段判定 "outside" ── 弹窗内任何 pointerdown 都
      // 已经通过 popover.contains() 早返, 不会关弹窗。 click 阶段由
      // delegation 在 popover 内部消化, 也不冒泡出去。
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

  /**
   * popover 的 click delegation ── 单一入口, 只响应 data-action 元素。
   * row 区域 (name / workspace avatar) 不再回退成 toggle: 用户必须显式点
   * checkbox / avatar (set-workspace) / remove 才触发动作。 这消除了"误触 row 闪一下"
   * 的体验问题 ── 之前 toggle 会同步 dispatch 到 store, 再触发订阅
   * 重渲, replaceChildren 让 hover/select 状态闪一帧。
   */
  private readonly handleClick = (event: MouseEvent): void => {
    const resolved = resolveAccessAction(event, this.popover);
    if (!resolved) return;
    event.stopPropagation();

    // 顶部级动作 ── 加 folder 没 entryId, 单独处理。
    if (resolved.kind === "top") {
      void useAgentAccessStore.getState().addFolderFromPicker().then((result) => {
        if (result.ok) {
          this.selectAddedFolderByThread(result.entry);
        } else if (result.code !== "not-selected") {
          console.error(`addFolderFromPicker error: ${result.code}`);
        }
      });
      return;
    }

    const entry = useAgentAccessStore
      .getState()
      .config.entries.find((e) => e.id === resolved.entryId);
    if (!entry) return;

    switch (resolved.action) {
      case ACCESS_ACTION.TOGGLE:
        // missing 路径禁用勾选是预期 ── UI 侧 checkbox 已 disabled, 这里再
        // 拦一道作为冗余防御, 即便 disabled 被绕过也不会 dispatch。
        if (entry.missing) return;
        void this.toggleEntryByThread(entry);
        return;
      case ACCESS_ACTION.SET_WORKSPACE: {
        // missing 路径不能被设成 workspace ── store 也会再判一次, 这里提前
        // 早返让前端日志更干净。 notebook 与 folder 都可被设为主空间, 不再按
        // kind 拦截。 与 REMOVE 形成对照: 删除 missing folder 是合法且常用的
        // 清理动作, 不应被这里拦下。
        if (entry.missing) return;
        // 设为 workspace 时, 若本 thread 已有 per-thread 勾选快照, 同步把该
        // entry 勾选进 per-thread 列表, 并把 per-thread workspace
        // (instanceFiles.workspace ── cascade 里最优先的 cwd) 指向它的 path。
        // 否则未选中 entry 设主空间会出现 "三角亮了但 checkbox 没勾 / cwd 没
        // 落到它" 的不一致。 没 per-thread 快照时退化到全局 setWorkspace (全局
        // flag + enabled, cascade 走全局路径, 已一致)。
        const instanceId = this.getInstanceId?.();
        if (instanceId) {
          const conversationState = useAgentConversationStore.getState();
          const files =
            conversationState.instances[instanceId]?.runtimeConfig?.files;
          if (files) {
            const isNotebook = entry.kind === "notebook";
            const list = isNotebook ? files.notebooks : files.folders;
            const next = list.includes(entry.path)
              ? list
              : [...list, entry.path];
            const nextFiles = {
                workspace: entry.path,
                folders: isNotebook ? files.folders : next,
                notebooks: isNotebook ? next : files.notebooks,
              };
            conversationState.setRuntimeConfig(instanceId, { files: nextFiles });
            void useAgentAccessStore.getState().setDefaultFiles(nextFiles);
          }
        }
        void useAgentAccessStore.getState().setWorkspace(entry.id);
        return;
      }
      case ACCESS_ACTION.REMOVE:
        // 删除 missing folder 是合法清理动作, 这里不拦 ── 但还是守一道
        // kind 防御, notebook 不该走 trash 路径。
        if (entry.kind !== "folder") return;
        void useAgentAccessStore.getState().removeFolder(entry.id);
        return;
    }
  };

  /**
   * A folder picked from this card should immediately belong to this thread's
   * file scope. Existing threads keep an explicit files snapshot, so adding the
   * folder to the global access list alone would otherwise render it unchecked.
   */
  private selectAddedFolderByThread(entry: AgentAccessEntry): void {
    const instanceId = this.getInstanceId?.();
    if (!instanceId) return;

    const conversationState = useAgentConversationStore.getState();
    const files =
      conversationState.instances[instanceId]?.runtimeConfig?.files;

    // Without an explicit snapshot the thread inherits the global enabled
    // state, and newly added folders are already selected there.
    if (!files || files.folders.includes(entry.path)) return;

    const nextFiles = {
      workspace: files.workspace,
      folders: [...files.folders, entry.path],
      notebooks: files.notebooks,
    };
    conversationState.setRuntimeConfig(instanceId, { files: nextFiles });
    void useAgentAccessStore.getState().setDefaultFiles(nextFiles);
  }

  render(): void {
    const { config, isLoading } = useAgentAccessStore.getState();
    const { notebooks } = useMemoStore.getState();

    // 用 thread 维度勾选状态覆盖 enabled ── entry 的其它字段保持原样, 让
    // createAccessEntryRow 沿用同一形状渲染。
    const overrideEnabled = (entry: AgentAccessEntry): AgentAccessEntry => ({
      ...entry,
      enabled: this.isEntryEnabledByThread(entry),
    });
    const folderEntries = config.entries
      .filter((entry) => entry.kind === "folder")
      .map(overrideEnabled);
    const notebookEntries = config.entries
      .filter((entry) => entry.kind === "notebook")
      .map(overrideEnabled);
    const hasFolders = folderEntries.length > 0;
    const hasNotebooks = notebookEntries.length > 0;

    // 复用已有的 scrollWrap, 而不是每次 render 都 replaceChildren 重建整个弹窗。
    // 重建有两个副作用: (1) 新 scrollWrap 没有内联 maxHeight (positionPopover 在
    // rAF 里才设), 此刻不可滚, 同步还原 scrollTop 会被夹到 0 -> 列表置顶;
    // (2) popover 内容先被清空塌成最小高度, 再在 rAF 里撑回, 用户看到 "刷新 +
    // 高度抖动"。 复用后 scrollWrap 元素及其内联 maxHeight / scrollTop 都留在
    // 原元素上, 只换它内部的 row 内容, 重渲不抖。
    let scrollWrap = this.popover.querySelector<HTMLDivElement>(
      ".agent-thread-card__access-popover-scroll",
    );
    const savedScrollTop = scrollWrap?.scrollTop ?? 0;

    if (!scrollWrap) {
      // 首次渲染: 建骨架 frame > [scrollWrap + thumb]。 footer 永远挂在
      // scrollWrap 末尾, 列表为空时 footer 单独配空提示。
      this.popover.replaceChildren();
      const scrollFrame = document.createElement("div");
      scrollFrame.className = "overlay-scrollbar-frame";
      this.popover.append(scrollFrame);

      scrollWrap = document.createElement("div");
      scrollWrap.className =
        "agent-thread-card__access-popover-scroll overlay-scrollbar";
      scrollFrame.append(scrollWrap);

      const thumb = document.createElement("div");
      thumb.className = "overlay-scrollbar-thumb";
      thumb.setAttribute("aria-hidden", "true");
      scrollFrame.append(thumb);
    } else {
      // 复用: 只清旧 row 内容 (清空瞬间 scrollTop 会被夹到 0, 已存 savedScrollTop)。
      scrollWrap.replaceChildren();
    }

    // (重)挂 scrollbar ── 复用时也重挂, 让 attach 的 rAF sync 按新内容重算 thumb。
    this.detachScrollbar?.();
    this.detachScrollbar = attachAccessPopoverScrollbar(scrollWrap);

    const footerWrap = document.createElement("div");
    footerWrap.className = "agent-thread-card__access-popover-footer";
    footerWrap.append(this.buildAddButton());

    // 布局顺序: folder section -> 「添加文件夹」按钮 -> divider -> notebook
    // section。 按钮紧贴 folder 列表末尾, 跟 folder 语义最近 ── 用户扫
    // 到 folder 列表就能立刻续上 "加一个", 不必先翻完 notebook 列表再
    // 看到底部的全局动作。 空态时按钮仍出现在 hint 文案下面, 引导路径唯一。
    if (!hasFolders && !hasNotebooks) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "agent-thread-card__access-empty";
      emptyEl.textContent = isLoading
        ? this.t("agent.access.empty.loading")
        : this.t("agent.access.empty.empty");
      scrollWrap.append(emptyEl, footerWrap);
    } else {
      if (hasFolders) this.renderSection(scrollWrap, this.t("agent.access.sectionFolder"), folderEntries, notebooks);
      if (hasFolders) scrollWrap.append(footerWrap);
      if (hasFolders && hasNotebooks) scrollWrap.append(createAccessDivider());
      if (hasNotebooks) this.renderSection(scrollWrap, this.t("agent.access.sectionNotebook"), notebookEntries, notebooks);
    }

    this.schedulePosition();

    // 还原滚动位置 ── scrollWrap 是复用的, 内联 maxHeight 仍在 (上次
    // positionPopover 设的), 内容挂好后可滚范围存在, 同步赋值即生效, 不被夹到 0。
    // scrollTop 变化触发的 scroll 事件会让 scrollbar 重算 thumb 位置。
    if (savedScrollTop > 0) {
      scrollWrap.scrollTop = savedScrollTop;
    }
  }

  private renderSection(
    container: HTMLElement,
    label: string,
    entries: AgentAccessEntry[],
    notebooks: { id: string; icon?: string | null }[],
  ): void {
    container.append(createAccessSectionLabel(label));
    const t = (key: string): string => this.t(key as I18nKey);
    for (const entry of entries) {
      container.append(createAccessEntryRow({ entry, notebooks, t }));
    }
  }

  private buildAddButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-thread-card__access-add";
    // addFolder 是全局行为 (写 useAgentAccessStore), 不是 per-instance。
    // 在按钮上加 title 提示, 避免用户误以为"加到本卡片"。
    button.title = this.t("agent.access.addFolderHint");
    button.setAttribute("aria-label", this.t("agent.access.addFolderHint"));
    button.dataset.action = ACCESS_ACTION.ADD_FOLDER;
    const iconWrap = document.createElement("span");
    iconWrap.className = "agent-thread-card__access-add-icon-wrap";
    iconWrap.append(createPlusIcon());
    const label = document.createElement("span");
    label.className = "agent-thread-card__access-add-label";
    label.textContent = this.t("agent.access.addFolder");
    button.append(iconWrap, label);
    return button;
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
    this.popover.removeEventListener("click", this.handleClick);
    this.unsubscribeAccess?.();
    this.unsubscribeAccess = null;
    this.unsubscribeNotebooks?.();
    this.unsubscribeNotebooks = null;
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
    // popover 自身被移除 (NodeView 销毁等) 才关弹窗。 anchor 失联不关 ──
    // anchor 经常是 external settings 的 files 按钮, 在空对话卡片的
    // renderThreadState -> renderEmptyState 路径里会被 body.replaceChildren
    // 顺手重建 (旧 filesButton disconnected, 新 filesButton 赋给
    // externalAgentSettings.filesButton, 但 controller.anchor 还指着旧的)。
    // 此时关弹窗会让"点 checkbox 切换勾选"误关弹窗, 违反 UX 契约。 改为:
    // anchor 失联时保持 popover 上次位置不动 (style.left/top 还在), 不
    // 重新定位也不关闭; popover 内容已由 render() 刷新, 用户看到的是
    // "勾选状态变了, 弹窗还在原地"。
    if (!this.popover.isConnected) {
      this.setOpen(false);
      return;
    }
    const anchor = this.anchor ?? this.button;
    if (!anchor.isConnected) {
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const horizontalPadding = ACCESS_POPOVER_HORIZONTAL_PADDING_PX;
    const verticalPadding = ACCESS_POPOVER_VERTICAL_PADDING_PX;
    const spaceAbove =
      anchorRect.top - verticalPadding - ACCESS_POPOVER_OFFSET_ABOVE_PX;
    const spaceBelow =
      viewportHeight -
      anchorRect.bottom -
      verticalPadding -
      ACCESS_POPOVER_OFFSET_BELOW_PX;
    const placeAbove = this.preferBelow
      ? spaceBelow < ACCESS_POPOVER_FLIP_THRESHOLD_PX &&
        spaceAbove > spaceBelow
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
      // availableHeight 是整个 popover 外框可占的高度。滚动区之外还有
      // border + vertical padding；若直接把 availableHeight 全给 scroll，
      // 外框会再多出这段 chrome，实际底边便会侵入 26px 安全间距。
      const popoverRectBeforeResize = this.popover.getBoundingClientRect();
      const scrollRectBeforeResize = scrollEl.getBoundingClientRect();
      const chromeHeight = Math.max(
        0,
        popoverRectBeforeResize.height - scrollRectBeforeResize.height,
      );
      scrollEl.style.maxHeight = `${Math.max(0, availableHeight - chromeHeight)}px`;
    }

    const popoverRect = this.popover.getBoundingClientRect();
    const popoverWidth = popoverRect.width || ACCESS_POPOVER_WIDTH_PX;
    const popoverHeight = Math.min(
      popoverRect.height || availableHeight,
      availableHeight,
    );
    const maxLeft = Math.max(
      horizontalPadding,
      viewportWidth - horizontalPadding - popoverWidth,
    );
    const left = Math.min(
      Math.max(anchorRect.right - popoverWidth, horizontalPadding),
      maxLeft,
    );
    const offset = placeAbove
      ? ACCESS_POPOVER_OFFSET_ABOVE_PX
      : ACCESS_POPOVER_OFFSET_BELOW_PX;
    const rawTop = placeAbove
      ? anchorRect.top - offset - popoverHeight
      : anchorRect.bottom + offset;
    const maxTop = Math.max(
      verticalPadding,
      viewportHeight - verticalPadding - popoverHeight,
    );
    const top = Math.min(Math.max(rawTop, verticalPadding), maxTop);

    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }
}
