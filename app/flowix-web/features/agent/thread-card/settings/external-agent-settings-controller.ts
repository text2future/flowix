import type { AppLanguage, I18nKey } from "@/lib/i18n";
import { translate } from "@/lib/i18n";
import { resolveNotebookAgentFiles } from "@/lib/agent-access-defaults";
import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
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
  getAgentAccessOptions,
  getAgentRuntimeSpec,
  supportsAgentRuntimeSetting,
  type AgentAccessOption,
  type AgentRuntimeSettingKind,
} from "@features/agent/runtime/agent-runtime-spec";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { loadDshModelConfigs } from "@features/agent/store/dsh-model-config-store";
import { useMemoStore } from "@features/memo/store/memo-store";
import { resolvePrimaryWorkspace } from "@features/agent/runtime/primary-workspace";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";
import { normalizeConversationWorkspaceState } from "@features/agent/runtime/conversation-workspace";
import { agent } from "@platform/tauri/client";
import { subscribe, type UnlistenFn } from "@platform/tauri/event-bus";
import {
  applyPopoverPosition,
  calculateAnchoredPopoverPosition,
} from "@features/agent/thread-card/popover/popover-position";
import {
  createCodexSettingsItem,
  createExternalAgentEmptyControl,
  createExternalAgentEmptyIcon,
  createExternalAgentWorkspaceControl,
  createExternalAgentWorkspaceDisplay,
  updateExternalAgentEmptyControl,
  type ExternalAgentEmptyControlKind,
} from "@features/agent/thread-card/settings/external-agent-settings";
import { createChevronIcon } from "@features/agent/thread-card/agent-thread-card-icons";
import { openBrowserColumnFileBrowser } from "@features/workspace/use-cases/browser-column-navigation";

const CODEX_SETTINGS_POPOVER_WIDTH_PX = 212;
const CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX = 280;
const CODEX_SETTINGS_POPOVER_OFFSET_PX = 6;
const CODEX_SETTINGS_POPOVER_VIEWPORT_PADDING_PX = 8;

type AgentModelOption = {
  id: AgentCodexModel;
  label: string;
  /** DeepSeek Harness llm-pi-ai route; absent for legacy/Codex options. */
  providerId?: string;
  providerName?: string;
};

const CLAUDE_MODEL_OPTIONS: AgentModelOption[] = [
  { id: "claude-opus-4-8", label: "claude-opus-4-8" },
  { id: "claude-sonnet-5", label: "claude-sonnet-5" },
  { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
];

const DEEPSEEK_HARNESS_MODE_OPTIONS: readonly {
  id: AgentHarnessPreset;
  labelKey: I18nKey;
  descriptionKey: I18nKey;
}[] = [
  {
    id: "standard",
    labelKey: "agent.mode.standard",
    descriptionKey: "agent.mode.standard.description",
  },
  {
    id: "code",
    labelKey: "agent.mode.code",
    descriptionKey: "agent.mode.code.description",
  },
  {
    id: "minimal",
    labelKey: "agent.mode.minimal",
    descriptionKey: "agent.mode.minimal.description",
  },
  {
    id: "cordis",
    labelKey: "agent.mode.cordis",
    descriptionKey: "agent.mode.cordis.description",
  },
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
  t: (key: I18nKey) => string;
  isDestroyed: () => boolean;
  isRunning?: () => boolean;
  consumeOutsidePointer?: (event: PointerEvent) => void;
}

export class ExternalAgentSettingsController {
  private readonly popover: HTMLDivElement;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly getInstanceId: () => string | undefined;
  private readonly getLanguage: () => AppLanguage;
  private readonly t: (key: I18nKey) => string;
  private readonly isDestroyed: () => boolean;
  private readonly isRunning: () => boolean;
  private readonly consumeOutsidePointer?: (event: PointerEvent) => void;

  private modelButton: HTMLButtonElement | null = null;
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
  private resizeObserver: ResizeObserver | null = null;
  private positionFrame: number | null = null;
  private codexDefaultModel = "";
  private dshDefaultModel = "";
  private dshDefaultProviderId: string | undefined;
  private localSupportedModelsTypeKey: AgentTypeKey | null = null;
  private localSupportedModels: AgentModelOption[] = [];
  private readonly unlistenCodexSettings: UnlistenFn;

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
    this.isRunning = options.isRunning ?? (() => false);
    this.consumeOutsidePointer = options.consumeOutsidePointer;
    this.unlistenCodexSettings = subscribe<Record<string, unknown>>(
      "codex-thread-settings-updated",
      (payload) => { void this.applyCodexSettingsNotification(payload); },
    );
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
   * 读 model/permission/reasoning 控件的当前值 ── 优先 instance 快照。
   *  - instanceId 存在 + runtimeConfig 对应字段非空 → 用 instance 值
   *  - 否则 → fallback 到全局 useAgentSessionStore 对应字段
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
    // Phase 4 (2026-08-02): 真源切到 session-store.sessionMeta.settings.
    const settings = useAgentSessionStore.getState().sessionMeta.settings;
    if (instanceId) {
      const runtimeConfig =
        useAgentSessionStore.getState().getInstance(instanceId)
          ?.runtimeConfig;
      if (runtimeConfig) {
        if (kind === "model" && runtimeConfig.model?.key) {
          return runtimeConfig.model.key;
        }
        if (kind === "permission" && runtimeConfig.access?.sandbox) {
          return runtimeConfig.access.sandbox;
        }
        if (kind === "reasoning" && runtimeConfig.reasoningEffort) {
          return runtimeConfig.reasoningEffort;
        }
        if (kind === "mode" && runtimeConfig.deepseekHarness?.mode) {
          return runtimeConfig.deepseekHarness.mode;
        }
      }
    }
    const typeDefault =
      useAgentAccessStore.getState().config.defaults?.runtime?.[this.getTypeKey()];
    if (typeDefault) {
      if (kind === "model" && typeDefault.model?.key) return typeDefault.model.key;
      if (kind === "permission" && typeDefault.access?.sandbox) {
        return typeDefault.access.sandbox;
      }
      if (kind === "reasoning" && typeDefault.reasoningEffort) {
        return typeDefault.reasoningEffort;
      }
      if (kind === "mode" && typeDefault.mode) return typeDefault.mode;
    }
    // DSH 不继承 Codex 系全局模型选择 (用户在 Codex 卡片选过的模型对 DSH
    // 无意义) —— 无 instance / 类型默认时等待全局 dsh-settings 的真实默认值。
    if (kind === "model") {
      return this.getTypeKey() === "deepseek-harness"
        ? undefined
        : settings.agentCodexModel;
    }
    // 权限默认与所有 agent 统一 (danger-full-access / 完全访问), 无特殊分支。
    if (kind === "permission") return settings.agentPermissionMode;
    if (kind === "reasoning") return settings.agentCodexReasoningEffort;
    return undefined;
  }

  /**
   * 写 model/permission/reasoning 控件 → 路由到 instance.runtimeConfig。
   * instanceId 不存在（编辑器临时态）时退化为全局 setAgent*, 保持现有 fallback 行为。
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
        instanceStore.setRuntimeConfig(instanceId, {
          model: {
            key: value,
            ...(providerId?.trim() ? { providerId: providerId.trim() } : {}),
          },
        });
        void useAgentAccessStore
          .getState()
          .setDefaultRuntime(typeKey, {
            model: {
              key: value,
              ...(providerId?.trim() ? { providerId: providerId.trim() } : {}),
            },
          });
        this.syncCodexThreadSetting(instanceId, kind, value);
        return;
      }
      if (kind === "permission") {
        instanceStore.setRuntimeConfig(instanceId, {
          access: { sandbox: value as AgentPermissionMode },
        });
        void useAgentAccessStore.getState().setDefaultRuntime(typeKey, {
          access: { sandbox: value as AgentPermissionMode },
        });
        this.syncCodexThreadSetting(instanceId, kind, value);
        return;
      }
      if (kind === "mode") {
        instanceStore.setRuntimeConfig(instanceId, {
          deepseekHarness: { mode: value as AgentHarnessPreset },
        });
        void useAgentAccessStore.getState().setDefaultRuntime(typeKey, {
          mode: value as AgentHarnessPreset,
        });
        return;
      }
      // reasoning effort 与 model / permission 同维度，锁定在 instance 快照上。
      instanceStore.setRuntimeConfig(instanceId, {
        reasoningEffort: value as AgentCodexReasoningEffort,
      });
      void useAgentAccessStore.getState().setDefaultRuntime(typeKey, {
        reasoningEffort: value as AgentCodexReasoningEffort,
      });
      this.syncCodexThreadSetting(instanceId, kind, value);
      return;
    }
    // 无 instanceId (编辑器临时态) ── 退化到全局, 保留兼容。
    // Update canonical global settings when no instance override exists.
    if (kind === "model") {
      useAgentSessionStore.getState().setSessionMeta((meta) => ({
        ...meta,
        settings: {
          ...meta.settings,
          agentCodexModel: value as AgentCodexModel,
        },
      }));
      void useAgentAccessStore
        .getState()
        .setDefaultRuntime(typeKey, {
          model: {
            key: value,
            ...(providerId?.trim() ? { providerId: providerId.trim() } : {}),
          },
        });
      return;
    }
    if (kind === "permission") {
      useAgentSessionStore.getState().setSessionMeta((meta) => ({
        ...meta,
        settings: {
          ...meta.settings,
          agentPermissionMode: value as AgentPermissionMode,
        },
      }));
      void useAgentAccessStore.getState().setDefaultRuntime(typeKey, {
        access: { sandbox: value as AgentPermissionMode },
      });
      return;
    }
    if (kind === "mode") {
      void useAgentAccessStore.getState().setDefaultRuntime(typeKey, {
        mode: value as AgentHarnessPreset,
      });
      return;
    }
    useAgentSessionStore.getState().setSessionMeta((meta) => ({
      ...meta,
      settings: {
        ...meta.settings,
        agentCodexReasoningEffort: value as AgentCodexReasoningEffort,
      },
    }));
    void useAgentAccessStore.getState().setDefaultRuntime(typeKey, {
      reasoningEffort: value as AgentCodexReasoningEffort,
    });
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

  get isOpen(): boolean {
    return this.open;
  }

  get popoverElement(): HTMLDivElement {
    return this.popover;
  }

  get anchorElement(): HTMLButtonElement | null {
    return this.anchor;
  }

  loadDefaultModel(): void {
    const typeKey = this.getTypeKey();
    const isDeepseekHarness = typeKey === "deepseek-harness";
    if (isDeepseekHarness) {
      void loadDshModelConfigs()
        .then((configs) => {
          if (this.isDestroyed() || this.getTypeKey() !== typeKey) return;
          const configuredDefault = useAgentAccessStore
            .getState()
            .config.defaults?.runtime?.['deepseek-harness']?.model;
          const firstConfig = configs[0]?.model;
          this.dshDefaultModel = configuredDefault?.key
            && configuredDefault.key !== 'inherit'
            ? configuredDefault.key.trim()
            : firstConfig?.model.trim() ?? "";
          this.dshDefaultProviderId = configuredDefault?.key
            && configuredDefault.key !== 'inherit'
            ? configuredDefault.providerId?.trim() || undefined
            : firstConfig?.providerId?.trim() || undefined;

          const seen = new Set<string>();
          this.localSupportedModelsTypeKey = typeKey;
          this.localSupportedModels = configs.flatMap((file) => {
            const config = file.model;
            const providerId = config.providerId?.trim() || undefined;
            const providerName = config.displayName?.trim() || config.provider;
            const models = config.models?.length
              ? config.models
              : config.model.trim()
                ? [{ id: config.model, name: "" }]
                : [];
            return models
              .map((model) => ({
                id: model.id.trim(),
                label: formatModelDisplayLabel(model.id),
                providerId,
                providerName,
              }))
              .filter((model) => model.id.length > 0)
              .filter((model) => {
                const key = `${model.providerId ?? model.providerName}\u0000${model.id}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
          });
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
      return;
    }
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
          .map((model) => ({
            id: model,
            // 后端拉取的 model key 同样按展示规则美化 label;
            // 不匹配规则的 key (例如 "inherit") 原样返回。
            label: formatModelDisplayLabel(model),
          }));
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

    // 控件组独立成行, 让独立对话 / 全屏能在其上方叠加 Agent 图标并整体居中；
    // 非全屏 thread card 通过 CSS 让这层保持原有的单行 flex 表现。
    empty.append(createExternalAgentEmptyIcon(this.getTypeKey()));
    const controls = document.createElement("div");
    controls.className = "agent-thread-card__empty-controls";
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
          this.getCurrentExternalModelLabel(),
        )
      : null;
    this.reasoningButton = null;
    this.modeButton = this.supportsRuntimeSetting("mode")
      ? this.createEmptyControl(
          "mode",
          this.t("agent.mode.title"),
          this.getCurrentHarnessModeLabel(),
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
    return empty;
  }

  /** Compact model switch trigger used by the expanded composer footer. */
  createComposerModelButton(): HTMLButtonElement | null {
    if (!this.supportsRuntimeSetting("model")) return null;
    const button = createExternalAgentWorkspaceControl(
      this.t("agent.model.title"),
      this.getComposerModelDisplayLabel(),
      (anchor) => this.toggleSettingsPopover("model", anchor),
    );
    button.classList.replace(
      "agent-thread-card__composer-workspace",
      "agent-thread-card__composer-model",
    );
    const value = button.querySelector<HTMLElement>(
      ".agent-thread-card__composer-workspace-value",
    );
    value?.classList.replace(
      "agent-thread-card__composer-workspace-value",
      "agent-thread-card__composer-model-value",
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
      this.getCurrentWorkspaceLabel(),
      (anchor) => this.toggleWorkspacePopover(anchor),
    );
    this.composerWorkspaceButton = button;
    this.refreshComposerWorkspaceButton();
    return button;
  }

  /** Compact DSH mode switcher placed beside the model control. */
  createComposerModeButton(): HTMLButtonElement | null {
    if (!this.supportsRuntimeSetting("mode")) return null;
    const label = this.t("agent.mode.title");
    const button = createExternalAgentWorkspaceControl(
      label,
      this.getCurrentHarnessModeLabel(),
      (anchor) => this.toggleSettingsPopover("mode", anchor),
    );
    button.classList.replace(
      "agent-thread-card__composer-workspace",
      "agent-thread-card__composer-mode",
    );
    const value = button.querySelector<HTMLElement>(
      ".agent-thread-card__composer-workspace-value",
    );
    value?.classList.replace(
      "agent-thread-card__composer-workspace-value",
      "agent-thread-card__composer-mode-value",
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
      this.getCurrentPermissionLabel(),
      (anchor) => this.toggleSettingsPopover("permission", anchor),
    );
    button.classList.replace(
      "agent-thread-card__composer-workspace",
      "agent-thread-card__composer-permission",
    );
    const value = button.querySelector<HTMLElement>(
      ".agent-thread-card__composer-workspace-value",
    );
    value?.classList.replace(
      "agent-thread-card__composer-workspace-value",
      "agent-thread-card__composer-permission-value",
    );
    this.composerPermissionButton = button;
    this.refreshComposerPermissionButton();
    return button;
  }

  refreshComposerModelButton(): void {
    if (!this.composerModelButton) return;
    const label = this.getComposerModelDisplayLabel();
    const valueEl = this.composerModelButton.querySelector<HTMLElement>(
      ".agent-thread-card__composer-model-value",
    );
    if (valueEl) valueEl.textContent = label;
    this.composerModelButton.title = `${this.t("agent.model.title")}: ${label}`;
    this.composerModelButton.setAttribute(
      "aria-label",
      `${this.t("agent.model.title")}: ${label}`,
    );
  }

  private refreshComposerModeButton(): void {
    if (!this.composerModeButton) return;
    const value = this.getCurrentHarnessModeLabel();
    const valueEl = this.composerModeButton.querySelector<HTMLElement>(
      ".agent-thread-card__composer-mode-value",
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
    const value = this.getCurrentWorkspaceLabel();
    const valueEl = this.composerWorkspaceButton.querySelector<HTMLElement>(
      ".agent-thread-card__composer-workspace-value",
    );
    if (valueEl) valueEl.textContent = value;
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
    const value = this.getCurrentPermissionLabel();
    const valueEl = this.composerPermissionButton.querySelector<HTMLElement>(
      ".agent-thread-card__composer-permission-value",
    );
    if (valueEl) valueEl.textContent = value;
    const label = this.t("agent.permission.title");
    this.composerPermissionButton.title = `${label}: ${value}`;
    this.composerPermissionButton.setAttribute("aria-label", `${label}: ${value}`);
    this.refreshCodexPermissionFrozenState();
  }

  refreshEmptySettings(): void {
    this.refreshComposerModelButton();
    this.refreshComposerModeButton();
    this.refreshComposerPermissionButton();
    this.refreshComposerWorkspaceButton();
    if (this.workspaceDisplay) {
      const value = this.workspaceDisplay.querySelector<HTMLElement>(
        ".agent-thread-card__empty-workspace-value",
      );
      const nextValue = this.getCurrentWorkspaceLabel();
      if (value) value.textContent = nextValue;
      this.workspaceDisplay.title = `${this.t("agent.workspace.title")}: ${nextValue}`;
      this.workspaceDisplay.setAttribute(
        "aria-label",
        `${this.t("agent.workspace.title")}: ${nextValue}`,
      );
    }
    if (this.modelButton) {
      updateExternalAgentEmptyControl(
        this.modelButton,
        this.getCurrentExternalModelLabel(),
      );
    }
    if (this.permissionButton) {
      updateExternalAgentEmptyControl(
        this.permissionButton,
        this.getCurrentPermissionLabel(),
      );
    }
    this.refreshCodexPermissionFrozenState();
    if (this.modeButton) {
      updateExternalAgentEmptyControl(
        this.modeButton,
        this.getCurrentHarnessModeLabel(),
      );
    }
    if (this.reasoningButton) {
      updateExternalAgentEmptyControl(
        this.reasoningButton,
        this.getCurrentCodexReasoningLabel(),
      );
    }
  }

  private getCurrentWorkspaceLabel(): string {
    const path = this.getCurrentWorkspacePath();
    if (!path) return this.t("agent.workspace.unset");

    const normalize = (value: string): string =>
      value.replace(/[\\/]+$/, "").toLowerCase();
    const entry = useAgentAccessStore
      .getState()
      .config.entries.find(
        (item) => item.kind === "folder" && normalize(item.path) === normalize(path),
      );
    const instance = this.getInstanceId()
      ? useAgentSessionStore.getState().getInstance(this.getInstanceId()!)
      : undefined;
    const configuredNotebookId = instance?.runtimeConfig?.notebookId;
    const notebook =
      (configuredNotebookId
        ? useMemoStore.getState().notebooks.find((item) => item.id === configuredNotebookId)
        : null) ?? useMemoStore.getState().selectedNotebook;
    if (entry?.name?.trim()) return entry.name.trim();
    if (notebook && normalize(notebook.path) === normalize(path) && notebook.name?.trim()) {
      return notebook.name.trim();
    }
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  private getCurrentWorkspacePath(): string {
    const instance = this.getInstanceId()
      ? useAgentSessionStore.getState().getInstance(this.getInstanceId()!)
      : undefined;
    const runtimeConfig = instance?.runtimeConfig;
    const snapshot = runtimeConfig?.workspaceSnapshot;
    const snapshotPath =
      snapshot && typeof snapshot === "object" && typeof snapshot.cwd === "string"
        ? snapshot.cwd.trim()
        : "";
    const configuredNotebookId = runtimeConfig?.notebookId;
    const memoState = useMemoStore.getState();
    const notebook =
      (configuredNotebookId
        ? memoState.notebooks.find((item) => item.id === configuredNotebookId)
        : null) ?? memoState.selectedNotebook;
    const notebookPath = notebook?.path?.trim();
    const accessState = useAgentAccessStore.getState();
    const defaultFiles = resolveNotebookAgentFiles(
      accessState.config,
      accessState.notebookConfigs,
      configuredNotebookId ?? notebook?.id,
    );
    const primary = resolvePrimaryWorkspace({ defaultFiles, notebookPath });
    const path = snapshotPath || (primary.kind === "empty" ? "" : primary.path);
    return path;
  }

  private getWorkspaceDirectoryChoices(): {
    cwd: { path: string; label: string } | null;
    addDirs: Array<{ path: string; label: string }>;
  } {
    const instance = this.getInstanceId()
      ? useAgentSessionStore.getState().getInstance(this.getInstanceId()!)
      : undefined;
    const runtimeConfig = instance?.runtimeConfig;
    const state = normalizeConversationWorkspaceState(runtimeConfig);
    const snapshot = state?.applied ?? state?.desired ?? runtimeConfig?.workspaceSnapshot;
    const cwdPath = normalizeWorkspacePath(snapshot?.cwd ?? this.getCurrentWorkspacePath());
    const configuredNotebookId = runtimeConfig?.notebookId ?? snapshot?.notebookId;
    const memoState = useMemoStore.getState();
    const notebook =
      (configuredNotebookId
        ? memoState.notebooks.find((item) => item.id === configuredNotebookId)
        : null) ?? memoState.selectedNotebook;
    const accessState = useAgentAccessStore.getState();
    const fallbackFiles = resolveNotebookAgentFiles(
      accessState.config,
      accessState.notebookConfigs,
      configuredNotebookId ?? notebook?.id,
    );
    const addDirPaths = snapshot
      ? snapshot.workspacePaths
      : (fallbackFiles?.folders ?? []);
    const notebookAddDirs = configuredNotebookId
      ? accessState.notebookConfigs[configuredNotebookId]?.addDirs ?? []
      : [];
    const labelForPath = (path: string): string => {
      const key = normalizeWorkspacePath(path).toLowerCase();
      const local = notebookAddDirs.find(
        (item) => normalizeWorkspacePath(item.path).toLowerCase() === key,
      );
      const entry = accessState.config.entries.find(
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
      return [{ path, label: labelForPath(path) }];
    });
    return {
      cwd: cwdPath ? { path: cwdPath, label: labelForPath(cwdPath) } : null,
      addDirs,
    };
  }

  /**
   * Codex App Server receives the legacy sandbox setting only on thread/start.
   * A resumed thread therefore cannot apply a changed permission mode, so make
   * that immutable once the product conversation has a Codex thread.
   */
  private refreshCodexPermissionFrozenState(): void {
    // App Server settings updates are queued for the next turn, so an
    // existing Codex thread remains editable. Only disable while a turn is
    // active if the control cannot safely queue a change.
    const disabled =
      this.getTypeKey() === "codex" &&
      this.isRunning() &&
      !getAgentRuntimeSpec(this.getTypeKey()).workspace.switchWhileRunning;
    for (const button of [this.permissionButton, this.composerPermissionButton]) {
      if (!button) continue;
      button.disabled = disabled;
      button.setAttribute("aria-disabled", disabled ? "true" : "false");
    }
    if (disabled && this.open && this.kind === "permission") {
      this.setSettingsPopoverOpen(false);
    }
  }

  toggleSettingsPopover(
    kind: AgentRuntimeSettingKind,
    anchor: HTMLButtonElement,
  ): void {
    const sameMenuOpen =
      this.open && this.kind === kind && this.anchor === anchor;
    this.setSettingsPopoverOpen(!sameMenuOpen, kind, anchor);
  }

  private toggleWorkspacePopover(anchor: HTMLButtonElement): void {
    const sameMenuOpen = this.workspacePopoverOpen && this.anchor === anchor;
    if (sameMenuOpen) {
      this.setSettingsPopoverOpen(false);
      return;
    }
    this.workspacePopoverOpen = true;
    this.open = true;
    this.kind = null;
    this.anchor = anchor;
    this.popover.hidden = false;
    this.popover.classList.remove("agent-thread-card__codex-settings-popover--mode");
    this.syncControlOpenState(true, null);
    this.renderWorkspacePopover();
    this.schedulePosition();
    this.startPositionTracking();
    document.addEventListener("pointerdown", this.handleOutsidePointer, true);
  }

  setSettingsPopoverOpen(
    open: boolean,
    kind: AgentRuntimeSettingKind | null = null,
    anchor: HTMLButtonElement | null = null,
  ): void {
    if (this.open === open && (!open || this.kind === kind) && !this.workspacePopoverOpen) return;
    this.workspacePopoverOpen = false;
    this.open = open;
    this.kind = open ? kind : null;
    this.anchor = open ? anchor : null;
    this.popover.hidden = !open;
    this.popover.classList.toggle(
      "agent-thread-card__codex-settings-popover--mode",
      open && kind === "mode",
    );
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
      this.renderHarnessModeSettings();
      return;
    }
    this.renderPermissionSettings();
  }

  private renderWorkspacePopover(): void {
    this.popover.replaceChildren();
    const choices = this.getWorkspaceDirectoryChoices();
    const accessTitle = document.createElement("div");
    accessTitle.className = "agent-thread-card__codex-settings-title";
    accessTitle.textContent = this.t("agent.workspace.access");
    this.popover.append(accessTitle);
    if (choices.cwd) {
      this.popover.append(
        createCodexSettingsItem(choices.cwd.label, true, () => {}, undefined, {
          readOnly: true,
          selectedLabel: "cwd",
        }),
      );
    }

    if (choices.addDirs.length > 0) {
      choices.addDirs.forEach((choice) => {
        this.popover.append(
          createCodexSettingsItem(choice.label, false, () => {}, undefined, {
            readOnly: true,
          }),
        );
      });
    }

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className =
      "agent-thread-card__codex-settings-item agent-thread-card__codex-settings-settings";
    settingsButton.setAttribute("role", "menuitem");
    settingsButton.setAttribute("aria-label", this.t("agent.workspace.settings"));
    const settingsLabel = document.createElement("span");
    settingsLabel.className = "agent-thread-card__codex-settings-item-label";
    settingsLabel.textContent = this.t("agent.workspace.settings");
    const chevron = createChevronIcon("right");
    chevron.setAttribute("class", "agent-thread-card__codex-settings-settings-chevron");
    settingsButton.append(settingsLabel, chevron);
    settingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setSettingsPopoverOpen(false);
      const workspacePath = this.getCurrentWorkspacePath();
      if (workspacePath) void openBrowserColumnFileBrowser(workspacePath);
    });
    settingsButton.addEventListener("mousedown", (event) => event.stopPropagation());
    this.popover.append(settingsButton);
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
    this.unlistenCodexSettings();
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
      this.toggleSettingsPopover(nextKind, button);
    });
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
      "agent-thread-card__empty-control--open",
      modelExpanded,
    );
    this.composerModelButton?.setAttribute(
      "aria-expanded",
      modelExpanded ? "true" : "false",
    );
    this.composerModelButton?.classList.toggle(
      "agent-thread-card__composer-model--open",
      modelExpanded,
    );
    this.composerPermissionButton?.setAttribute(
      "aria-expanded",
      open && kind === "permission" ? "true" : "false",
    );
    this.composerPermissionButton?.classList.toggle(
      "agent-thread-card__composer-permission--open",
      open && kind === "permission",
    );
    this.composerWorkspaceButton?.setAttribute(
      "aria-expanded",
      this.workspacePopoverOpen && open ? "true" : "false",
    );
    this.composerWorkspaceButton?.classList.toggle(
      "agent-thread-card__composer-workspace--open",
      this.workspacePopoverOpen && open,
    );
    this.workspaceDisplay?.setAttribute(
      "aria-expanded",
      this.workspacePopoverOpen && open ? "true" : "false",
    );
    this.workspaceDisplay?.classList.toggle(
      "agent-thread-card__empty-workspace--open",
      this.workspacePopoverOpen && open,
    );
    this.permissionButton?.classList.toggle(
      "agent-thread-card__empty-control--open",
      open && kind === "permission",
    );
    this.modeButton?.classList.toggle(
      "agent-thread-card__empty-control--open",
      open && kind === "mode",
    );
    this.reasoningButton?.classList.toggle(
      "agent-thread-card__empty-control--open",
      open && kind === "reasoning",
    );
  }

  private getPermissionLabel(id: AgentPermissionMode): string {
    const options = this.getAccessOptionsForType();
    const option = options.find((item) => item.id === id) ?? options[0];
    return option ? this.accessOptionLabel(option) : id;
  }

  private getAccessOptionsForType(): readonly AgentAccessOption[] {
    return getAgentAccessOptions(this.getTypeKey());
  }

  private accessOptionLabel(option: AgentAccessOption): string {
    return option.labelKey ? this.t(option.labelKey) : option.label;
  }

  private getExternalAgentModel(): AgentCodexModel {
    // Claude 仍走 local state (per-controller); codex/claude-other
    // 改为走 instance.runtimeConfig 优先, fallback 全局 agentCodexModel.
    const fromThread = this.readRuntimeSetting("model");
    if (
      fromThread &&
      !(this.getTypeKey() === "deepseek-harness" && fromThread === "inherit")
    ) {
      return fromThread as AgentCodexModel;
    }
    // DSH 不提供 inherit 选项，未单独设置时直接选中全局 dsh-settings
    // 中的真实默认模型。配置异步加载完成后 refreshEmptySettings 会更新选中项。
    if (this.getTypeKey() === "deepseek-harness") {
      return (this.dshDefaultModel || "inherit") as AgentCodexModel;
    }
    // Phase 4 (2026-08-02): 真源切到 session-store.sessionMeta.settings.
    return useAgentSessionStore.getState().sessionMeta.settings.agentCodexModel;
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
    const typeDefault = useAgentAccessStore
      .getState()
      .config.defaults?.runtime?.[this.getTypeKey()]
      ?.model?.providerId;
    if (typeDefault?.trim()) return typeDefault.trim();
    return this.getTypeKey() === "deepseek-harness"
      ? this.dshDefaultProviderId
      : undefined;
  }

  private setExternalAgentModel(option: AgentModelOption): void {
    this.writeRuntimeSetting("model", option.id, option.providerId);
  }

  // Returns the legacy/Codex inherit option label when a real default model
  // is available. DeepSeek Harness deliberately does not call this an option.
  private getExternalModelDefaultLabel(): string {
    if (this.getTypeKey() === "claude" || this.getTypeKey() === "opencode") {
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
    if (this.getTypeKey() === "deepseek-harness" || this.getTypeKey() === "opencode") {
      return [];
    }
    return this.getTypeKey() === "claude"
      ? mapLabel(CLAUDE_MODEL_OPTIONS)
      : mapLabel(CODEX_MODEL_OPTIONS);
  }

  private getLoadedModelOptions(): AgentModelOption[] {
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
    if (id === "inherit") return { id, providerId };
    const loaded = this.getLoadedModelOptions();
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
    const selection = this.resolveCurrentSelection();
    const modelOptions = this.getLoadedModelOptions();
    const inheritLabel = this.getTypeKey() === "deepseek-harness"
      ? ""
      : this.getExternalModelDefaultLabel();
    const options: AgentModelOption[] = [
      ...(this.getTypeKey() !== "deepseek-harness" && inheritLabel
        ? [{
            id: "inherit" as AgentCodexModel,
            label: inheritLabel,
            providerId: this.getTypeKey() === "deepseek-harness"
              ? this.dshDefaultProviderId
              : undefined,
          }]
        : []),
      ...modelOptions,
    ];
    // Synthesize a tail row only when the current model is genuinely absent
    // from the directory. A model present under a different provider route is
    // reconciled above and rendered as its real option, never duplicated here.
    if (
      selection.id !== "inherit" &&
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
    const { id: model, providerId } = this.resolveCurrentSelection();
    const options = this.getExternalModelOptions();
    const match = options.find((option) =>
      option.id === model
      && (option.providerId ?? "") === (providerId ?? ""),
    );
    if (match) return match.label;
    // DSH 没有 Default 选项，等待默认模型异步加载期间不伪造一个选中值。
    if (this.getTypeKey() === "deepseek-harness" && model === "inherit") {
      return "";
    }
    // 未知模型仍然回退到列表中的第一个真实模型，避免控件显示空 label。
    const fallback = options.find(
      (option) => option.id !== ("inherit" as AgentCodexModel),
    );
    return fallback?.label ?? this.getExternalModelDefaultLabel();
  }

  /**
   * Composer 模型控件的展示值 ── 支持 reasoning 的 runtime (当前仅 Codex)
   * 在模型名后追加当前推理深度, 例 "GPT-5.5 · medium"; 其余类型 / 模型名
   * 尚未加载 (DSH 异步默认) 时退回纯模型名。深度小写展示, 与下拉项
   * ("Medium") 同词但更贴 footer 的轻量语气。
   */
  private getComposerModelDisplayLabel(): string {
    const label = this.getCurrentExternalModelLabel();
    if (!label || !this.supportsRuntimeSetting("reasoning")) return label;
    return `${label} · ${this.getCurrentCodexReasoningLabel().toLowerCase()}`;
  }

  private getCurrentCodexReasoningLabel(): string {
    const effort =
      this.readRuntimeSetting("reasoning") ??
      useAgentSessionStore.getState().sessionMeta.settings.agentCodexReasoningEffort;
    return (
      CODEX_REASONING_OPTIONS.find((option) => option.id === effort)?.label ??
      "Medium"
    );
  }

  private getCurrentPermissionLabel(): string {
    const mode = this.readRuntimeSetting("permission");
    return this.getPermissionLabel(mode as AgentPermissionMode);
  }

  private getCurrentHarnessMode(): AgentHarnessPreset {
    const mode = this.readRuntimeSetting("mode");
    return DEEPSEEK_HARNESS_MODE_OPTIONS.some((option) => option.id === mode)
      ? (mode as AgentHarnessPreset)
      : "standard";
  }

  private getCurrentHarnessModeLabel(): string {
    const mode = this.getCurrentHarnessMode();
    return (
      this.t(
        DEEPSEEK_HARNESS_MODE_OPTIONS.find((option) => option.id === mode)
          ?.labelKey ?? "agent.mode.standard",
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
    if (this.getTypeKey() === "deepseek-harness") {
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
    } else {
      const modelSection = document.createElement("div");
      modelSection.className = "agent-thread-card__codex-settings-section";
      modelSection.textContent = this.t("agent.model.title");
      this.popover.append(modelSection);

      options.forEach((option) => {
        this.popover.append(this.createModelSettingsItem(option, current, currentProviderId));
      });
    }

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

  private createModelSettingsItem(
    option: AgentModelOption,
    current: AgentCodexModel,
    currentProviderId: string | undefined,
  ): HTMLElement {
    return createCodexSettingsItem(
      option.label,
      option.id === current
        && (option.providerId ?? "") === (currentProviderId ?? ""),
      () => {
        this.setExternalAgentModel(option);
        this.setSettingsPopoverOpen(false);
      },
    );
  }

  private renderReasoningSettings(): void {
    this.renderReasoningOptions();
  }

  private renderReasoningOptions(): void {
    const current =
      this.readRuntimeSetting("reasoning") ??
      useAgentSessionStore.getState().sessionMeta.settings.agentCodexReasoningEffort;
    CODEX_REASONING_OPTIONS.forEach((option) => {
      this.popover.append(
        createCodexSettingsItem(option.label, option.id === current, () => {
          this.writeRuntimeSetting("reasoning", option.id);
          this.setSettingsPopoverOpen(false);
        }),
      );
    });
  }

  private renderHarnessModeSettings(): void {
    const current = this.getCurrentHarnessMode();
    // DSH 模式选择器使用田字格双列布局, 每个 cell 垂直堆叠标题+副标题。
    const grid = document.createElement("div");
    grid.className = "agent-thread-card__codex-settings-grid";
    DEEPSEEK_HARNESS_MODE_OPTIONS.forEach((option) => {
      grid.append(
        createCodexSettingsItem(
          this.t(option.labelKey),
          option.id === current,
          () => {
            this.writeRuntimeSetting("mode", option.id);
            this.setSettingsPopoverOpen(false);
          },
          this.t(option.descriptionKey),
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
