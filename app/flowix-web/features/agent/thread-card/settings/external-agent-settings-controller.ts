import { AgentEmptyStateController, type AgentEmptyStatePresentation } from "./agent-empty-state-controller";
export type { AgentEmptyStatePresentation } from "./agent-empty-state-controller";
import { resolveAgentPreferenceRuntimeConfig } from "@features/agent/store/agent-user-preferences";
import cursorOutlineSvg from "@/assets/cursor-outline.svg?raw";
import folderOutlineSvg from "@/assets/folder-outline.svg?raw";
import shieldAlertOutlineSvg from "@/assets/shield-alert-outline.svg?raw";
import shieldCheckOutlineSvg from "@/assets/shield-check-outline.svg?raw";
import type { AppLanguage, I18nKey, I18nParams } from "@/lib/i18n";
import { translate } from "@/lib/i18n";
import { getWorkspaceAgentRepositories } from "@features/agent/public/workspace-api";
import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentCodexServiceTier,
  AgentHarnessPreset,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import {
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
  formatModelDisplayLabel,
} from "@features/agent/config/codex-options";

import {
  supportsAgentRuntimeSetting,
  type AgentAccessOption,
  type AgentRuntimeSettingKind,
} from "@features/agent/runtime/agent-runtime-spec";
import { modelPreferenceKey, useAgentDataStore, type AgentModelCatalog } from "@features/agent/store/agent-data-store";
import { useAgentWorkspaceStore } from "@features/agent/store/agent-workspace-store";
import {
  loadAgentModelCatalog,
} from "@features/agent/services/agent-catalog-service";
import { loadPiCloudModelCatalog } from "@features/agent/services/pi-cloud-model-service";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { useNoteStore } from "@features/memo/store/note-store";
import { resolvePrimaryWorkspace } from "@features/agent/runtime/primary-workspace";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";
import { normalizeAgentRuntimeStatus } from "@features/agent/runtime/agent-runtime-status";
import {
  normalizeConversationWorkspaceState,
  selectDesiredWorkspace,
} from "@features/agent/runtime/conversation-workspace";
import { ensureConversationWorkspaceSnapshot } from "@features/agent/runtime/workspace-snapshot";
import { agent, windows } from "@platform/tauri/client";
import { POPUP_SEPARATOR_CLASS } from "@shared/ui/popup-separator";
import { subscribe, type UnlistenFn } from "@platform/tauri/event-bus";
import {
  applyPopoverPosition,
  calculateAnchoredPopoverPosition,
} from "@features/agent/thread-card/popover/popover-position";
import {
  createCodexSettingsItem,
  createExternalAgentEmptyControl,
  createExternalAgentWorkspaceControl,
  createExternalAgentWorkspaceDisplay,
  updateExternalAgentEmptyControl,
  type ExternalAgentEmptyControlKind,
} from "@features/agent/thread-card/settings/external-agent-settings";
import {
  createChevronIcon,
  createPlusIcon,
  createTrashIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";
import type { ComposerSlashSkill } from "@features/agent/thread-card/composer/composer-slash-command-controller";
import {
  createPiModelPicker,
  isFlowixCloudModelOption,
} from "@features/agent/thread-card/settings/model-picker/pi-model-picker";
import type { AgentModelOption } from "@features/agent/thread-card/settings/model-picker/model-picker-types";

const PI_THINKING_OPTIONS = [
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;

/** Efforts a Codex composer can select; `off`/`minimal` only exist for other runtimes. */
type CodexComposerEffort = Extract<
  AgentCodexReasoningEffort,
  "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
>;

const CODEX_COMPOSER_EFFORT_LABEL_KEYS = {
  low: "agent.reasoningDepth.composer.low",
  medium: "agent.reasoningDepth.composer.medium",
  high: "agent.reasoningDepth.composer.high",
  xhigh: "agent.reasoningDepth.composer.xhigh",
  max: "agent.reasoningDepth.composer.max",
  ultra: "agent.reasoningDepth.composer.ultra",
} satisfies Record<CodexComposerEffort, I18nKey>;

const CODEX_SETTINGS_POPOVER_WIDTH_PX = 212;
const CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX = 280;
const CODEX_SETTINGS_POPOVER_OFFSET_PX = 6;
const CODEX_SETTINGS_POPOVER_VIEWPORT_PADDING_PX = 8;
type SettingsPopoverPlacement = "anchor" | "submenu";


function createComposerWorkspaceIcon(): SVGSVGElement | null {
  const template = document.createElement("template");
  template.innerHTML = folderOutlineSvg.trim();
  const icon = template.content.firstElementChild as SVGSVGElement | null;
  if (!icon) return null;
  icon.classList.add("agent-composer__workspace-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  return icon;
}

function createPermissionModeIcon(
  mode: AgentPermissionMode,
): SVGSVGElement | null {
  const svgSource =
    mode === "danger-full-access"
      ? shieldAlertOutlineSvg
      : mode === "workspace-write"
        ? shieldCheckOutlineSvg
        : mode === "read-only"
          ? cursorOutlineSvg
          : null;
  if (!svgSource) return null;
  const template = document.createElement("template");
  template.innerHTML = svgSource.trim();
  const icon = template.content.firstElementChild as SVGSVGElement | null;
  if (!icon) return null;
  icon.classList.add("agent-thread-card__permission-mode-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  if (mode === "danger-full-access") {
    icon.classList.add("agent-thread-card__permission-mode-icon--warning");
  }
  return icon;
}

function modelProviderIcon(iconUrl?: string): HTMLImageElement | undefined {
  if (!iconUrl) return undefined;
  try {
    if (new URL(iconUrl).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const image = document.createElement("img");
  image.className = "agent-thread-card__model-provider-icon";
  image.src = iconUrl;
  image.alt = "";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.onerror = () => image.remove();
  return image;
}

const CLAUDE_MODEL_OPTIONS: AgentModelOption[] = [
  { id: "claude-opus-4-8", label: "claude-opus-4-8" },
  { id: "claude-sonnet-5", label: "claude-sonnet-5" },
  { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
];

export interface ExternalAgentSettingsControllerOptions {
  popover: HTMLDivElement;
  getTypeKey: () => AgentTypeKey;
  /**
   * 返回当前卡片绑定的 instanceId ── 用于把 model/permission/reasoning
   * 控件读写路由到 instance.runtimeConfig 快照,
   * 实现"不同 Agent Thread Card 不共享配置"。如果 undefined (如编辑器临时预览),
   * 则退化为全局 useAgentSessionStore 行为, 不影响现有 fallback 路径。
   */
  getInstanceId: () => string | undefined;
  getLanguage: () => AppLanguage;
  getEmptyStatePresentation: () => AgentEmptyStatePresentation; // 形态变了必须重建空状态, 故参与复用判定
  t: (key: I18nKey, params?: I18nParams) => string;
  isDestroyed: () => boolean;
  isRunning?: () => boolean;
  consumeOutsidePointer?: (event: PointerEvent) => void;
  onPopoverStateChange?: (
    open: boolean,
    anchor: HTMLButtonElement | null,
  ) => void;
  /**
   * 点击常用笔记卡片时的动作 ── 把该笔记作为行内引用注入 composer 输入框
   * (而不是打开笔记)。由宿主 (thread card view / 独立对话) 接到
   * `ComposerController.insertMemoReference`。
   */
  onSelectFeaturedNote?: (ref: { id: string; filename: string; title: string; notebookId?: string; relativePath?: string }) => void;
  /** Expanded empty-state prompt chips seed the shared composer without sending. */
  onSelectEmptyPrompt?: (prompt: string) => void;
  /** Expanded empty-state skill chips use the same token insertion as the slash menu. */
  onSelectEmptySkill?: (skill: ComposerSlashSkill) => void;
  /** Opens the shared slash picker with all commands and skills. */
  onOpenEmptySkills?: () => void;
  /**
   * 仓库列表增删后的轻提示。 由宿主注入而不是直接 import toast, 让本
   * controller 保持对 UI 反馈层的解耦 (测试里也可以只断言调用)。
   */
  toast?: (kind: "success" | "error" | "info", message: string) => void;
}

export class ExternalAgentSettingsController {
  private readonly popover: HTMLDivElement;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly getInstanceId: () => string | undefined;
  private readonly getLanguage: () => AppLanguage;
  private readonly t: (key: I18nKey, params?: I18nParams) => string;
  private readonly isDestroyed: () => boolean;
  private readonly consumeOutsidePointer?: (event: PointerEvent) => void;
  private readonly onPopoverStateChange?: (
    open: boolean,
    anchor: HTMLButtonElement | null,
  ) => void;
  private readonly toast?: (
    kind: "success" | "error" | "info",
    message: string,
  ) => void;

  private modelButton: HTMLButtonElement | null = null;
  private piModelNotice: HTMLButtonElement | null = null;
  private composerModelButton: HTMLButtonElement | null = null;
  private composerModeButton: HTMLButtonElement | null = null;
  private composerPermissionButton: HTMLButtonElement | null = null;
  private composerWorkspaceButton: HTMLButtonElement | null = null;
  private reasoningButton: HTMLButtonElement | null = null;
  private modeButton: HTMLButtonElement | null = null;
  private permissionButton: HTMLButtonElement | null = null;
  private workspaceDisplay: HTMLButtonElement | null = null;
  private anchor: HTMLButtonElement | null = null;
  private kind: AgentRuntimeSettingKind | null = null;
  private open = false;
  private workspacePopoverOpen = false;
  private popoverPlacement: SettingsPopoverPlacement = "anchor";
  /**
   * 「可访问」弹窗的第二页 (仓库列表)。 弹窗只有一块 DOM, 翻页通过替换内容
   * 实现而不是叠一个新弹窗 ── 保持单一定位/外点关闭/焦点语义, 返回时也不
   * 需要重建定位。 关闭弹窗一律重置回第一页, 下次打开从列表页进入。
   */
  private workspacePage: "access" | "repositories" = "access";
  private resizeObserver: ResizeObserver | null = null;
  private positionFrame: number | null = null;
  private codexDefaultModel = "";
  private dshDefaultModel = "";
  private dshDefaultProviderId: string | undefined;
  private piDefaultModel = "";
  private piDefaultProviderId: string | undefined;
  private codexServiceTier: AgentCodexServiceTier = "auto";
  private piModelsLoadFailed = false;
  private localSupportedModelsTypeKey: AgentTypeKey | null = null;
  private localSupportedModels: AgentModelOption[] = [];
  private readonly unlistenCodexSettings: UnlistenFn;
  private readonly unlistenPiCatalog: () => void;
  private readonly emptyState: AgentEmptyStateController;

  readonly boundPosition = (): void => {
    this.schedulePosition();
  };

  constructor(options: ExternalAgentSettingsControllerOptions) {
    this.popover = options.popover;
    this.getTypeKey = options.getTypeKey;
    this.getInstanceId = options.getInstanceId;
    this.getLanguage = options.getLanguage;
    this.t = options.t;
    this.isDestroyed = options.isDestroyed;
    this.consumeOutsidePointer = options.consumeOutsidePointer;
    this.onPopoverStateChange = options.onPopoverStateChange;
    this.emptyState = new AgentEmptyStateController({
      getTypeKey: options.getTypeKey,
      getInstanceId: options.getInstanceId,
      getLanguage: options.getLanguage,
      getPresentation: options.getEmptyStatePresentation,
      getNotebookId: () => this.getCurrentNotebookId(),
      getNotebookPath: () => this.getCurrentNotebookPath(),
      t: options.t,
      isDestroyed: options.isDestroyed,
      onSelectFeaturedNote: options.onSelectFeaturedNote,
      onSelectEmptyPrompt: options.onSelectEmptyPrompt,
      onSelectEmptySkill: options.onSelectEmptySkill,
      onOpenEmptySkills: options.onOpenEmptySkills,
      appendRuntimeSettings: (root, presentation) => this.appendEmptyRuntimeSettings(root, presentation),
      refreshRuntimeSettings: () => this.refreshEmptySettings(),
      clearRuntimeSettings: (root) => this.clearEmptyRuntimeSettings(root),
    });
    this.toast = options.toast;
    this.unlistenCodexSettings = subscribe<Record<string, unknown>>(
      "codex-thread-settings-updated",
      (payload) => { void this.applyCodexSettingsNotification(payload); },
    );
    this.unlistenPiCatalog = useAgentDataStore.subscribe((state, previous) => {
      if (this.getTypeKey() !== "pi") return;
      if (state.piCloudAccountId === previous.piCloudAccountId
        && state.agents.pi.catalog.models === previous.agents.pi.catalog.models) return;
      this.applyModelCatalog("pi", state.agents.pi.catalog.models);
    });
  }

  private async applyCodexSettingsNotification(
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.getTypeKey() !== "codex") return;
    const instanceId = this.getInstanceId();
    const codexThreadId = typeof payload.threadId === "string" ? payload.threadId : "";
    if (!instanceId || !codexThreadId) return;
    const instance = useAgentSessionStore.getState().getInstance(instanceId);
    if (!instance?.threadId) return;
    const mapped = await agent.getCodexSessionId(instance.threadId);
    if (mapped !== codexThreadId) return;
    const settings = (payload.threadSettings ?? payload.settings) as Record<string, unknown> | undefined;
    if (!settings) return;
    const patch: Record<string, unknown> = {};
    if (typeof settings.model === "string") patch.model = { key: settings.model };
    if (typeof settings.reasoningEffort === "string") patch.reasoningEffort = settings.reasoningEffort;
    const sandbox = settings.sandboxPolicy;
    if (sandbox === "read-only" || sandbox === "workspace-write" || sandbox === "danger-full-access") {
      patch.access = { sandbox };
    }
    if (Object.keys(patch).length) {
      useAgentSessionStore.getState().setRuntimeConfig(instanceId, patch as never);
      this.refreshEmptySettings();
    }
  }

  /**
   * 读 model/permission/reasoning 控件的当前值 ── 优先 instance 快照；
   * 模式按钮始终显示当前 Agent 的 user.mode；执行时再解析会话覆盖。
   *  - instanceId 存在 + runtimeConfig 对应字段非空 → 用 instance 值
   *  - 否则 → 当前 Agent 的 user 偏好与内建默认值
   *
   * 注意：fallback 不写回 instance.runtimeConfig ── 仅"显示"，不修改快照。
   * 发消息时若 instance 没显式设置，也会走全局 fallback。
   */
  private readRuntimeSetting<
    K extends "model" | "permission" | "reasoning" | "mode",
  >(
    kind: K,
  ): string | undefined {
    const instanceId = this.getInstanceId();
    const typeKey = this.getTypeKey();
    const runtimeConfig = instanceId
      ? useAgentSessionStore.getState().getInstance(instanceId)?.runtimeConfig
      : undefined;
    const resolved = resolveAgentPreferenceRuntimeConfig(typeKey, runtimeConfig ?? undefined);
    if (kind === "model") return resolved.model?.key;
    if (kind === "permission") return resolved.access?.sandbox ?? "danger-full-access";
    if (kind === "reasoning") return resolved.reasoningEffort ?? "medium";
    return useAgentDataStore.getState().agents[typeKey].user.mode
      ?? (typeKey === "pi" ? "writing" : "standard");
  }

  /**
   * 写 model/permission/reasoning 控件 → 路由到 instance.runtimeConfig。
   * 无 instanceId 时直接更新当前 Agent 的 user 偏好。
   */
  private writeRuntimeSetting(
    kind: "model" | "permission" | "reasoning" | "mode",
    value: string,
    providerId?: string,
  ): void {
    const instanceId = this.getInstanceId();
    const typeKey = this.getTypeKey();
    if (instanceId) {
      const instanceStore = useAgentSessionStore.getState();
      if (kind === "model") {
        const selectedModel = { id: value, ...(providerId?.trim() ? { providerId: providerId.trim() } : {}) };
        const userPreference = useAgentDataStore.getState().agents[typeKey].user;
        const modelReasoning = userPreference.reasoningByModel?.[modelPreferenceKey(selectedModel)]
          ?? (typeKey === "codex" ? this.defaultReasoningForModel(value) : undefined);
        instanceStore.setRuntimeConfig(instanceId, {
          model: { key: value, ...(providerId?.trim() ? { providerId: providerId.trim() } : {}) },
          reasoningEffort: modelReasoning,
        });
        useAgentDataStore.getState().setUserPreference(typeKey, { model: selectedModel });
        this.syncCodexThreadSetting(instanceId, kind, value);
        this.refreshModelDisplays();
        return;
      }
      if (kind === "permission") {
        instanceStore.setRuntimeConfig(instanceId, {
          access: { sandbox: value as AgentPermissionMode },
        });
        useAgentDataStore.getState().setUserPreference(typeKey, { permission: value as AgentPermissionMode });
        return;
      }
      if (kind === "mode") {
        useAgentDataStore.getState().setUserPreference(typeKey, { mode: value });
        if (typeKey === "pi") {
          return;
        }
        instanceStore.setRuntimeConfig(instanceId, {
          deepseekHarness: { mode: value as AgentHarnessPreset },
        });
        return;
      }
      // reasoning effort 与 model / permission 同维度，锁定在 instance 快照上。
      instanceStore.setRuntimeConfig(instanceId, {
        reasoningEffort: value as AgentCodexReasoningEffort,
      });
      const instanceModel = instanceStore.getInstance(instanceId)?.runtimeConfig?.model;
      const preferenceModel = useAgentDataStore.getState().agents[typeKey].user.model;
      useAgentDataStore.getState().rememberModelReasoning(
        typeKey,
        instanceModel?.key
          ? { id: instanceModel.key, providerId: instanceModel.providerId }
          : preferenceModel,
        value as AgentCodexReasoningEffort,
      );
      this.syncCodexThreadSetting(instanceId, kind, value);
      this.refreshModelDisplays();
      return;
    }
    // Without a conversation, update this Agent's global preference directly.
    if (kind === "model") {
      const selectedModel = { id: value, ...(providerId?.trim() ? { providerId: providerId.trim() } : {}) };
      useAgentDataStore.getState().setUserPreference(typeKey, {
        model: selectedModel,
      });
      if (typeKey === "codex") {
        useAgentDataStore.getState().setUserPreference(typeKey, {
          reasoningEffort: useAgentDataStore.getState().agents.codex.user.reasoningByModel?.[modelPreferenceKey(selectedModel)]
            ?? this.defaultReasoningForModel(value),
        });
      }
      this.refreshModelDisplays();
      return;
    }
    if (kind === "permission") {
      useAgentDataStore.getState().setUserPreference(typeKey, { permission: value as AgentPermissionMode });
      return;
    }
    if (kind === "mode") {
      useAgentDataStore.getState().setUserPreference(typeKey, { mode: value });
      if (typeKey === "pi") {
        return;
      }
      return;
    }
    const model = useAgentDataStore.getState().agents[typeKey].user.model;
    useAgentDataStore.getState().rememberModelReasoning(
      typeKey,
      model,
      value as AgentCodexReasoningEffort,
    );
    this.refreshModelDisplays();
  }

  private syncCodexThreadSetting(
    instanceId: string,
    kind: "model" | "permission" | "reasoning" | "mode",
    value: string,
  ): void {
    if (this.getTypeKey() !== "codex") return;
    const instance = useAgentSessionStore.getState().getInstance(instanceId);
    const threadId = instance?.threadId;
    if (!threadId) return;
    void agent.updateCodexThreadSettings({
      threadId,
      ...(kind === "model" ? { model: value } : {}),
      ...(kind === "permission"
        ? { permissionMode: value as AgentPermissionMode }
        : {}),
      ...(kind === "reasoning" ? { reasoningEffort: value } : {}),
    }).catch((error) => {
      console.warn("Failed to update Codex App Server thread settings", error);
    });
  }

  private defaultReasoningForModel(modelId: string): AgentCodexReasoningEffort {
    const model = useAgentDataStore.getState().agents.codex.catalog.models.items
      .find((option) => option.id === modelId);
    return model?.reasoningEfforts?.includes("medium")
      ? "medium"
      : model?.reasoningEfforts?.[0] ?? "medium";
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

  loadDefaultModel(force = false): void {
    const typeKey = this.getTypeKey();
    if (typeKey === "pi") {
      this.loadPiModelCatalog(force);
      return;
    }
    const cached = useAgentDataStore.getState().agents[typeKey].catalog.models;
    if (cached.items.length) this.applyModelCatalog(typeKey, cached);

    void loadAgentModelCatalog(typeKey, { force })
      .then((catalog) => this.applyModelCatalog(typeKey, catalog))
      .catch(() => {
        if (this.isDestroyed() || this.getTypeKey() !== typeKey) return;
        if (!cached.items.length) {
          this.localSupportedModelsTypeKey = typeKey;
          this.localSupportedModels = [];
        }
        this.refreshEmptySettings();
        if (this.open && this.kind === "model") {
          this.renderPopover();
          this.schedulePosition();
        }
      });
  }

  private loadPiModelCatalog(force: boolean): void {
    const cached = useAgentDataStore.getState().agents.pi.catalog.models;
    if (cached.items.length) this.applyModelCatalog("pi", cached);

    void loadPiCloudModelCatalog({ force })
      .then((catalog) => this.applyModelCatalog("pi", catalog))
      .catch(() => {
        if (this.isDestroyed() || this.getTypeKey() !== "pi") return;
        if (!cached.items.length) this.piModelsLoadFailed = true;
        this.refreshEmptySettings();
        if (this.open && this.kind === "model") {
          this.renderPopover();
          this.schedulePosition();
        }
      });
  }

  private applyModelCatalog(typeKey: AgentTypeKey, catalog: AgentModelCatalog): void {
    if (this.isDestroyed() || this.getTypeKey() !== typeKey) return;
    // Pi's session-aware store is authoritative, including an empty directory
    // after logout. A late promise must not revive the controller's old copy.
    if (typeKey === "pi") catalog = useAgentDataStore.getState().agents.pi.catalog.models;
    this.localSupportedModelsTypeKey = typeKey;
    this.localSupportedModels = catalog.items as AgentModelOption[];
    if (typeKey === "codex") this.codexDefaultModel = catalog.defaultModel ?? "";
    if (typeKey === "pi") {
      this.piDefaultModel = catalog.defaultModel ?? "";
      this.piDefaultProviderId = catalog.defaultProviderId;
      this.piModelsLoadFailed = false;
    }
    if (typeKey === "dsh") {
      this.dshDefaultModel = catalog.defaultModel ?? "";
      this.dshDefaultProviderId = catalog.defaultProviderId;
    }
    this.refreshEmptySettings();
    if (this.open && this.kind === "model") {
      this.renderPopover();
      this.schedulePosition();
    }
  }

  createEmptySettings(): HTMLElement {
    return this.emptyState.create();
  }

  private clearEmptyRuntimeSettings(empty: HTMLElement): void {
    if (this.anchor && empty.contains(this.anchor)) this.setSettingsPopoverOpen(false);
    this.workspaceDisplay = null;
    this.modelButton = null;
    this.piModelNotice = null;
    this.reasoningButton = null;
    this.modeButton = null;
    this.permissionButton = null;
  }

  private appendEmptyRuntimeSettings(empty: HTMLElement, presentation: AgentEmptyStatePresentation): void {
    if (this.getTypeKey() === "pi") {
      const modelNotice = document.createElement("button");
      modelNotice.type = "button";
      modelNotice.className =
        "agent-thread-card__dsh-update-notice agent-thread-card__pi-model-notice";
      modelNotice.setAttribute("aria-label", this.t("agent.model.configure"));
      modelNotice.hidden = true;
      const modelNoticeLabel = document.createElement("span");
      modelNoticeLabel.className = "agent-thread-card__dsh-update-label";
      const modelNoticeChevron = createChevronIcon("right");
      modelNoticeChevron.setAttribute("aria-hidden", "true");
      modelNotice.append(modelNoticeLabel, modelNoticeChevron);
      modelNotice.addEventListener("click", (event) => {
        event.stopPropagation();
        void windows.openPreferences("pi");
      });
      empty.append(modelNotice);
      this.piModelNotice = modelNotice;

      const unavailableNotice = document.createElement("div");
      unavailableNotice.className =
        "agent-thread-card__dsh-update-notice agent-thread-card__pi-unavailable-notice";
      unavailableNotice.setAttribute("role", "status");
      unavailableNotice.hidden = true;
      const unavailableLabel = document.createElement("span");
      unavailableLabel.className = "agent-thread-card__dsh-update-label";
      unavailableLabel.textContent = this.t("agent.pi.unavailable");
      unavailableNotice.append(unavailableLabel);
      empty.append(unavailableNotice);

      void useAgentRuntimeStore.getState().refreshIfStale().then(() => {
        if (this.isDestroyed() || !empty.isConnected) return;
        const status = useAgentRuntimeStore.getState().statusByType.pi;
        if (!status) return;
        const runtimeStatus = normalizeAgentRuntimeStatus(status);
        unavailableNotice.hidden = runtimeStatus.state === "ready";
        if (runtimeStatus.state !== "ready" && runtimeStatus.reason) {
          unavailableNotice.title = runtimeStatus.reason;
        }
      });
    }
    if (presentation === "inline-card") {
      const controls = document.createElement("div");
      controls.className = "agent-conversation__controls";
      empty.append(controls);

      this.workspaceDisplay = createExternalAgentWorkspaceDisplay(
        this.t("agent.workspace.title"),
        this.getCurrentWorkspaceLabel(),
        (anchor) => this.toggleWorkspacePopover(anchor),
      );
      controls.append(this.workspaceDisplay);

      this.modelButton = this.supportsRuntimeSetting("model")
        ? this.createEmptyControl(
            "model",
            this.t("agent.model.title"),
            this.getComposerModelDisplay().text,
          )
        : null;
      this.reasoningButton = null;
      this.modeButton = this.supportsRuntimeSetting("mode")
        ? this.createEmptyControl(
            "mode",
            this.t("agent.mode.title"),
            this.getCurrentModeLabel(),
          )
        : null;
      this.permissionButton = this.supportsRuntimeSetting("permission")
        ? this.createEmptyControl(
            "permission",
            this.t("agent.permission.title"),
            this.getCurrentPermissionLabel(),
          )
        : null;
      // 空状态设置区固定采用「空间 → 模型 → 模式/权限」顺序。
      // OpenCode 当前没有 mode，因此模型控件会自然落在空间与权限之间。
      for (const button of [
        this.modelButton,
        this.reasoningButton,
        this.modeButton,
        this.permissionButton,
      ]) {
        if (button) controls.append(button);
      }
    }
  }

  private getCurrentNotebookPath(): string | null {
    const notebookId = this.getCurrentNotebookId();
    const notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId)
      ?? useNoteStore.getState().selectedNotebook;
    const path = notebook?.path?.trim() || this.getCurrentWorkspacePath();
    return path || null;
  }

  private getCurrentNotebookId(): string | null {
    const instanceId = this.getInstanceId();
    const instance = instanceId
      ? useAgentSessionStore.getState().getInstance(instanceId)
      : undefined;
    return instance?.runtimeConfig?.notebookId
      ?? instance?.runtimeConfig?.workspaceSnapshot?.notebookId
      ?? instance?.source.notebookId
      ?? useNoteStore.getState().selectedNotebook?.id
      ?? null;
  }

  /** Compact model switch trigger used by the expanded composer footer. */
  createComposerModelButton(): HTMLButtonElement | null {
    if (!this.supportsRuntimeSetting("model")) return null;
    const button = createExternalAgentWorkspaceControl(
      this.t("agent.model.title"),
      this.getComposerModelDisplay().text,
      (anchor) => this.toggleSettingsPopover("model", anchor),
    );
    if (this.getTypeKey() === "pi") button.setAttribute("aria-haspopup", "dialog");
    button.classList.replace(
      "agent-composer__workspace",
      "agent-composer__model",
    );
    const value = button.querySelector<HTMLElement>(
      ".agent-composer__workspace-value",
    );
    value?.classList.replace(
      "agent-composer__workspace-value",
      "agent-composer__model-value",
    );
    this.composerModelButton = button;
    this.refreshComposerModelButton();
    return button;
  }

  /** Open the same model picker used by the composer model button. */
  openComposerModelPicker(): void {
    if (!this.composerModelButton || !this.supportsRuntimeSetting("model")) return;
    this.setSettingsPopoverOpen(true, "model", this.composerModelButton);
  }

  /** Open the same permission picker used by the composer permission button. */
  openComposerPermissionPicker(): void {
    if (!this.composerPermissionButton || !this.supportsRuntimeSetting("permission")) return;
    this.setSettingsPopoverOpen(true, "permission", this.composerPermissionButton);
  }

  createComposerWorkspaceButton(): HTMLButtonElement | null {
    const button = createExternalAgentWorkspaceControl(
      this.t("agent.workspace.title"),
      "",
      (anchor) => this.toggleWorkspacePopover(anchor),
    );
    button.querySelector(".agent-composer__workspace-value")?.remove();
    this.composerWorkspaceButton = button;
    this.refreshComposerWorkspaceButton();
    return button;
  }

  /** Compact runtime mode switcher placed beside the model control. */
  createComposerModeButton(): HTMLButtonElement | null {
    if (!this.supportsRuntimeSetting("mode")) return null;
    const label = this.t("agent.mode.title");
    const button = createExternalAgentWorkspaceControl(
      label,
      this.getCurrentModeLabel(),
      (anchor) => this.toggleSettingsPopover("mode", anchor),
    );
    button.classList.replace(
      "agent-composer__workspace",
      "agent-composer__mode",
    );
    const value = button.querySelector<HTMLElement>(
      ".agent-composer__workspace-value",
    );
    value?.classList.replace(
      "agent-composer__workspace-value",
      "agent-composer__mode-value",
    );
    this.composerModeButton = button;
    this.refreshComposerModeButton();
    return button;
  }

  /** Compact permission switcher placed beside the workspace control. */
  createComposerPermissionButton(): HTMLButtonElement | null {
    if (!this.supportsRuntimeSetting("permission")) return null;
    const label = this.t("agent.permission.title");
    const button = createExternalAgentWorkspaceControl(
      label,
      "",
      (anchor) => this.toggleSettingsPopover("permission", anchor),
    );
    button.classList.replace(
      "agent-composer__workspace",
      "agent-composer__permission",
    );
    const value = button.querySelector<HTMLElement>(
      ".agent-composer__workspace-value",
    );
    value?.remove();
    this.composerPermissionButton = button;
    this.refreshComposerPermissionButton();
    return button;
  }

  refreshComposerModelButton(): void {
    if (!this.composerModelButton) return;
    const display = this.getComposerModelDisplay();
    const label = display.text;
    const valueEl = this.composerModelButton.querySelector<HTMLElement>(
      ".agent-composer__model-value",
    );
    if (valueEl && display.effort) {
      const model = document.createElement("span");
      model.className = "agent-composer__model-name";
      model.textContent = display.model;
      const effort = document.createElement("span");
      effort.className = "agent-composer__model-effort";
      effort.textContent = display.effort;
      valueEl.replaceChildren(model, effort);
    } else if (valueEl) {
      valueEl.textContent = label;
    }
    this.composerModelButton.title = `${this.t("agent.model.title")}: ${label}`;
    this.composerModelButton.setAttribute(
      "aria-label",
      `${this.t("agent.model.title")}: ${label}`,
    );
  }

  private refreshComposerModeButton(): void {
    if (!this.composerModeButton) return;
    const value = this.getCurrentModeLabel();
    const valueEl = this.composerModeButton.querySelector<HTMLElement>(
      ".agent-composer__mode-value",
    );
    if (valueEl) valueEl.textContent = value;
    const label = this.t("agent.mode.title");
    this.composerModeButton.title = `${label}: ${value}`;
    this.composerModeButton.setAttribute("aria-label", `${label}: ${value}`);
    // A running turn owns the preset used to mount its agent. Changing this
    // control only updates the conversation config; the next submission will
    // detect the changed preset and restart the runtime before resuming the
    // same session. Keep the control enabled so users can prepare that next
    // turn while the current one is still running.
    this.composerModeButton.disabled = false;
    this.composerModeButton.setAttribute("aria-disabled", "false");
  }

  private refreshComposerWorkspaceButton(): void {
    if (!this.composerWorkspaceButton) return;
    const currentIcon = this.composerWorkspaceButton.querySelector(
      ".agent-composer__workspace-icon",
    );
    const nextIcon = createComposerWorkspaceIcon();
    const chevron = this.composerWorkspaceButton.querySelector(
      ".agent-conversation__control-chevron",
    );
    currentIcon?.remove();
    if (nextIcon && chevron) {
      this.composerWorkspaceButton.insertBefore(nextIcon, chevron);
    }
    const value = this.getCurrentWorkspaceLabel();
    this.composerWorkspaceButton.title = `${this.t("agent.workspace.title")}: ${value}`;
    this.composerWorkspaceButton.setAttribute(
      "aria-label",
      `${this.t("agent.workspace.title")}: ${value}`,
    );
    // The workspace is frozen by the conversation runtime after the first run,
    // but the trigger stays interactive so the read-only popover remains
    // available for inspection. The popover intentionally exposes no workspace
    // selection action.
    this.composerWorkspaceButton.disabled = false;
    this.composerWorkspaceButton.setAttribute("aria-disabled", "false");
  }

  private refreshComposerPermissionButton(): void {
    if (!this.composerPermissionButton) return;
    const mode = this.getCurrentPermissionMode();
    const currentIcon = this.composerPermissionButton.querySelector(
      ".agent-thread-card__permission-mode-icon",
    );
    const nextIcon = createPermissionModeIcon(mode);
    const chevron = this.composerPermissionButton.querySelector(
      ".agent-conversation__control-chevron",
    );
    currentIcon?.remove();
    if (nextIcon && chevron) {
      this.composerPermissionButton.insertBefore(nextIcon, chevron);
    }
    const value = this.getCurrentPermissionLabel();
    const label = this.t("agent.permission.title");
    this.composerPermissionButton.title = `${label}: ${value}`;
    this.composerPermissionButton.setAttribute("aria-label", `${label}: ${value}`);
  }

  refreshEmptySettings(): void {
    if (this.piModelNotice) {
      const showNotice = this.shouldShowPiModelEmptyState();
      this.piModelNotice.hidden = !showNotice;
      if (this.modelButton) this.modelButton.hidden = showNotice;
      const messageKey = this.piModelsLoadFailed
        ? "agent.model.loadFailed"
        : "agent.model.configure";
      const label = this.t(messageKey);
      const labelElement = this.piModelNotice.querySelector<HTMLElement>(
        ".agent-thread-card__dsh-update-label",
      );
      if (labelElement) labelElement.textContent = label;
      this.piModelNotice.setAttribute("aria-label", label);
    }
    this.refreshModelDisplays();
    this.refreshComposerModeButton();
    this.refreshComposerPermissionButton();
    this.refreshComposerWorkspaceButton();
    if (this.workspaceDisplay) {
      const value = this.workspaceDisplay.querySelector<HTMLElement>(
        ".agent-conversation__workspace-value",
      );
      const nextValue = this.getCurrentWorkspaceLabel();
      if (value) value.textContent = nextValue;
      this.workspaceDisplay.title = `${this.t("agent.workspace.title")}: ${nextValue}`;
      this.workspaceDisplay.setAttribute(
        "aria-label",
        `${this.t("agent.workspace.title")}: ${nextValue}`,
      );
    }
    if (this.permissionButton) {
      updateExternalAgentEmptyControl(
        this.permissionButton,
        this.getCurrentPermissionLabel(),
      );
    }
    if (this.modeButton) {
      updateExternalAgentEmptyControl(
        this.modeButton,
        this.getCurrentModeLabel(),
      );
    }
    if (this.reasoningButton) {
      updateExternalAgentEmptyControl(
        this.reasoningButton,
        this.getCurrentCodexReasoningLabel(),
      );
    }
  }

  private refreshModelDisplays(): void {
    this.refreshComposerModelButton();
    if (this.modelButton) {
      updateExternalAgentEmptyControl(
        this.modelButton,
        this.getComposerModelDisplay().text,
      );
    }
  }

  private getCurrentWorkspaceLabel(): string {
    const path = this.getCurrentWorkspacePath();
    if (!path) return this.t("agent.workspace.unset");

    const normalize = (value: string): string => value.replace(/[\\/]+$/, "").toLowerCase();
    const workspaceState = useAgentWorkspaceStore.getState().workspace;
    const entry = workspaceState.resources.find(
      (item) => normalize(item.path) === normalize(path),
    );
    const instance = this.getInstanceId()
      ? useAgentSessionStore.getState().getInstance(this.getInstanceId()!)
      : undefined;
    const configuredNotebookId = instance?.runtimeConfig?.notebookId;
    const notebook =
      (configuredNotebookId
        ? useNoteStore.getState().notebooks.find((item) => item.id === configuredNotebookId)
        : null) ?? useNoteStore.getState().selectedNotebook;
    if (entry?.name?.trim()) return entry.name.trim();
    const notebookEntry = configuredNotebookId
      ? workspaceState.byNotebookId[configuredNotebookId]?.notebook
      : undefined;
    if (notebookEntry && normalize(notebookEntry.path) === normalize(path) && notebookEntry.name.trim()) {
      return notebookEntry.name.trim();
    }
    if (notebook && normalize(notebook.path) === normalize(path) && notebook.name?.trim()) {
      return notebook.name.trim();
    }
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  private getCurrentWorkspacePath(): string {
    const instance = this.getInstanceId()
      ? useAgentSessionStore.getState().getInstance(this.getInstanceId()!)
      : undefined;
    const runtimeConfig = instance?.runtimeConfig ?? undefined;
    const snapshot = runtimeConfig?.workspaceSnapshot;
    const snapshotPath =
      snapshot && typeof snapshot === "object" && typeof snapshot.cwd === "string"
        ? snapshot.cwd.trim()
        : "";
    const configuredNotebookId = runtimeConfig?.notebookId;
    const memoState = useNoteStore.getState();
    const notebook =
      (configuredNotebookId
        ? memoState.notebooks.find((item) => item.id === configuredNotebookId)
        : null) ?? memoState.selectedNotebook;
    const notebookPath = notebook?.path?.trim();
    const primary = resolvePrimaryWorkspace({ notebookPath });
    const path = snapshotPath || (primary.kind === "empty" ? "" : primary.path);
    return path;
  }

  private getWorkspaceDirectoryChoices(): {
    cwd: { path: string; label: string; isNotebook: boolean } | null;
    addDirs: Array<{ path: string; label: string; isNotebook: boolean }>;
  } {
    const instance = this.getInstanceId()
      ? useAgentSessionStore.getState().getInstance(this.getInstanceId()!)
      : undefined;
    const runtimeConfig = instance?.runtimeConfig ?? undefined;
    const state = normalizeConversationWorkspaceState(runtimeConfig);
    const snapshot = state?.desired ?? runtimeConfig?.workspaceSnapshot;
    const cwdPath = normalizeWorkspacePath(snapshot?.cwd ?? this.getCurrentWorkspacePath());
    const configuredNotebookId = runtimeConfig?.notebookId ?? snapshot?.notebookId;
    const memoState = useNoteStore.getState();
    const notebook =
      (configuredNotebookId
        ? memoState.notebooks.find((item) => item.id === configuredNotebookId)
        : null) ?? memoState.selectedNotebook;
    const workspace = useAgentWorkspaceStore.getState().workspace.byNotebookId[configuredNotebookId ?? notebook?.id ?? ""];
    const workspaceState = useAgentWorkspaceStore.getState().workspace;
    const addDirPaths = snapshot
      ? snapshot.workspacePaths
      : (workspace?.addDirs.filter((directory) => directory.enabled && !directory.missing).map((directory) => directory.path) ?? []);
    const notebookAddDirs = workspace?.addDirs ?? [];
    const notebookPath = normalizeWorkspacePath(notebook?.path ?? "").toLowerCase();
    const labelForPath = (path: string): string => {
      const key = normalizeWorkspacePath(path).toLowerCase();
      const local = notebookAddDirs.find(
        (item) => normalizeWorkspacePath(item.path).toLowerCase() === key,
      );
      const entry = workspaceState.resources.find(
        (item) => normalizeWorkspacePath(item.path).toLowerCase() === key,
      );
      if (local?.label?.trim()) return local.label.trim();
      if (entry?.name?.trim()) return entry.name.trim();
      if (notebook && normalizeWorkspacePath(notebook.path).toLowerCase() === key) {
        return notebook.name?.trim() || path;
      }
      return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    };
    const seen = new Set<string>();
    if (cwdPath) seen.add(cwdPath.toLowerCase());
    const addDirs = addDirPaths.flatMap((value) => {
      const path = normalizeWorkspacePath(value);
      const key = path.toLowerCase();
      if (!path || seen.has(key)) return [];
      seen.add(key);
      return [{
        path,
        label: labelForPath(path),
        isNotebook: Boolean(notebookPath && path.toLowerCase() === notebookPath),
      }];
    });
    return {
      cwd: cwdPath
        ? {
            path: cwdPath,
            label: labelForPath(cwdPath),
            isNotebook: Boolean(notebookPath && cwdPath.toLowerCase() === notebookPath),
          }
        : null,
      addDirs,
    };
  }

  toggleSettingsPopover(
    kind: AgentRuntimeSettingKind,
    anchor: HTMLButtonElement,
  ): void {
    const sameMenuOpen =
      this.open && this.kind === kind && this.anchor === anchor;
    this.setSettingsPopoverOpen(!sameMenuOpen, kind, anchor);
  }

  /** Open a runtime settings picker as a right-side submenu from the add menu. */
  openComposerSettingsPopover(
    kind: AgentRuntimeSettingKind,
    anchor: HTMLButtonElement,
  ): void {
    if (!this.supportsRuntimeSetting(kind)) return;
    this.setSettingsPopoverOpen(true, kind, anchor, "submenu");
  }

  closeComposerSettingsPopover(anchor?: HTMLButtonElement): void {
    if (this.popoverPlacement !== "submenu") return;
    if (anchor && this.anchor !== anchor) return;
    this.setSettingsPopoverOpen(false);
  }

  private toggleWorkspacePopover(anchor: HTMLButtonElement): void {
    const sameMenuOpen = this.workspacePopoverOpen && this.anchor === anchor;
    if (sameMenuOpen) {
      this.setSettingsPopoverOpen(false);
      return;
    }
    this.openWorkspacePopover(anchor, "anchor");
  }

  /** Open the read-only access page as a right-side submenu from the add menu. */
  openComposerWorkspacePopover(anchor: HTMLButtonElement): void {
    if (this.workspacePopoverOpen && this.anchor === anchor) return;
    this.openWorkspacePopover(anchor, "submenu");
  }

  private openWorkspacePopover(
    anchor: HTMLButtonElement,
    placement: SettingsPopoverPlacement,
  ): void {
    this.popoverPlacement = placement;
    this.workspacePage = "access";
    this.workspacePopoverOpen = true;
    this.open = true;
    this.kind = null;
    this.anchor = anchor;
    this.popover.hidden = false;
    this.popover.classList.remove("agent-thread-card__codex-settings-popover--mode");
    this.popover.classList.remove("agent-thread-card__codex-settings-popover--pi-mode");
    this.syncControlOpenState(true, null);
    this.renderWorkspacePopover();
    this.schedulePosition();
    this.startPositionTracking();
    document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    this.onPopoverStateChange?.(true, anchor);
  }

  setSettingsPopoverOpen(
    open: boolean,
    kind: AgentRuntimeSettingKind | null = null,
    anchor: HTMLButtonElement | null = null,
    placement: SettingsPopoverPlacement = "anchor",
  ): void {
    const nextPlacement = open ? placement : "anchor";
    if (
      this.open === open
      && (!open || (
        this.kind === kind
        && this.anchor === anchor
        && this.popoverPlacement === nextPlacement
      ))
      && !this.workspacePopoverOpen
    ) return;
    const previousAnchor = this.anchor;
    this.popoverPlacement = nextPlacement;
    this.workspacePopoverOpen = false;
    this.workspacePage = "access";
    this.open = open;
    this.kind = open ? kind : null;
    this.anchor = open ? anchor : null;
    this.onPopoverStateChange?.(open, open ? anchor : previousAnchor);
    this.popover.hidden = !open;
    this.popover.classList.toggle(
      "agent-thread-card__codex-settings-popover--mode",
      open && kind === "mode",
    );
    this.popover.classList.toggle(
      "agent-thread-card__codex-settings-popover--pi-mode",
      open && kind === "mode" && this.getTypeKey() === "pi",
    );
    this.syncControlOpenState(open, kind);

    // Recheck the shared catalog when a model picker opens. Fresh cached data
    // renders immediately; expired or invalidated data refreshes in the background.
    if (open && kind === "model") {
      this.loadDefaultModel();
    }

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
      // Selection handlers write then close; refresh the trigger buttons here
      // so the model / mode / permission value reflects the new choice even
      // before any store subscription propagates the change.
      this.refreshEmptySettings();
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
    if (this.workspacePopoverOpen) {
      this.renderWorkspacePopover();
      return;
    }
    const kind = this.kind;
    this.popover.replaceChildren();
    this.popover.classList.toggle(
      "agent-thread-card__codex-settings-popover--model-picker",
      this.getTypeKey() === "codex" && kind === "model",
    );
    const isPiModelPicker = this.getTypeKey() === "pi" && kind === "model";
    this.popover.classList.toggle(
      "agent-thread-card__codex-settings-popover--pi-model-picker",
      isPiModelPicker,
    );
    this.popover.setAttribute("role", isPiModelPicker ? "dialog" : "menu");
    if (isPiModelPicker) {
      this.popover.setAttribute("aria-label", this.t("agent.model.title"));
    } else {
      this.popover.removeAttribute("aria-label");
    }
    if (!kind || !this.supportsRuntimeSetting(kind)) return;

    if (kind !== "model") {
      const title = document.createElement("div");
      title.className = "agent-thread-card__codex-settings-title";
      title.textContent = this.t(
        kind === "reasoning"
          ? "agent.reasoning.title"
          : kind === "mode"
            ? "agent.mode.title"
            : "agent.permission.title",
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
    if (kind === "mode") {
      this.renderModeSettings();
      return;
    }
    this.renderPermissionSettings();
  }

  private renderWorkspacePopover(): void {
    this.popover.classList.remove(
      "agent-thread-card__codex-settings-popover--model-picker",
    );
    this.popover.classList.remove(
      "agent-thread-card__codex-settings-popover--pi-model-picker",
    );
    this.popover.setAttribute("role", "menu");
    this.popover.removeAttribute("aria-label");
    this.popover.replaceChildren();
    if (this.workspacePage === "repositories") {
      this.renderRepositoryPage();
      return;
    }
    this.renderAccessPage();
  }

  /**
   * 第一页 ── 「可访问」只读快照, 视觉与行为保持原样 (cwd 行 + addDirs 行 +
   * 末尾的管理入口)。 唯一的交互变化是末尾那行由"跳转文件浏览器"改为"在弹窗
   * 内翻页到仓库列表", 行样式仍走既有的 `.codex-settings-settings` 契约。
   */
  private renderAccessPage(): void {
    const choices = this.getWorkspaceDirectoryChoices();
    const accessTitle = document.createElement("div");
    accessTitle.className = "agent-thread-card__codex-settings-title";
    accessTitle.textContent = this.t("agent.workspace.access");
    this.popover.append(accessTitle);

    // 只读快照: 目录行沿用原有契约 ── cwd 行带 selectedLabel + 勾选, addDirs
    // 行是普通只读项。样式完全走既有的 `.codex-settings-item`, 不做额外定制。
    const readOnlyOptions = { readOnly: true };
    if (choices.cwd) {
      this.popover.append(
        createCodexSettingsItem(
          choices.cwd.label,
          true,
          () => {},
          undefined,
          {
            ...readOnlyOptions,
            selectedLabel: "cwd",
            notebookLabel: choices.cwd.isNotebook,
          },
        ),
      );
    }
    if (choices.addDirs.length > 0) {
      choices.addDirs.forEach((choice) => {
        this.popover.append(
          createCodexSettingsItem(
            choice.label,
            false,
            () => {},
            undefined,
            {
              ...readOnlyOptions,
              notebookLabel: choice.isNotebook,
            },
          ),
        );
      });
    }

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className =
      "agent-thread-card__codex-settings-item agent-thread-card__codex-settings-settings";
    settingsButton.setAttribute("role", "menuitem");
    settingsButton.setAttribute("aria-label", this.t("agent.workspace.manageRepositories"));
    const settingsLabel = document.createElement("span");
    settingsLabel.className = "agent-thread-card__codex-settings-item-label";
    settingsLabel.textContent = this.t("agent.workspace.manageRepositories");
    const chevron = createChevronIcon("right");
    chevron.setAttribute("class", "agent-thread-card__codex-settings-settings-chevron");
    settingsButton.append(settingsLabel, chevron);
    settingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      // 翻到第二页而不是跳走; 弹窗保持打开, 外点关闭 / 定位都不需要重算。
      this.workspacePage = "repositories";
      this.renderWorkspacePopover();
      this.schedulePosition();
    });
    settingsButton.addEventListener("mousedown", (event) => event.stopPropagation());
    this.popover.append(settingsButton);
  }

  /**
   * 第二页 ── 仓库列表, 可增删。 这里编辑的是当前笔记本 `local.db`
   * 的 add-dirs (与笔记侧「资料文件夹」同一份数据), 所以增删后第一页的快照会
   * 在下次会话启动时同步反映出来。
   */
  private renderRepositoryPage(): void {
    // 页头复用第一页的标题排版 (同一个 `.codex-settings-title` 契约), 只是把
    // 纯文本标题换成「返回箭头 + 标题」, 让翻页可逆且视觉同级。
    const header = document.createElement("div");
    header.className = "agent-thread-card__codex-settings-title";
    header.classList.add("agent-thread-card__codex-settings-header");

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "agent-thread-card__codex-settings-back";
    backButton.setAttribute("aria-label", this.t("agent.workspace.backToAccess"));
    const title = document.createElement("span");
    title.className = "agent-thread-card__codex-settings-header-title";
    title.textContent = this.t("agent.workspace.repositories");
    backButton.append(createChevronIcon("left"), title);
    backButton.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      this.workspacePage = "access";
      this.renderWorkspacePopover();
      this.schedulePosition();
      backButton.blur();
    });
    backButton.addEventListener("mousedown", (event) => event.stopPropagation());

    header.append(backButton);
    this.popover.append(header);

    const repositories = this.getRepositories();
    if (repositories.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agent-thread-card__codex-settings-title";
      empty.classList.add("agent-thread-card__codex-settings-empty");
      empty.textContent = this.t("agent.workspace.repositoriesEmpty");
      this.popover.append(empty);
    } else {
      repositories.forEach((repository) => {
        this.popover.append(this.createRepositoryItem(repository));
      });
    }

    // 「添加仓库」用第一页「管理仓库」同款的 settings 行契约, 加号放在文字左侧。
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.disabled = !this.getRepositoryScopeNotebookId();
    addButton.className =
      "agent-thread-card__codex-settings-item agent-thread-card__codex-settings-settings";
    addButton.setAttribute("role", "menuitem");
    addButton.setAttribute("aria-label", this.t("agent.workspace.addRepository"));
    const addLabel = document.createElement("span");
    addLabel.className = "agent-thread-card__codex-settings-item-label";
    addLabel.textContent = this.t("agent.workspace.addRepository");
    const addIcon = createPlusIcon();
    addIcon.setAttribute("class", "agent-thread-card__codex-settings-settings-chevron");
    addButton.append(addIcon, addLabel);
    addButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.addRepository();
    });
    addButton.addEventListener("mousedown", (event) => event.stopPropagation());
    this.popover.append(addButton);
  }

  /** 仓库列表的数据源: 当前笔记本的 add-dirs, 叠加全局 entries 的元数据。 */
  private getRepositories(): Array<{ path: string; name: string; missing: boolean }> {
    const instance = this.getInstanceId()
      ? useAgentSessionStore.getState().getInstance(this.getInstanceId()!)
      : undefined;
    const runtimeConfig = instance?.runtimeConfig ?? undefined;
    const memoState = useNoteStore.getState();
    const configuredNotebookId = runtimeConfig?.notebookId;
    const notebook =
      (configuredNotebookId
        ? memoState.notebooks.find((item) => item.id === configuredNotebookId)
        : null) ?? memoState.selectedNotebook;
    const notebookId = configuredNotebookId ?? notebook?.id;
    return getWorkspaceAgentRepositories(notebookId ?? null);
  }

  /**
   * 仓库行 ── 与第一页目录行共用 `.codex-settings-item` 的排版契约 (高度 /
   * 内边距 / 圆角 / hover 底色), 但**不是 button**。
   *
   * 两个原因:
   * 1. 行本身没有动作, 唯一的动作是行内删除按钮。若行是 `<button>`, 内层再放
   *    一个 `<button>` 属于非法嵌套 —— HTML 解析器会把内层按钮"弹出"到外层
   *    之后 (经 `innerHTML` 往返即复现), 删除入口会脱离行布局。
   * 2. `disabled` / `readOnly` 行会把行内按钮一起移出可交互树, 删除就点不动。
   *
   * 所以这里用 `div` 承载排版, 行内只有"名称 + 删除按钮"两个兄弟节点。
   */
  private createRepositoryItem(repository: {
    path: string;
    name: string;
    missing: boolean;
  }): HTMLElement {
    const item = document.createElement("div");
    // 只挂自己的类 ── 不再叠加 `.codex-settings-item`, 避免两条同为 0-2-0 的
    // 规则靠源码顺序争夺 hover 底色 (见 markdown.css 里仓库行的说明)。
    item.className = "agent-thread-card__codex-settings-repository";
    item.setAttribute("role", "menuitem");
    item.title = repository.path;

    const content = document.createElement("span");
    content.className = "agent-thread-card__codex-settings-item-content";
    const label = document.createElement("span");
    label.className = "agent-thread-card__codex-settings-item-label";
    label.textContent = repository.name;
    content.append(label);
    if (repository.missing) {
      const description = document.createElement("span");
      description.className = "agent-thread-card__codex-settings-item-description";
      description.textContent = this.t("agent.access.pathMissing");
      content.append(description);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "agent-thread-card__codex-settings-repository-remove";
    remove.setAttribute(
      "aria-label",
      this.t("agent.workspace.removeRepository", { name: repository.name }),
    );
    remove.append(createTrashIcon());
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.removeRepository(repository.path, repository.name);
    });
    remove.addEventListener("mousedown", (event) => event.stopPropagation());

    item.append(content, remove);
    return item;
  }

  private async addRepository(): Promise<void> {
    const notebookId = this.getRepositoryScopeNotebookId();
    if (!notebookId) return;
    const result = await useAgentWorkspaceStore.getState().workspaceActions.addFolderFromPicker(notebookId);
    if (!result.ok) {
      if (result.code === "already-tracked") {
        this.toast?.("error", this.t("agent.access.alreadyTracked"));
      } else if (result.code === "save-failed") {
        this.toast?.("error", this.t("agent.access.saveFailed"));
      }
      return;
    }
    const latestFiles = useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles(notebookId);
    this.updateCurrentConversationWorkspaceFolders([
      ...(latestFiles?.folders ?? []),
    ]);
    this.rerenderRepositories();
  }

  private async removeRepository(path: string, name: string): Promise<void> {
    const notebookId = this.getRepositoryScopeNotebookId();
    if (!notebookId) return;
    const state = useAgentWorkspaceStore.getState().workspaceActions;
    const saved = await state.detachFolderFromNotebook(notebookId, path);
    if (saved === false) {
      this.toast?.("error", this.t("agent.access.saveFailed"));
      return;
    }
    if (saved === "not-attached") {
      this.rerenderRepositories();
      return;
    }
    const files = useAgentWorkspaceStore.getState().workspaceActions.getNotebookFiles(notebookId);
    const nextFolders = files?.folders ?? [];
    this.updateCurrentConversationWorkspaceFolders(nextFolders);
    this.toast?.("success", this.t("agent.access.folderDeleted", { name }));
    this.rerenderRepositories();
  }

  private updateCurrentConversationWorkspaceFolders(folders: string[]): void {
    const instanceId = this.getInstanceId();
    if (!instanceId) return;
    const session = useAgentSessionStore.getState();
    if (!session.getInstance(instanceId)) return;
    const runtimeConfig = ensureConversationWorkspaceSnapshot(instanceId);
    const current = normalizeConversationWorkspaceState(runtimeConfig);
    if (!current) return;
    const desired = {
      ...current.desired,
      workspacePaths: Array.from(new Set(folders.map(normalizeWorkspacePath).filter(Boolean))),
      capturedAt: Date.now(),
    };
    session.setRuntimeConfig(instanceId, {
      workspaceState: selectDesiredWorkspace(current, desired),
      workspaceSnapshot: desired,
    });
  }

  /** 增删后重绘当前页 ── 行数与高度都会变, 所以定位也要跟着重算。 */
  private rerenderRepositories(): void {
    if (!this.open || this.popover.hidden) return;
    this.renderWorkspacePopover();
    this.schedulePosition();
  }

  private getRepositoryScopeNotebookId(): string | undefined {
    const instance = this.getInstanceId()
      ? useAgentSessionStore.getState().getInstance(this.getInstanceId()!)
      : undefined;
    const runtimeConfig = instance?.runtimeConfig ?? undefined;
    const state = normalizeConversationWorkspaceState(runtimeConfig);
    const snapshot = state?.desired ?? runtimeConfig?.workspaceSnapshot;
    const configuredNotebookId = runtimeConfig?.notebookId ?? snapshot?.notebookId;
    if (configuredNotebookId) return configuredNotebookId;
    return useNoteStore.getState().selectedNotebook?.id ?? undefined;
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
    this.emptyState.dispose();
    this.unlistenCodexSettings();
    this.unlistenPiCatalog();
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
    const button = createExternalAgentEmptyControl(kind, label, value, (nextKind, button) => {
      this.toggleSettingsPopover(nextKind, button);
    });
    if (kind === "model" && this.getTypeKey() === "pi") {
      button.setAttribute("aria-haspopup", "dialog");
    }
    return button;
  }

  private syncControlOpenState(
    open: boolean,
    kind: AgentRuntimeSettingKind | null,
  ): void {
    const modelExpanded = open && kind === "model";
    this.modelButton?.setAttribute(
      "aria-expanded",
      modelExpanded ? "true" : "false",
    );
    this.permissionButton?.setAttribute(
      "aria-expanded",
      open && kind === "permission" ? "true" : "false",
    );
    this.modeButton?.setAttribute(
      "aria-expanded",
      open && kind === "mode" ? "true" : "false",
    );
    this.reasoningButton?.setAttribute(
      "aria-expanded",
      open && kind === "reasoning" ? "true" : "false",
    );
    this.modelButton?.classList.toggle(
      "agent-conversation__control--open",
      modelExpanded,
    );
    this.composerModelButton?.setAttribute(
      "aria-expanded",
      modelExpanded ? "true" : "false",
    );
    this.composerModelButton?.classList.toggle(
      "agent-composer__model--open",
      modelExpanded,
    );
    this.composerPermissionButton?.setAttribute(
      "aria-expanded",
      open && kind === "permission" ? "true" : "false",
    );
    this.composerPermissionButton?.classList.toggle(
      "agent-composer__permission--open",
      open && kind === "permission",
    );
    this.composerWorkspaceButton?.setAttribute(
      "aria-expanded",
      this.workspacePopoverOpen && open ? "true" : "false",
    );
    this.composerWorkspaceButton?.classList.toggle(
      "agent-composer__workspace--open",
      this.workspacePopoverOpen && open,
    );
    this.workspaceDisplay?.setAttribute(
      "aria-expanded",
      this.workspacePopoverOpen && open ? "true" : "false",
    );
    this.workspaceDisplay?.classList.toggle(
      "agent-conversation__workspace--open",
      this.workspacePopoverOpen && open,
    );
    this.permissionButton?.classList.toggle(
      "agent-conversation__control--open",
      open && kind === "permission",
    );
    this.modeButton?.classList.toggle(
      "agent-conversation__control--open",
      open && kind === "mode",
    );
    this.reasoningButton?.classList.toggle(
      "agent-conversation__control--open",
      open && kind === "reasoning",
    );
  }

  private getPermissionLabel(id: AgentPermissionMode): string {
    const options = this.getAccessOptionsForType();
    const option = options.find((item) => item.id === id) ?? options[0];
    return option ? this.accessOptionLabel(option) : id;
  }

  private getAccessOptionsForType(): readonly AgentAccessOption[] {
    return useAgentDataStore.getState().agents[this.getTypeKey()].catalog.capabilities.permissions;
  }

  private accessOptionLabel(option: AgentAccessOption): string {
    return option.labelKey ? this.t(option.labelKey) : option.label;
  }

  private getExternalAgentModel(): AgentCodexModel {
    // Conversation overrides take precedence over this Agent's preferences.
    const fromThread = this.readRuntimeSetting("model");
    if (
      fromThread &&
      !(this.getTypeKey() === "dsh" && fromThread === "inherit")
    ) {
      return fromThread as AgentCodexModel;
    }
    if (this.getTypeKey() === "pi") {
      return this.piDefaultModel || "";
    }
    // DSH 不提供 inherit 选项，未单独设置时直接选中全局 dsh-settings
    // 中的真实默认模型。配置异步加载完成后 refreshEmptySettings 会更新选中项。
    if (this.getTypeKey() === "dsh") {
      return (this.dshDefaultModel || "inherit") as AgentCodexModel;
    }
    return "inherit";
  }

  private getExternalAgentModelProviderId(): string | undefined {
    const instanceId = this.getInstanceId();
    if (instanceId) {
      const providerId = useAgentSessionStore
        .getState()
        .getInstance(instanceId)
        ?.runtimeConfig?.model?.providerId;
      if (providerId?.trim()) return providerId.trim();
    }
    const preferenceProvider = useAgentDataStore.getState().agents[this.getTypeKey()].user.model?.providerId;
    if (preferenceProvider?.trim()) return preferenceProvider.trim();
    if (this.getTypeKey() === "dsh") return this.dshDefaultProviderId;
    if (this.getTypeKey() === "pi") return this.piDefaultProviderId;
    return undefined;
  }

  private setExternalAgentModel(option: AgentModelOption): void {
    this.writeRuntimeSetting("model", option.id, option.providerId);
  }

  private selectExternalAgentModel(option: AgentModelOption): void {
    if (this.getTypeKey() === "pi" && isFlowixCloudModelOption(option)) {
      const state = useAgentDataStore.getState();
      const isAvailableInCurrentSession = state.piCloudAccountId !== null
        && state.agents.pi.catalog.models.items.some((model) =>
          isFlowixCloudModelOption(model)
          && model.id === option.id
          && (model.providerId ?? "") === (option.providerId ?? ""),
        );
      if (!isAvailableInCurrentSession) return;
      // Credit access is checked atomically by Cloud when a request starts.
    }
    this.setExternalAgentModel(option);
    this.setSettingsPopoverOpen(false);
  }

  // Returns the legacy inherit option label when a real default model is
  // available. Codex now renders the actual default model instead of this
  // synthetic label; DeepSeek Harness deliberately does not use inherit.
  private getExternalModelDefaultLabel(): string {
    if (this.getTypeKey() === "pi") {
      const model = this.readRuntimeSetting("model");
      if (!model || model === "inherit") {
        return this.piDefaultModel
          ? formatModelDisplayLabel(this.piDefaultModel)
          : "";
      }
      return formatModelDisplayLabel(model);
    }
    if (this.getTypeKey() === "claudecode" || this.getTypeKey() === "opencode") {
      return this.t("agent.permission.default");
    }
    return this.codexDefaultModel
      ? translate(this.getLanguage(), "agent.codexModel.defaultWith", {
          model: formatModelDisplayLabel(this.codexDefaultModel),
        })
      : "";
  }

  private getExternalModelFallbackOptions(): AgentModelOption[] {
    // 仅改 label: id (真实 model key) 保持不变, 不影响提交到后端的 payload。
    const mapLabel = (options: AgentModelOption[]): AgentModelOption[] =>
      options.map((option) => ({
        id: option.id,
        label: formatModelDisplayLabel(option.id),
        providerId: option.providerId,
        providerName: option.providerName,
      }));
    // DSH 无硬编码 fallback —— 列表完全来自后端 (用户目录 / llm-pi-ai
    // catalog); 拉取失败时仅显示当前值, 不显示 Codex 的模型。
    if (this.getTypeKey() === "dsh" || this.getTypeKey() === "opencode" || this.getTypeKey() === "pi") {
      return [];
    }
    return this.getTypeKey() === "claudecode"
      ? mapLabel(CLAUDE_MODEL_OPTIONS)
      : mapLabel(CODEX_MODEL_OPTIONS);
  }

  private getLoadedModelOptions(): AgentModelOption[] {
    const catalogOptions = useAgentDataStore.getState().agents[this.getTypeKey()].catalog.models.items;
    if (this.getTypeKey() === "pi") return catalogOptions as AgentModelOption[];
    if (catalogOptions.length > 0) return catalogOptions as AgentModelOption[];
    const localOptions =
      this.localSupportedModelsTypeKey === this.getTypeKey()
        ? this.localSupportedModels
        : [];
    return localOptions.length > 0
      ? localOptions
      : this.getExternalModelFallbackOptions();
  }

  /**
   * Resolve the (id, providerId) pair that the dropdown should highlight.
   *
   * The raw pair can disagree — e.g. a snapshot persisted a `key` without a
   * `providerId` so the route falls through to a different source (the global
   * settings-file default). Reconciling against the loaded directory keeps the
   * highlight on the real option inside its provider group instead of a
   * duplicated tail row, and makes the trigger label agree with the check mark.
   */
  private resolveCurrentSelection(): {
    id: AgentCodexModel;
    providerId: string | undefined;
  } {
    const id = this.getExternalAgentModel();
    const providerId = this.getExternalAgentModelProviderId();
    const loaded = this.getLoadedModelOptions();
    // Codex keeps inherit semantics at runtime, but the picker displays the
    // actual default model instead of a synthetic "Codex default" row.
    if (id === "inherit" && this.getTypeKey() === "codex" && this.codexDefaultModel) {
      const defaultOption = loaded.find(
        (option) => option.id === this.codexDefaultModel,
      );
      return {
        id: defaultOption?.id ?? this.codexDefaultModel,
        providerId: defaultOption?.providerId ?? providerId,
      };
    }
    if (id === "inherit" && this.getTypeKey() === "pi" && this.piDefaultModel) {
      const defaultOption = loaded.find(
        (option) => option.id === this.piDefaultModel
          && (!this.piDefaultProviderId || option.providerId === this.piDefaultProviderId),
      );
      return {
        id: defaultOption?.id ?? this.piDefaultModel,
        providerId: defaultOption?.providerId ?? this.piDefaultProviderId ?? providerId,
      };
    }
    if (id === "inherit") return { id, providerId };

    if (
      loaded.some((option) =>
        option.id === id
        && (option.providerId ?? "") === (providerId ?? ""),
      )
    ) {
      return { id, providerId };
    }
    const byId = loaded.find((option) => option.id === id);
    if (byId) return { id, providerId: byId.providerId };
    return { id, providerId };
  }

  private getExternalModelOptions(): AgentModelOption[] {
    if (this.shouldShowPiModelEmptyState()) return [];

    const selection = this.resolveCurrentSelection();
    const loadedModelOptions = this.getLoadedModelOptions();
    // Keep the Flowix Cloud provider at the top of Pi's composer picker when
    // its catalog entry is present. Preserve the order within each provider.
    const modelOptions = this.getTypeKey() === "pi"
      ? [
          ...loadedModelOptions.filter(isFlowixCloudModelOption),
          ...loadedModelOptions.filter((option) => !isFlowixCloudModelOption(option)),
        ]
      : loadedModelOptions;
    const piDefaultProvider = this.getTypeKey() === "pi"
      ? modelOptions.find((option) => option.providerId === this.piDefaultProviderId)
      : undefined;
    const inheritLabel = this.getTypeKey() === "dsh"
      ? ""
      : this.getExternalModelDefaultLabel();
    const showInheritOption =
      this.getTypeKey() !== "dsh" && this.getTypeKey() !== "codex" && this.getTypeKey() !== "pi";
    const options: AgentModelOption[] = [
      ...(showInheritOption && inheritLabel
        ? [{
            id: "inherit" as AgentCodexModel,
            label: inheritLabel,
            providerId: this.getTypeKey() === "dsh"
              ? this.dshDefaultProviderId
              : this.getTypeKey() === "pi"
                ? this.piDefaultProviderId
                : undefined,
            ...(piDefaultProvider?.providerName
              ? { providerName: piDefaultProvider.providerName }
              : {}),
          }]
        : []),
      ...modelOptions,
    ];
    const missingPiCloudModel = this.getTypeKey() === "pi"
      && selection.providerId?.trim().toLocaleLowerCase().startsWith("flowix-cloud") === true;
    // Synthesize a tail row only when the current model is genuinely absent
    // from the directory. A model present under a different provider route is
    // reconciled above and rendered as its real option, never duplicated here.
    // Flowix Cloud models are only valid while present in the active Cloud
    // directory, so a stale selection must not survive logout as a synthetic row.
    if (
      selection.id !== "inherit" &&
      !(this.getTypeKey() === "pi" && !selection.id) &&
      !missingPiCloudModel &&
      !options.some((option) =>
        option.id === selection.id
        && (option.providerId ?? "") === (selection.providerId ?? ""),
      )
    ) {
      // 拉取到的 model id 不在 fallback 列表时, 按展示规则美化 label,
      // id 仍为原始字符串, 后端取值不受影响。
      options.push({
        id: selection.id,
        label: formatModelDisplayLabel(selection.id),
        providerId: selection.providerId,
        providerName: selection.providerId,
      });
    }
    return options;
  }

  private getCurrentExternalModelLabel(): string {
    if (this.shouldShowPiModelEmptyState()) {
      return this.t(this.piModelsLoadFailed ? "agent.model.loadFailed" : "agent.model.noneFound");
    }

    const { id: model, providerId } = this.resolveCurrentSelection();
    if (this.getTypeKey() === "pi" && (!model || model === "inherit")) {
      return this.piDefaultModel
        ? formatModelDisplayLabel(this.piDefaultModel)
        : "";
    }
    const options = this.getExternalModelOptions();
    const match = options.find((option) =>
      option.id === model
      && (option.providerId ?? "") === (providerId ?? ""),
    );
    if (match) return match.label;
    // DSH 没有 Default 选项，等待默认模型异步加载期间不伪造一个选中值。
    if (this.getTypeKey() === "dsh" && model === "inherit") {
      return "";
    }
    // 未知模型仍然回退到列表中的第一个真实模型，避免控件显示空 label。
    const fallback = options.find(
      (option) => option.id !== ("inherit" as AgentCodexModel),
    );
    if (fallback) return fallback.label;
    return this.getTypeKey() === "codex"
      ? ""
      : this.getExternalModelDefaultLabel();
  }

  private shouldShowPiModelEmptyState(): boolean {
    return this.getTypeKey() === "pi"
      && this.localSupportedModelsTypeKey === "pi"
      && this.localSupportedModels.length === 0;
  }

  /** Model control text and optional styled Codex effort label. */
  private getComposerModelDisplay(): {
    text: string;
    model: string;
    effort?: string;
  } {
    const label = this.getCurrentExternalModelLabel();
    if (!label || !this.supportsRuntimeSetting("reasoning")) {
      return { text: label, model: label };
    }
    if (this.getTypeKey() === "codex") {
      const effortId = this.getCurrentCodexReasoningEffort();
      const labelKey = effortId in CODEX_COMPOSER_EFFORT_LABEL_KEYS
        ? CODEX_COMPOSER_EFFORT_LABEL_KEYS[effortId as CodexComposerEffort]
        : undefined;
      const effort = labelKey ? this.t(labelKey) : this.getCurrentCodexReasoningLabel();
      return { text: `${label} ${effort}`, model: label, effort };
    }
    return {
      text: `${label} · ${this.getCurrentCodexReasoningLabel().toLowerCase()}`,
      model: label,
    };
  }

  private getCurrentCodexReasoningLabel(): string {
    const options = this.getCodexReasoningOptions();
    const effort = this.getCurrentCodexReasoningEffort(options);
    return (
      options.find((option) => option.id === effort)?.label ??
      "Medium"
    );
  }

  private getCurrentCodexReasoningEffort(
    options = this.getCodexReasoningOptions(),
  ): AgentCodexReasoningEffort {
    const configured = this.readRuntimeSetting("reasoning");
    return options.find((option) => option.id === configured)?.id
      ?? options.find((option) => option.id === "medium")?.id
      ?? options[0]?.id
      ?? "medium";
  }

  private getCodexReasoningOptions(): typeof CODEX_REASONING_OPTIONS {
    const selectedModel = this.resolveCurrentSelection().id;
    const model = this.getLoadedModelOptions().find((option) => option.id === selectedModel);
    const supported = model?.reasoningEfforts;
    const defaultEfforts = ["low", "medium", "high", "xhigh"];
    const options = CODEX_REASONING_OPTIONS.filter((option) =>
      supported?.length
        ? supported.includes(option.id)
        : defaultEfforts.includes(option.id),
    );
    return options.length ? options : CODEX_REASONING_OPTIONS.filter((option) =>
      defaultEfforts.includes(option.id),
    );
  }

  private getCurrentPermissionLabel(): string {
    return this.getPermissionLabel(this.getCurrentPermissionMode());
  }

  private getCurrentPermissionMode(): AgentPermissionMode {
    const mode = this.readRuntimeSetting("permission") as AgentPermissionMode | undefined;
    const options = this.getAccessOptionsForType();
    return options.find((option) => option.id === mode)?.id
      ?? options[0]?.id
      ?? "danger-full-access";
  }

  private getCurrentHarnessMode(): AgentHarnessPreset {
    const mode = this.readRuntimeSetting("mode");
    const options = useAgentDataStore.getState().agents[this.getTypeKey()].catalog.capabilities.modes;
    return options.some((option) => option.id === mode)
      ? (mode as AgentHarnessPreset)
      : "standard";
  }

  private getCurrentModeLabel(): string {
    if (this.getTypeKey() === "pi") {
      return this.t(
        this.readRuntimeSetting("mode") === "code"
          ? "agent.mode.piCode"
          : "agent.mode.writing",
      );
    }
    const mode = this.getCurrentHarnessMode();
    const modeOption = useAgentDataStore.getState().agents[this.getTypeKey()].catalog.capabilities.modes
      .find((option) => option.id === mode);
    return (
      this.t(
        modeOption?.labelKey ?? "agent.mode.standard",
      )
    );
  }

  private supportsRuntimeSetting(kind: AgentRuntimeSettingKind): boolean {
    return supportsAgentRuntimeSetting(this.getTypeKey(), kind);
  }

  private renderModelSettings(): void {
    const { id: current, providerId: currentProviderId } =
      this.resolveCurrentSelection();
    const options = this.getExternalModelOptions();

    // Codex 的 reasoning effort 放在模型列表底部, 模型列表与强度可分别选择。
    if (this.getTypeKey() === "codex") {
      this.popover.classList.add(
        "agent-thread-card__codex-settings-popover--model-picker",
      );
      const modelList = document.createElement("div");
      modelList.className = "agent-thread-card__codex-settings-model-list";
      const modelSection = document.createElement("div");
      modelSection.className =
        "agent-thread-card__codex-settings-section agent-thread-card__codex-settings-section--model";
      modelSection.textContent = this.t("agent.model.title");
      modelSection.append(this.createCodexSpeedToggle());
      modelList.append(modelSection);

      options.forEach((option) => {
        modelList.append(
          createCodexSettingsItem(
            option.label,
            option.id === current
              && (option.providerId ?? "") === (currentProviderId ?? ""),
            () => {
              this.setExternalAgentModel(option);
              this.renderPopover();
              this.schedulePosition();
            },
          ),
        );
      });
      this.popover.append(modelList, this.createCodexReasoningSlider());
      return;
    }

    if (this.getTypeKey() === "pi") {
      const picker = createPiModelPicker({
        models: options,
        showMemberSection: this.getLoadedModelOptions().some(isFlowixCloudModelOption),
        selectedModelId: current,
        selectedProviderId: currentProviderId,
        memberLabel: this.t("preferences.pi.cloudTitle"),
        mineLabel: this.t("preferences.pi.byokTitle"),
        emptyLabel: this.t(
          this.piModelsLoadFailed ? "agent.model.loadFailed" : "agent.model.noneFound",
        ),
        personalEmptyLabel: this.t("agent.pi.modelSection.mineEmpty"),
        createModelItem: (option) => this.createModelSettingsItem(option, current, currentProviderId),
      });
      this.popover.append(picker);
    } else if (this.getTypeKey() === "dsh") {
      if (this.shouldShowPiModelEmptyState()) {
        const modelSection = document.createElement("div");
        modelSection.className = "agent-thread-card__codex-settings-section";
        modelSection.textContent = this.t("agent.model.title");
        this.popover.append(modelSection);
        this.popover.append(
          createCodexSettingsItem(
            this.t(this.piModelsLoadFailed ? "agent.model.loadFailed" : "agent.model.noneFound"),
            false,
            () => {},
            undefined,
            { readOnly: true },
          ),
        );
      } else {
        const groups = new Map<string, { label: string; options: AgentModelOption[] }>();
        options.forEach((option) => {
          const label = option.providerName?.trim() || option.providerId?.trim() || "Other";
          const key = option.providerId?.trim() || label;
          const group = groups.get(key);
          if (group) {
            group.options.push(option);
          } else {
            groups.set(key, { label, options: [option] });
          }
        });

        groups.forEach((group) => {
          const providerSection = document.createElement("div");
          providerSection.className =
            "agent-thread-card__codex-settings-section agent-thread-card__codex-settings-section--provider";
          providerSection.textContent = group.label;
          this.popover.append(providerSection);
          group.options.forEach((option) => {
            this.popover.append(this.createModelSettingsItem(option, current, currentProviderId));
          });
        });
      }
    } else {
      const modelSection = document.createElement("div");
      modelSection.className = "agent-thread-card__codex-settings-section";
      modelSection.textContent = this.t("agent.model.title");
      this.popover.append(modelSection);

      if (this.shouldShowPiModelEmptyState()) {
        this.popover.append(
          createCodexSettingsItem(
            this.t(this.piModelsLoadFailed ? "agent.model.loadFailed" : "agent.model.noneFound"),
            false,
            () => {},
            undefined,
            { readOnly: true },
          ),
        );
      } else {
        options.forEach((option) => {
          this.popover.append(this.createModelSettingsItem(option, current, currentProviderId));
        });
      }
    }

    if (!this.supportsRuntimeSetting("reasoning")) return;

    const divider = document.createElement("div");
    divider.setAttribute("role", "separator");
    divider.setAttribute("aria-hidden", "true");
    divider.className = POPUP_SEPARATOR_CLASS;
    this.popover.append(divider);

    const reasoningSection = document.createElement("div");
    reasoningSection.className = "agent-thread-card__codex-settings-section";
    reasoningSection.textContent = this.t("agent.reasoningDepth.title");
    if (this.getTypeKey() === "pi") {
      const reasoningGroup = document.createElement("div");
      reasoningGroup.className = "agent-pi-model-picker__reasoning";
      reasoningGroup.setAttribute("role", "group");
      reasoningGroup.setAttribute("aria-label", this.t("agent.reasoningDepth.title"));
      reasoningGroup.append(reasoningSection);
      this.popover.append(reasoningGroup);
      this.renderReasoningOptions(reasoningGroup, true);
    } else {
      this.popover.append(reasoningSection);
      this.renderReasoningOptions();
    }
  }

  private createCodexReasoningSlider(): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "agent-thread-card__codex-settings-reasoning-footer";

    const current =
      this.readRuntimeSetting("reasoning") ??
      "medium";
    const reasoningOptions = this.getCodexReasoningOptions().map((option) => ({
      ...option,
      label: this.t(`agent.reasoningDepth.${option.id}` as I18nKey),
    }));
    const currentIndex = reasoningOptions.findIndex((option) => option.id === current);
    const mediumIndex = reasoningOptions.findIndex((option) => option.id === "medium");
    const selectedIndex = currentIndex >= 0
      ? currentIndex
      : Math.max(0, mediumIndex);
    const track = document.createElement("div");
    track.className = "agent-thread-card__codex-settings-reasoning-track";
    track.setAttribute("aria-hidden", "true");
    reasoningOptions.forEach((_, index) => {
      const tick = document.createElement("span");
      tick.className = "agent-thread-card__codex-settings-reasoning-tick";
      const fraction = reasoningOptions.length > 1 ? index / (reasoningOptions.length - 1) : 0;
      const percent = fraction * 100;
      const offset = 12 - fraction * 24;
      tick.style.left = `calc(${percent}% + ${offset}px)`;
      track.append(tick);
    });

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "agent-thread-card__codex-settings-reasoning-slider";
    slider.min = "0";
    slider.max = String(reasoningOptions.length - 1);
    slider.step = "1";
    slider.value = String(selectedIndex);
    slider.setAttribute("aria-label", this.t("agent.reasoningDepth.title"));
    const syncSlider = () => {
      const index = Number(slider.value);
      const option = reasoningOptions[index] ?? reasoningOptions[0];
      const progress = reasoningOptions.length > 1
        ? (index / (reasoningOptions.length - 1)) * 100
        : 100;
      footer.style.setProperty("--reasoning-progress", `${progress}%`);
      slider.setAttribute("aria-valuetext", option.label);
      slider.title = option.label;
    };
    syncSlider();
    slider.addEventListener("input", (event) => {
      event.stopPropagation();
      const option = reasoningOptions[Number(slider.value)];
      if (!option) return;
      syncSlider();
      this.writeRuntimeSetting("reasoning", option.id);
    });
    footer.append(track, slider);
    return footer;
  }

  private createCodexSpeedToggle(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-thread-card__codex-speed-toggle";
    const instanceId = this.getInstanceId();
    const instanceServiceTier = instanceId
      ? useAgentSessionStore.getState().getInstance(instanceId)?.runtimeConfig?.serviceTier
      : undefined;
    this.codexServiceTier = instanceServiceTier
      ?? useAgentDataStore.getState().agents.codex.user.serviceTier
      ?? "auto";

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 12 12");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    icon.classList.add("agent-thread-card__codex-speed-icon");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3 3l6 6M9 3L3 9");
    icon.append(path);

    const value = document.createElement("span");
    value.className = "agent-thread-card__codex-speed-value";
    const updateValue = () => {
      const multiplier = this.codexServiceTier === "priority" ? 1.5 : 1;
      value.textContent = String(multiplier);
      const accessibleValue = `${this.t("agent.speed.title")} ×${multiplier}`;
      button.setAttribute("aria-label", accessibleValue);
      button.setAttribute("aria-pressed", this.codexServiceTier === "priority" ? "true" : "false");
      button.dataset.serviceTier = this.codexServiceTier;
      button.title = accessibleValue;
    };
    updateValue();

    button.append(icon, value);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.codexServiceTier = this.codexServiceTier === "auto" ? "priority" : "auto";
      const instanceId = this.getInstanceId();
      if (instanceId) {
        useAgentSessionStore.getState().setRuntimeConfig(instanceId, {
          serviceTier: this.codexServiceTier,
        });
      }
      useAgentDataStore.getState().setUserPreference("codex", {
        serviceTier: this.codexServiceTier,
      });
      updateValue();
    });
    return button;
  }

  private createModelSettingsItem(
    option: AgentModelOption,
    current: AgentCodexModel,
    currentProviderId: string | undefined,
  ): HTMLElement {
    const isPiCloudModel = this.getTypeKey() === "pi" && isFlowixCloudModelOption(option);
    const description = isPiCloudModel ? undefined : [
      option.subtitle?.trim(),
      option.creditMultiplier != null
        ? translate(this.getLanguage(), "preferences.pi.creditMultiplier", { value: option.creditMultiplier.toFixed(2) })
        : this.getTypeKey() === "pi" ? undefined : option.description,
    ].filter(Boolean).join(" · ");
    return createCodexSettingsItem(
      option.label,
      option.id === current
        && (option.providerId ?? "") === (currentProviderId ?? ""),
      () => {
        void this.selectExternalAgentModel(option);
      },
      description,
      { icon: modelProviderIcon(option.iconUrl) },
    );
  }

  private renderReasoningSettings(): void {
    this.renderReasoningOptions();
  }

  private renderReasoningOptions(
    target: HTMLElement = this.popover,
    useButtonSelectionState = false,
  ): void {
    const current =
      this.readRuntimeSetting("reasoning") ??
      "medium";
    const reasoningOptions = this.getTypeKey() === "pi"
      ? PI_THINKING_OPTIONS
      : this.getTypeKey() === "codex"
        ? this.getCodexReasoningOptions().map((option) => ({
            ...option,
            label: this.t(`agent.reasoningDepth.${option.id}` as I18nKey),
          }))
        : CODEX_REASONING_OPTIONS.filter((option) =>
            ["low", "medium", "high", "xhigh"].includes(option.id),
          );
    reasoningOptions.forEach((option) => {
      const item = createCodexSettingsItem(option.label, option.id === current, () => {
        this.writeRuntimeSetting("reasoning", option.id);
        this.setSettingsPopoverOpen(false);
      });
      if (useButtonSelectionState) {
        item.removeAttribute("role");
        item.removeAttribute("aria-checked");
        item.setAttribute("aria-pressed", option.id === current ? "true" : "false");
      }
      target.append(item);
    });
  }

  private renderModeSettings(): void {
    const options = useAgentDataStore.getState().agents[this.getTypeKey()].catalog.capabilities.modes;
    const current = this.readRuntimeSetting("mode")
      ?? (this.getTypeKey() === "pi" ? "writing" : "standard");
    if (this.getTypeKey() === "pi") {
      options.forEach((option) => {
        this.popover.append(
          createCodexSettingsItem(
            option.labelKey ? this.t(option.labelKey) : option.label,
            option.id === current,
            () => {
              this.writeRuntimeSetting("mode", option.id);
              this.setSettingsPopoverOpen(false);
            },
          ),
        );
      });
      return;
    }
    // DSH 模式选择器使用田字格双列布局, 每个 cell 垂直堆叠标题+副标题。
    const grid = document.createElement("div");
    grid.className = "agent-thread-card__codex-settings-grid";
    options.forEach((option) => {
      grid.append(
        createCodexSettingsItem(
          option.labelKey ? this.t(option.labelKey) : option.label,
          option.id === current,
          () => {
            this.writeRuntimeSetting("mode", option.id);
            this.setSettingsPopoverOpen(false);
          },
          option.descriptionKey ? this.t(option.descriptionKey) : undefined,
          { layout: "grid" },
        ),
      );
    });
    this.popover.append(grid);
  }

  private renderPermissionSettings(): void {
    const current = this.readRuntimeSetting("permission");
    this.getAccessOptionsForType().forEach((option) => {
      this.popover.append(
        createCodexSettingsItem(
          this.accessOptionLabel(option),
          option.id === current,
          () => {
            this.writeRuntimeSetting("permission", option.id);
            this.setSettingsPopoverOpen(false);
          },
          undefined,
          { icon: createPermissionModeIcon(option.id) },
        ),
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
    if (this.popoverPlacement === "submenu") {
      const maxLeft = Math.max(padding, viewportWidth - padding - popoverWidth);
      // A cascading settings panel touches the hovered row directly and uses
      // that row's top edge, rather than the parent add-menu bounds, as anchor.
      const rightPosition = anchorRect.right;
      const preferredLeft = rightPosition + popoverWidth <= viewportWidth - padding
        ? rightPosition
        : anchorRect.left - popoverWidth;
      const left = Math.min(Math.max(preferredLeft, padding), maxLeft);
      const maxTop = Math.max(padding, viewportHeight - padding - popoverHeight);
      const top = Math.min(Math.max(anchorRect.top, padding), maxTop);
      applyPopoverPosition(this.popover, { left, top, placeAbove: false });
      return;
    }
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
