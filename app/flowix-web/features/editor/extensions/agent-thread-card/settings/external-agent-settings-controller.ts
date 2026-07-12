import type { AppLanguage, I18nKey } from "@features/i18n";
import { translate } from "@features/i18n";
import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import {
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
} from "@features/agent/config/codex-options";
import {
  getAgentAccessOptions,
  supportsAgentRuntimeSetting,
  type AgentRuntimeSettingKind,
} from "@features/agent/runtime/agent-runtime-spec";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useChatStore } from "@features/agent/store/chat-store";
import { agent } from "@platform/tauri/client";
import {
  applyPopoverPosition,
  calculateAnchoredPopoverPosition,
} from "@features/editor/extensions/agent-thread-card/popover/popover-position";
import {
  createCodexSettingsItem,
  createExternalAgentEmptyControl,
  updateExternalAgentEmptyControl,
  type ExternalAgentEmptyControlKind,
} from "@features/editor/extensions/agent-thread-card/settings/external-agent-settings";

const CODEX_SETTINGS_POPOVER_WIDTH_PX = 220;
const CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX = 280;
const CODEX_SETTINGS_POPOVER_OFFSET_PX = 6;
const CODEX_SETTINGS_POPOVER_VIEWPORT_PADDING_PX = 8;

type AgentModelOption = {
  id: AgentCodexModel;
  label: string;
};

const CLAUDE_MODEL_OPTIONS: AgentModelOption[] = [
  { id: "claude-opus-4-8", label: "claude-opus-4-8" },
  { id: "claude-sonnet-5", label: "claude-sonnet-5" },
  { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
];

export interface ExternalAgentSettingsControllerOptions {
  popover: HTMLDivElement;
  getTypeKey: () => AgentTypeKey;
  /**
   * Phase 3: 返回当前卡片绑定的 threadId ── 用于把 model/permission/reasoning
   * 控件读写路由到 per-thread 的 `chat-store.threadRuntimeConfig[tid]`,
   * 实现"不同 Agent Thread Card 不共享配置"。如果 undefined (如编辑器临时预览),
   * 则退化为全局 useChatStore 行为, 不影响现有 fallback 路径。
   */
  getThreadId: () => string | undefined;
  getLanguage: () => AppLanguage;
  t: (key: I18nKey) => string;
  isDestroyed: () => boolean;
  isAccessPopoverOpen: () => boolean;
  setAccessPopoverOpen: (
    open: boolean,
    anchor?: HTMLElement | null,
    preferBelow?: boolean,
  ) => void;
  consumeOutsidePointer?: (event: PointerEvent) => void;
}

export class ExternalAgentSettingsController {
  private readonly popover: HTMLDivElement;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly getThreadId: () => string | undefined;
  private readonly getLanguage: () => AppLanguage;
  private readonly t: (key: I18nKey) => string;
  private readonly isDestroyed: () => boolean;
  private readonly isAccessPopoverOpen: () => boolean;
  private readonly setAccessPopoverOpen: (
    open: boolean,
    anchor?: HTMLElement | null,
    preferBelow?: boolean,
  ) => void;
  private readonly consumeOutsidePointer?: (event: PointerEvent) => void;

  private modelButton: HTMLButtonElement | null = null;
  private reasoningButton: HTMLButtonElement | null = null;
  private permissionButton: HTMLButtonElement | null = null;
  private filesButton: HTMLButtonElement | null = null;
  private anchor: HTMLButtonElement | null = null;
  private kind: AgentRuntimeSettingKind | null = null;
  private open = false;
  private resizeObserver: ResizeObserver | null = null;
  private positionFrame: number | null = null;
  private codexDefaultModel = "";
  private claudeSelectedModel: AgentCodexModel = "inherit";
  private localSupportedModelsTypeKey: AgentTypeKey | null = null;
  private localSupportedModels: AgentModelOption[] = [];

  readonly boundPosition = (): void => {
    this.schedulePosition();
  };

  constructor(options: ExternalAgentSettingsControllerOptions) {
    this.popover = options.popover;
    this.getTypeKey = options.getTypeKey;
    this.getThreadId = options.getThreadId;
    this.getLanguage = options.getLanguage;
    this.t = options.t;
    this.isDestroyed = options.isDestroyed;
    this.isAccessPopoverOpen = options.isAccessPopoverOpen;
    this.setAccessPopoverOpen = options.setAccessPopoverOpen;
    this.consumeOutsidePointer = options.consumeOutsidePointer;
  }

  /**
   * 读 model/permission/reasoning 控件的当前值 ── Phase 3 优先 per-thread。
   *  - threadId 存在 + threadRuntimeConfig[tid] 对应字段非空 → 用 thread 值
   *  - 否则 → fallback 到全局 useChatStore 对应字段
   *
   * 注意：fallback 不写回 threadRuntimeConfig ── 仅"显示"，不修改 in-memory
   * 缓冲。发消息时若 thread 没显式设置, 后端读 thread.runtime_config=null
   * 也会 fallback, 行为一致。
   */
  private readRuntimeSetting<K extends "model" | "permission" | "reasoning">(
    kind: K,
  ): string | undefined {
    const tid = this.getThreadId();
    const state = useChatStore.getState();
    if (tid) {
      const threadCfg = state.threadRuntimeConfig[tid];
      if (threadCfg) {
        if (kind === "model" && threadCfg.model?.key) {
          return threadCfg.model.key;
        }
        if (kind === "permission" && threadCfg.access?.sandbox) {
          return threadCfg.access.sandbox;
        }
        if (kind === "reasoning" && threadCfg.reasoningEffort) {
          return threadCfg.reasoningEffort;
        }
      }
    }
    if (kind === "model") return state.agentCodexModel;
    if (kind === "permission") return state.agentPermissionMode;
    if (kind === "reasoning") return state.agentCodexReasoningEffort;
    return undefined;
  }

  /**
   * 写 model/permission/reasoning 控件 → Phase 3 路由到 threadRuntimeConfig[tid]。
   * tid 不存在（编辑器临时态）时退化为全局 setAgent*, 保持现有 fallback 行为。
   */
  private writeRuntimeSetting(
    kind: "model" | "permission" | "reasoning",
    value: string,
  ): void {
    const tid = this.getThreadId();
    const state = useChatStore.getState();
    if (tid) {
      if (kind === "model") {
        state.setThreadRuntimeConfig(tid, {
          model: { key: value },
        });
        return;
      }
      if (kind === "permission") {
        state.setThreadRuntimeConfig(tid, {
          access: { sandbox: value as AgentPermissionMode },
        });
        return;
      }
      // reasoning effort: 现在进 threadRuntimeConfig.reasoningEffort,
      // 与 model / permission 同维度 (per-thread 锁定)。
      state.setThreadRuntimeConfig(tid, {
        reasoningEffort: value as AgentCodexReasoningEffort,
      });
      return;
    }
    // 无 tid (编辑器临时态) ── 退化到全局, 保留兼容。
    if (kind === "model") {
      state.setAgentCodexModel(value as AgentCodexModel);
      return;
    }
    if (kind === "permission") {
      state.setAgentPermissionMode(value as AgentPermissionMode);
      return;
    }
    state.setAgentCodexReasoningEffort(value as AgentCodexReasoningEffort);
  }

  get isOpen(): boolean {
    return this.open;
  }

  get popoverElement(): HTMLDivElement {
    return this.popover;
  }

  get anchorElement(): HTMLButtonElement | null {
    return this.anchor;
  }

  get filesControl(): HTMLButtonElement | null {
    return this.filesButton;
  }

  loadDefaultModel(): void {
    const typeKey = this.getTypeKey();
    void agent
      .getCodexDefaultModel()
      .then((model) => {
        if (this.isDestroyed()) return;
        this.codexDefaultModel = model.trim();
        this.refreshEmptySettings();
        if (this.open && this.kind === "model") {
          this.renderPopover();
          this.schedulePosition();
        }
      })
      .catch(() => {
        // Keep the generic default label when Codex has no configured default.
      });

    const listSupportedModels =
      "listSupportedModels" in agent &&
      typeof agent.listSupportedModels === "function"
        ? agent.listSupportedModels.bind(agent)
        : async () => [];

    void listSupportedModels(typeKey)
      .then((models) => {
        if (this.isDestroyed() || this.getTypeKey() !== typeKey) return;
        const seen = new Set<string>();
        this.localSupportedModelsTypeKey = typeKey;
        this.localSupportedModels = models
          .map((model) => model.trim())
          .filter((model) => model.length > 0)
          .filter((model) => {
            if (seen.has(model)) return false;
            seen.add(model);
            return true;
          })
          .map((model) => ({ id: model, label: model }));
        this.refreshEmptySettings();
        if (this.open && this.kind === "model") {
          this.renderPopover();
          this.schedulePosition();
        }
      })
      .catch(() => {
        if (this.isDestroyed() || this.getTypeKey() !== typeKey) return;
        this.localSupportedModelsTypeKey = typeKey;
        this.localSupportedModels = [];
      });
  }

  createEmptySettings(): HTMLElement {
    const empty = document.createElement("div");
    empty.className =
      "agent-thread-card__empty agent-thread-card__empty--codex-settings";

    this.modelButton = this.supportsRuntimeSetting("model")
      ? this.createEmptyControl(
          "model",
          this.t("agent.model.title"),
          this.getCurrentExternalModelLabel(),
        )
      : null;
    this.reasoningButton = null;
    this.permissionButton = this.supportsRuntimeSetting("permission")
      ? this.createEmptyControl(
          "permission",
          this.t("agent.permission.title"),
          this.getCurrentPermissionLabel(),
        )
      : null;
    this.filesButton = this.createEmptyControl(
      "files",
      this.t("agent.files.title"),
      this.getFilesControlLabel(),
    );

    for (const button of [
      this.modelButton,
      this.reasoningButton,
      this.permissionButton,
      this.filesButton,
    ]) {
      if (button) empty.append(button);
    }
    return empty;
  }

  refreshEmptySettings(): void {
    updateExternalAgentEmptyControl(
      this.modelButton,
      this.getCurrentExternalModelLabel(),
    );
    updateExternalAgentEmptyControl(
      this.permissionButton,
      this.getCurrentPermissionLabel(),
    );
    updateExternalAgentEmptyControl(
      this.reasoningButton,
      this.getCurrentCodexReasoningLabel(),
    );
    updateExternalAgentEmptyControl(this.filesButton, this.getFilesControlLabel());
  }

  toggleSettingsPopover(
    kind: AgentRuntimeSettingKind,
    anchor: HTMLButtonElement,
  ): void {
    const sameMenuOpen =
      this.open && this.kind === kind && this.anchor === anchor;
    this.setSettingsPopoverOpen(!sameMenuOpen, kind, anchor);
  }

  setSettingsPopoverOpen(
    open: boolean,
    kind: AgentRuntimeSettingKind | null = null,
    anchor: HTMLButtonElement | null = null,
  ): void {
    if (this.open === open && (!open || this.kind === kind)) return;
    this.open = open;
    this.kind = open ? kind : null;
    this.anchor = open ? anchor : null;
    this.popover.hidden = !open;
    this.syncControlOpenState(open, kind);

    if (open && kind && anchor) {
      this.renderPopover();
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
    }
  }

  handleOutsidePointer = (event: PointerEvent): void => {
    if (!this.open) return;
    const target = event.target as globalThis.Node | null;
    if (
      target &&
      (this.popover.contains(target) || this.anchor?.contains(target))
    ) {
      return;
    }
    this.setSettingsPopoverOpen(false);
    this.consumeOutsidePointer?.(event);
  };

  renderPopover(): void {
    const kind = this.kind;
    this.popover.replaceChildren();
    if (!kind || !this.supportsRuntimeSetting(kind)) return;

    if (kind !== "model") {
      const title = document.createElement("div");
      title.className = "agent-thread-card__codex-settings-title";
      title.textContent = this.t(
        kind === "reasoning" ? "agent.reasoning.title" : "agent.permission.title",
      );
      this.popover.append(title);
    }

    if (kind === "model") {
      this.renderModelSettings();
      return;
    }
    if (kind === "reasoning") {
      this.renderReasoningSettings();
      return;
    }
    this.renderPermissionSettings();
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
    this.setSettingsPopoverOpen(false);
    this.stopPositionTracking();
    document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    this.popover.remove();
  }

  private createEmptyControl(
    kind: ExternalAgentEmptyControlKind,
    label: string,
    value: string,
  ): HTMLButtonElement {
    return createExternalAgentEmptyControl(kind, label, value, (nextKind, button) => {
      if (nextKind === "files") {
        this.setSettingsPopoverOpen(false);
        this.setAccessPopoverOpen(!this.isAccessPopoverOpen(), button, true);
        return;
      }
      this.setAccessPopoverOpen(false);
      this.toggleSettingsPopover(nextKind, button);
    });
  }

  private syncControlOpenState(
    open: boolean,
    kind: AgentRuntimeSettingKind | null,
  ): void {
    this.modelButton?.setAttribute(
      "aria-expanded",
      open && kind === "model" ? "true" : "false",
    );
    this.permissionButton?.setAttribute(
      "aria-expanded",
      open && kind === "permission" ? "true" : "false",
    );
    this.reasoningButton?.setAttribute(
      "aria-expanded",
      open && kind === "reasoning" ? "true" : "false",
    );
    this.modelButton?.classList.toggle(
      "agent-thread-card__empty-control--open",
      open && kind === "model",
    );
    this.permissionButton?.classList.toggle(
      "agent-thread-card__empty-control--open",
      open && kind === "permission",
    );
    this.reasoningButton?.classList.toggle(
      "agent-thread-card__empty-control--open",
      open && kind === "reasoning",
    );
  }

  private getPermissionLabel(id: AgentPermissionMode): string {
    const options = this.getAccessOptionsForType();
    return options.find((option) => option.id === id)?.label ?? options[0].label;
  }

  private getAccessOptionsForType(): readonly {
    id: AgentPermissionMode;
    label: string;
  }[] {
    return getAgentAccessOptions(this.getTypeKey());
  }

  private getExternalAgentModel(): AgentCodexModel {
    // Phase 3: claude 仍走 local state (per-controller); codex/claude-other
    // 改为走 threadRuntimeConfig 优先, fallback 全局 agentCodexModel.
    if (this.getTypeKey() === "claude") {
      return this.claudeSelectedModel;
    }
    const fromThread = this.readRuntimeSetting("model");
    if (fromThread) return fromThread as AgentCodexModel;
    return useChatStore.getState().agentCodexModel;
  }

  private setExternalAgentModel(model: AgentCodexModel): void {
    if (this.getTypeKey() === "claude") {
      this.claudeSelectedModel = model;
      this.refreshEmptySettings();
      return;
    }
    this.writeRuntimeSetting("model", model);
  }

  // Returns empty string when there is no real default model id to display.
  // 空状态 ── 没有真实 default model id 时返回空串, 调用方应据此隐藏
  // 「Default」项而不是渲染「Codex default」之类的兜底文案。
  private getExternalModelDefaultLabel(): string {
    if (this.getTypeKey() === "claude") return this.t("agent.permission.default");
    return this.codexDefaultModel
      ? translate(this.getLanguage(), "agent.codexModel.defaultWith", {
          model: this.codexDefaultModel,
        })
      : "";
  }

  private getExternalModelFallbackOptions(): AgentModelOption[] {
    return this.getTypeKey() === "claude"
      ? CLAUDE_MODEL_OPTIONS
      : CODEX_MODEL_OPTIONS;
  }

  private getExternalModelOptions(): AgentModelOption[] {
    const currentModel = this.getExternalAgentModel();
    const localOptions =
      this.localSupportedModelsTypeKey === this.getTypeKey()
        ? this.localSupportedModels
        : [];
    const modelOptions =
      localOptions.length > 0
        ? localOptions
        : this.getExternalModelFallbackOptions();
    const inheritLabel = this.getExternalModelDefaultLabel();
    const options: AgentModelOption[] = [
      ...(inheritLabel ? [{ id: "inherit" as AgentCodexModel, label: inheritLabel }] : []),
      ...modelOptions,
    ];
    if (
      currentModel !== "inherit" &&
      !options.some((option) => option.id === currentModel)
    ) {
      options.push({ id: currentModel, label: currentModel });
    }
    return options;
  }

  private getCurrentExternalModelLabel(): string {
    const model = this.getExternalAgentModel();
    const options = this.getExternalModelOptions();
    const match = options.find((option) => option.id === model);
    if (match) return match.label;
    // 「inherit」被过滤 (无 default model id) ── 落到第一个真实 model,
    // 不渲染空 label。 选取 CODEX_MODEL_OPTIONS / CLAUDE_MODEL_OPTIONS
    // 中第一个作为 fallback, 与「无 default 时第一个 model 即默认」的
    // 隐式语义对齐。
    const fallback = options.find(
      (option) => option.id !== ("inherit" as AgentCodexModel),
    );
    return fallback?.label ?? this.getExternalModelDefaultLabel();
  }

  private getCurrentCodexReasoningLabel(): string {
    const effort = useChatStore.getState().agentCodexReasoningEffort;
    return (
      CODEX_REASONING_OPTIONS.find((option) => option.id === effort)?.label ??
      "Medium"
    );
  }

  private getCurrentPermissionLabel(): string {
    return this.getPermissionLabel(useChatStore.getState().agentPermissionMode);
  }

  private getFilesControlLabel(): string {
    const workspaceEntry = useAgentAccessStore
      .getState()
      .config.entries.find((entry) => entry.workspace && !entry.missing);
    if (!workspaceEntry) return this.t("agent.access.empty.empty");
    const explicitName = workspaceEntry.name?.trim();
    if (explicitName) return explicitName;
    const segments = workspaceEntry.path.split(/[\\/]+/).filter(Boolean);
    const folderName = segments[segments.length - 1]?.trim();
    return folderName ? folderName : this.t("agent.access.empty.empty");
  }

  private supportsRuntimeSetting(kind: AgentRuntimeSettingKind): boolean {
    return supportsAgentRuntimeSetting(this.getTypeKey(), kind);
  }

  private renderModelSettings(): void {
    const modelSection = document.createElement("div");
    modelSection.className = "agent-thread-card__codex-settings-section";
    modelSection.textContent = this.t("agent.model.title");
    this.popover.append(modelSection);

    const current = this.getExternalAgentModel();
    this.getExternalModelOptions().forEach((option) => {
      this.popover.append(
        createCodexSettingsItem(option.label, option.id === current, () => {
          this.setExternalAgentModel(option.id);
          this.setSettingsPopoverOpen(false);
        }),
      );
    });

    if (!this.supportsRuntimeSetting("reasoning")) return;

    const divider = document.createElement("hr");
    divider.className = "agent-thread-card__codex-settings-divider";
    this.popover.append(divider);

    const reasoningSection = document.createElement("div");
    reasoningSection.className = "agent-thread-card__codex-settings-section";
    reasoningSection.textContent = this.t("agent.reasoningDepth.title");
    this.popover.append(reasoningSection);

    this.renderReasoningOptions();
  }

  private renderReasoningSettings(): void {
    this.renderReasoningOptions();
  }

  private renderReasoningOptions(): void {
    const current =
      this.readRuntimeSetting("reasoning") ??
      useChatStore.getState().agentCodexReasoningEffort;
    CODEX_REASONING_OPTIONS.forEach((option) => {
      this.popover.append(
        createCodexSettingsItem(option.label, option.id === current, () => {
          this.writeRuntimeSetting("reasoning", option.id);
          this.setSettingsPopoverOpen(false);
        }),
      );
    });
  }

  private renderPermissionSettings(): void {
    const current =
      this.readRuntimeSetting("permission") ??
      useChatStore.getState().agentPermissionMode;
    this.getAccessOptionsForType().forEach((option) => {
      this.popover.append(
        createCodexSettingsItem(option.label, option.id === current, () => {
          this.writeRuntimeSetting("permission", option.id);
          this.setSettingsPopoverOpen(false);
        }),
      );
    });
  }

  private startPositionTracking(): void {
    window.addEventListener("resize", this.boundPosition);
    window.addEventListener("scroll", this.boundPosition, true);
    if ("ResizeObserver" in window && this.anchor) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => {
        this.schedulePosition();
      });
      this.resizeObserver.observe(this.anchor);
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
    const anchor = this.anchor;
    if (
      !this.open ||
      this.popover.hidden ||
      !anchor ||
      this.isDestroyed()
    ) {
      return;
    }
    if (!anchor.isConnected || !this.popover.isConnected) {
      this.setSettingsPopoverOpen(false);
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const padding = CODEX_SETTINGS_POPOVER_VIEWPORT_PADDING_PX;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popoverRect = this.popover.getBoundingClientRect();
    const popoverWidth = popoverRect.width || CODEX_SETTINGS_POPOVER_WIDTH_PX;
    const popoverHeight = Math.min(
      popoverRect.height || CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX,
      CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX,
    );
    applyPopoverPosition(
      this.popover,
      calculateAnchoredPopoverPosition({
        anchorRect,
        popoverWidth,
        popoverHeight,
        viewportWidth,
        viewportHeight,
        padding,
        offset: CODEX_SETTINGS_POPOVER_OFFSET_PX,
      }),
    );
  }
}
