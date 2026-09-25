import cursorOutlineSvg from "@/assets/cursor-outline.svg?raw";
import folderOutlineSvg from "@/assets/folder-outline.svg?raw";
import shieldAlertOutlineSvg from "@/assets/shield-alert-outline.svg?raw";
import shieldCheckOutlineSvg from "@/assets/shield-check-outline.svg?raw";
import type { AppLanguage, I18nKey, I18nParams } from "@/lib/i18n";
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
import {
  FEATURED_NOTE_MOBILE_PAGE_SIZE,
  FEATURED_NOTE_PAGE_SIZE,
  MAX_FEATURED_NOTE_CONDITIONS,
  appendFeaturedNoteIconContent,
  getFeaturedNotePage,
  getFeaturedNotePageCountForSize,
  loadAllFeaturedNoteCards,
  normalizeFeaturedNoteFilterConfig,
  readFeaturedNoteFilter,
  writeFeaturedNoteFilter,
  type FeaturedNoteCard,
  type FeaturedNoteFilter,
  type FeaturedNoteFilterConfig,
  type FeaturedNoteFilterOperator,
} from "@features/agent/thread-card/settings/featured-note-cards";
import { resolvePrimaryWorkspace } from "@features/agent/runtime/primary-workspace";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";
import { normalizeConversationWorkspaceState } from "@features/agent/runtime/conversation-workspace";
import { agent, dshIntegration, memos as memosClient, windows } from "@platform/tauri/client";
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
import {
  createCheckIcon,
  createChevronIcon,
  createPlusIcon,
  createTrashIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";
import { openNoteByMemoId } from "@features/memo/use-cases/open-by-target";

const CODEX_SETTINGS_POPOVER_WIDTH_PX = 212;
const CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX = 280;
const CODEX_SETTINGS_POPOVER_OFFSET_PX = 6;
const CODEX_SETTINGS_POPOVER_VIEWPORT_PADDING_PX = 8;
const CODEX_SETTINGS_SUBMENU_GAP_PX = 4;
const FEATURED_NOTES_MOBILE_QUERY = "(max-width: 767px)";
/** 精选笔记设置弹层与 composer 弹窗一致: fixed 定位、视口坐标、贴边留白。 */
const FEATURED_NOTES_SETTINGS_POPOVER_WIDTH_PX = 420;
const FEATURED_NOTES_SETTINGS_POPOVER_OFFSET_PX = 6;
const FEATURED_NOTES_SETTINGS_POPOVER_VIEWPORT_PADDING_PX = 8;

function createComposerWorkspaceIcon(): SVGSVGElement | null {
  const template = document.createElement("template");
  template.innerHTML = folderOutlineSvg.trim();
  const icon = template.content.firstElementChild as SVGSVGElement | null;
  if (!icon) return null;
  icon.classList.add("agent-thread-card__composer-workspace-icon");
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
  t: (key: I18nKey, params?: I18nParams) => string;
  isDestroyed: () => boolean;
  isRunning?: () => boolean;
  consumeOutsidePointer?: (event: PointerEvent) => void;
  /**
   * 点击常用笔记卡片时的动作 ── 把该笔记作为行内引用注入 composer 输入框
   * (而不是打开笔记)。由宿主 (thread card view / 独立对话) 接到
   * `ComposerController.insertMemoReference`。
   */
  onSelectFeaturedNote?: (ref: { id: string; filename: string; title: string }) => void;
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
  private readonly isRunning: () => boolean;
  private readonly consumeOutsidePointer?: (event: PointerEvent) => void;
  private readonly onSelectFeaturedNote?: (
    ref: { id: string; filename: string; title: string },
  ) => void;
  private readonly toast?: (
    kind: "success" | "error" | "info",
    message: string,
  ) => void;

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
  private localSupportedModelsTypeKey: AgentTypeKey | null = null;
  private localSupportedModels: AgentModelOption[] = [];
  private readonly unlistenCodexSettings: UnlistenFn;
  private featuredNotesRequestId = 0;
  private featuredNotesViewportCleanup: (() => void) | null = null;

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
    this.onSelectFeaturedNote = options.onSelectFeaturedNote;
    this.toast = options.toast;
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

  createEmptySettings(options: { showControls?: boolean } = {}): HTMLElement {
    const showControls = options.showControls ?? true;
    this.workspaceDisplay = null;
    this.modelButton = null;
    this.reasoningButton = null;
    this.modeButton = null;
    this.permissionButton = null;
    const empty = document.createElement("div");
    empty.className =
      "agent-thread-card__empty agent-thread-card__empty--codex-settings";

    // 控件组独立成行, 让独立对话 / 全屏能在其上方叠加 Agent 图标并整体居中；
    // 非全屏 thread card 通过 CSS 让这层保持原有的单行 flex 表现。
    empty.append(createExternalAgentEmptyIcon(this.getTypeKey()));
    if (this.getTypeKey() === "deepseek-harness") {
      const updateNotice = document.createElement("button");
      updateNotice.type = "button";
      updateNotice.className = "agent-thread-card__dsh-update-notice";
      updateNotice.hidden = true;
      updateNotice.addEventListener("click", (event) => {
        event.stopPropagation();
        void windows.openPreferences("dsh?autoUpdate=1").catch(() => undefined);
      });
      updateNotice.addEventListener("mousedown", (event) => event.stopPropagation());
      empty.append(updateNotice);
      void dshIntegration.checkUpdate().then((check) => {
        if (this.isDestroyed() || !check.updateAvailable || !check.latestVersion) return;
        updateNotice.textContent = this.t("agent.dsh.updateAvailable")
          .replace("{version}", check.latestVersion);
        updateNotice.hidden = false;
      }).catch(() => {
        // Version checks are advisory and must never affect conversation setup.
      });
    }
    if (showControls) {
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
            this.getComposerModelDisplayLabel(),
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
    }
    this.appendFeaturedNotes(empty);
    return empty;
  }

  private getCurrentNotebookId(): string | null {
    const instanceId = this.getInstanceId();
    const instance = instanceId
      ? useAgentSessionStore.getState().getInstance(instanceId)
      : undefined;
    return instance?.runtimeConfig?.notebookId
      ?? instance?.runtimeConfig?.workspaceSnapshot?.notebookId
      ?? instance?.source.notebookId
      ?? useMemoStore.getState().selectedNotebook?.id
      ?? null;
  }

  private async appendFeaturedNotes(empty: HTMLElement): Promise<void> {
    const notebookId = this.getCurrentNotebookId();
    if (!notebookId) return;

    this.featuredNotesViewportCleanup?.();
    empty.querySelector(".agent-thread-card__featured-notes")?.remove();
    const requestId = ++this.featuredNotesRequestId;
    const config = await readFeaturedNoteFilter(notebookId);
    if (this.isDestroyed() || requestId !== this.featuredNotesRequestId) return;
    try {
      const notes = await loadAllFeaturedNoteCards(
        (cursor) => memosClient.getMemos({
          notebookId,
          filter: "all",
          sort: "updatedAt",
          cursor,
          limit: 100,
        }),
        () => !this.isDestroyed() && requestId === this.featuredNotesRequestId,
        config,
      );
      if (this.isDestroyed() || requestId !== this.featuredNotesRequestId || !empty.isConnected) return;

      let panel: HTMLElement;
      panel = this.createFeaturedNotesElement(notes, config, notebookId, () => {
        panel.remove();
        void this.appendFeaturedNotes(empty);
      });
      empty.append(panel);
    } catch {
      // Featured notes are an enhancement to the empty state. A failed or
      // unavailable memo query must never block starting a conversation.
    }
  }

  private createFeaturedNotesElement(
    notes: FeaturedNoteCard[],
    config: FeaturedNoteFilterConfig,
    notebookId: string,
    onFilterChange: () => void,
  ): HTMLElement {
    const panel = document.createElement("section");
    panel.className = "agent-thread-card__featured-notes";
    panel.setAttribute("aria-label", this.t("editor.threadCard.featuredNotes"));

    let currentPage = 0;
    const mobileQuery = window.matchMedia(FEATURED_NOTES_MOBILE_QUERY);
    const getPageSize = (): number => mobileQuery.matches
      ? FEATURED_NOTE_MOBILE_PAGE_SIZE
      : FEATURED_NOTE_PAGE_SIZE;

    const navigation = document.createElement("div");
    navigation.className = "agent-thread-card__featured-notes-navigation";
    const previousButton = this.createFeaturedNotesNavigationButton(
      "‹",
      this.t("editor.threadCard.featuredNotes.previous"),
    );
    const nextButton = this.createFeaturedNotesNavigationButton(
      "›",
      this.t("editor.threadCard.featuredNotes.next"),
    );
    navigation.append(previousButton, nextButton);
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "agent-thread-card__featured-notes-settings-button";
    settingsButton.textContent = this.t("editor.threadCard.featuredNotes.settings");
    settingsButton.setAttribute("aria-expanded", "false");
    const settingsFooter = document.createElement("div");
    settingsFooter.className = "agent-thread-card__featured-notes-settings-footer";
    settingsFooter.append(settingsButton, navigation);

    const settingsPopover = this.createFeaturedNotesSettingsPopover(
      config,
      async (nextConfig) => {
        // 写入失败向上抛给 submit 处理器链; 这里先落盘成功再重建卡片列表,
        // 避免"界面已变但磁盘没变"的不一致。
        await writeFeaturedNoteFilter(notebookId, nextConfig);
        onFilterChange();
      },
    );
    /**
     * 弹层挂到 document.body 而不是设置按钮旁边 ── 与 composer 的模型/权限
     * 弹窗同款做法 (见 composer-dom-factory.ts 中 codexSettingsPopover 直接
     * append 到 body)。
     *
     * 挂在按钮旁边会有两个躲不掉的问题:
     *   1. 祖先 .agent-thread-card__body 是 overflow-y 滚动容器, 绝对定位的
     *      后代无法逃出它的裁剪, 弹层下缘会在 body 边界被切掉;
     *   2. 空状态下按钮贴着 body 底边, 下方就是 composer (z-index:1),
     *      弹层必须在更高的层叠上下文里才不会被压住。
     *
     * 放到 root 后弹层不受任何祖先裁剪与层叠影响, 再用 fixed + 视口坐标定位。
     */
    document.body.append(settingsPopover);
    /** 用 fixed 定位, 因此坐标基于视口, 与祖先滚动无关。 */
    const positionSettingsPopover = (): void => {
      if (settingsPopover.hidden || !settingsPopover.isConnected) return;
      const buttonRect = settingsButton.getBoundingClientRect();
      const popoverRect = settingsPopover.getBoundingClientRect();
      applyPopoverPosition(
        settingsPopover,
        calculateAnchoredPopoverPosition({
          anchorRect: buttonRect,
          popoverWidth: popoverRect.width || FEATURED_NOTES_SETTINGS_POPOVER_WIDTH_PX,
          popoverHeight: popoverRect.height || 0,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          padding: FEATURED_NOTES_SETTINGS_POPOVER_VIEWPORT_PADDING_PX,
          offset: FEATURED_NOTES_SETTINGS_POPOVER_OFFSET_PX,
        }),
      );
    };
    const setSettingsOpen = (open: boolean): void => {
      settingsPopover.hidden = !open;
      settingsButton.setAttribute("aria-expanded", String(open));
      if (open) {
        positionSettingsPopover();
        settingsPopover.querySelector<HTMLInputElement>("input")?.focus();
      }
    };
    settingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setSettingsOpen(settingsButton.getAttribute("aria-expanded") !== "true");
    });

    const list = document.createElement("div");
    list.className = "agent-thread-card__featured-notes-list";
    panel.append(list);
    panel.append(settingsFooter);

    const renderPage = (): void => {
      const pageSize = getPageSize();
      const pageCount = getFeaturedNotePageCountForSize(notes.length, pageSize);
      currentPage = Math.min(currentPage, pageCount - 1);
      const pageNotes = getFeaturedNotePage(notes, currentPage, pageSize);
      list.replaceChildren();
      list.dataset.cardCount = String(pageNotes.length);
      for (const note of pageNotes) {
        list.append(this.createFeaturedNoteCard(note));
      }
      previousButton.disabled = currentPage === 0;
      nextButton.disabled = currentPage >= pageCount - 1;
      previousButton.hidden = pageCount <= 1;
      nextButton.hidden = pageCount <= 1;
    };

    previousButton.addEventListener("click", (event) => {
      event.stopPropagation();
      currentPage = Math.max(0, currentPage - 1);
      renderPage();
    });
    nextButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const pageCount = getFeaturedNotePageCountForSize(notes.length, getPageSize());
      currentPage = Math.min(pageCount - 1, currentPage + 1);
      renderPage();
    });
    const handleViewportChange = (): void => renderPage();
    const handleWindowResize = (): void => {
      if (!settingsPopover.hidden) positionSettingsPopover();
    };
    const handleOutsidePointer = (event: PointerEvent): void => {
      // 弹层已挂到 document.body, 不再是 panel 的后代; 只判断 panel 会把
      // "点击弹层内部" 误判成外部点击而立刻关掉, 因此这里要把弹层一并排除。
      const target = event.target as Node;
      if (panel.contains(target) || settingsPopover.contains(target)) return;
      setSettingsOpen(false);
    };
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || settingsPopover.hidden) return;
      setSettingsOpen(false);
      settingsButton.focus();
    };
    mobileQuery.addEventListener("change", handleViewportChange);
    window.addEventListener("resize", handleWindowResize);
    document.addEventListener("pointerdown", handleOutsidePointer);
    document.addEventListener("keydown", handleEscape);
    this.featuredNotesViewportCleanup = () => {
      mobileQuery.removeEventListener("change", handleViewportChange);
      window.removeEventListener("resize", handleWindowResize);
      document.removeEventListener("pointerdown", handleOutsidePointer);
      document.removeEventListener("keydown", handleEscape);
      // 弹层挂在 document.body 上, 不随 panel 一起被移除, 必须显式清理,
      // 否则每次刷新精选笔记都会在 body 里留下一个孤儿弹层。
      settingsPopover.remove();
      this.featuredNotesViewportCleanup = null;
    };
    renderPage();
    return panel;
  }

  private createFeaturedNotesSettingsPopover(
    config: FeaturedNoteFilterConfig,
    onSave: (config: FeaturedNoteFilterConfig) => Promise<void>,
  ): HTMLDivElement {
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__featured-notes-settings";
    popover.hidden = true;
    popover.addEventListener("mousedown", (event) => event.stopPropagation());
    popover.addEventListener("click", (event) => event.stopPropagation());

    // 标题沿用 composer 模型/权限弹窗的同一套标题样式与位置 (见 renderPopover)。
    const title = document.createElement("div");
    title.className = "agent-thread-card__codex-settings-title";
    title.textContent = this.t("editor.threadCard.featuredNotes.settingsTitle");
    popover.append(title);

    const form = document.createElement("form");

    // 每行是一条独立条件, 行间是并集关系。行的增删只操作 DOM, 保存时统一从
    // DOM 读回 —— 避免再维护一份与 DOM 平行的状态。
    const rows = document.createElement("div");
    rows.className = "agent-thread-card__featured-notes-settings-rows";
    form.append(rows);

    const actions = document.createElement("div");
    actions.className = "agent-thread-card__featured-notes-settings-actions";
    const addConditionButton = document.createElement("button");
    addConditionButton.type = "button";
    addConditionButton.className = "agent-thread-card__featured-notes-settings-add-condition";
    addConditionButton.append(createPlusIcon(), document.createTextNode(
      this.t("editor.threadCard.featuredNotes.addCondition"),
    ));
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = this.t("common.cancel");
    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "agent-thread-card__featured-notes-settings-save";
    saveButton.textContent = this.t("common.save");
    actions.append(addConditionButton, cancelButton, saveButton);
    form.append(actions);
    popover.append(form);

    /** 从当前 DOM 读回全部条件 (含未归一化的原始输入)。 */
    const readConditionsFromRows = (): FeaturedNoteFilter[] =>
      Array.from(rows.querySelectorAll<HTMLElement>(
        ".agent-thread-card__featured-notes-settings-row",
      )).map((row) => ({
        key: row.querySelector<HTMLInputElement>('[name="key"]')?.value ?? "",
        operator: (row.querySelector<HTMLInputElement>('[name="operator"]')?.value
          ?? "equals") as FeaturedNoteFilterOperator,
        value: row.querySelector<HTMLInputElement>('[name="value"]')?.value ?? "",
      }));

    const syncConditionControls = (): void => {
      const rowCount = rows.childElementCount;
      // 只有一条条件时不允许删除 —— 零条件会让常用笔记永远为空。
      for (const remove of rows.querySelectorAll<HTMLButtonElement>(
        ".agent-thread-card__featured-notes-settings-remove-condition",
      )) {
        remove.hidden = rowCount <= 1;
      }
      // 达到上限后禁用"添加条件", 避免弹层无限变长。
      const atLimit = rowCount >= MAX_FEATURED_NOTE_CONDITIONS;
      addConditionButton.disabled = atLimit;
      addConditionButton.title = atLimit
        ? this.t("editor.threadCard.featuredNotes.addConditionLimit")
        : "";
    };

    const appendConditionRow = (condition: FeaturedNoteFilter): void => {
      const row = this.createFeaturedNotesConditionRow(condition, {
        onRemove: () => {
          row.remove();
          syncConditionControls();
        },
      });
      rows.append(row);
      syncConditionControls();
    };

    const initialConditions = normalizeFeaturedNoteFilterConfig(config).conditions;
    for (const condition of initialConditions) appendConditionRow(condition);

    addConditionButton.addEventListener("click", () => {
      if (rows.childElementCount >= MAX_FEATURED_NOTE_CONDITIONS) return;
      // 新行给空值, 由用户填写; 保存时 normalize 会丢弃未填完的行。
      appendConditionRow({ key: "", operator: "equals", value: "" });
      rows.lastElementChild
        ?.querySelector<HTMLInputElement>('[name="key"]')
        ?.focus();
    });

    cancelButton.addEventListener("click", () => {
      popover.hidden = true;
      popover.parentElement
        ?.querySelector<HTMLButtonElement>(".agent-thread-card__featured-notes-settings-button")
        ?.setAttribute("aria-expanded", "false");
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      // 落盘走 IPC (笔记本文件夹内的 system.json), 因此是异步的。提交期间禁用
      // 保存按钮, 避免重复提交; 失败时保留弹层并提示, 让用户可以重试。
      if (saveButton.disabled) return;
      saveButton.disabled = true;
      const clearError = (): void => {
        form.querySelector(".agent-thread-card__featured-notes-settings-error")?.remove();
      };
      clearError();
      onSave({ conditions: readConditionsFromRows() }).catch(() => {
        // 保存失败必须让用户看到: 静默失败会让人以为配置已经生效。
        const error = document.createElement("div");
        error.className = "agent-thread-card__featured-notes-settings-error";
        error.setAttribute("role", "alert");
        error.textContent = this.t("editor.threadCard.featuredNotes.saveFailed");
        form.append(error);
      }).finally(() => {
        if (popover.isConnected) saveButton.disabled = false;
      });
    });
    return popover;
  }

  /**
   * 构建一行筛选条件: [key 输入] [条件下拉] [value 输入] [删除]。
   *
   * 行的三个输入都是该行私有的, 因此下拉的展开状态、选项列表都随行创建, 行与行
   * 之间互不影响。
   */
  private createFeaturedNotesConditionRow(
    condition: FeaturedNoteFilter,
    handlers: { onRemove: () => void },
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "agent-thread-card__featured-notes-settings-row";

    // 字段不显示独立标签, 改用 placeholder 提示。仍用 <label> 包裹以保留
    // 点击聚焦与无障碍关联。
    const keyField = document.createElement("label");
    keyField.className = "agent-thread-card__featured-notes-settings-field-key";
    const keyInput = document.createElement("input");
    keyInput.name = "key";
    keyInput.value = condition.key;
    keyInput.required = true;
    keyInput.autocomplete = "off";
    keyInput.placeholder = this.t("editor.threadCard.featuredNotes.propertyKeyPlaceholder");
    keyField.append(keyInput);

    const operatorField = document.createElement("label");
    operatorField.className = "agent-thread-card__featured-notes-settings-field-operator";
    const operatorInput = document.createElement("input");
    operatorInput.type = "hidden";
    operatorInput.name = "operator";
    operatorInput.value = condition.operator;
    const operatorSelect = document.createElement("div");
    operatorSelect.className = "agent-thread-card__featured-notes-operator-select";
    const operatorTrigger = document.createElement("button");
    operatorTrigger.type = "button";
    operatorTrigger.className = "agent-thread-card__featured-notes-operator-trigger";
    operatorTrigger.setAttribute("aria-haspopup", "listbox");
    operatorTrigger.setAttribute("aria-expanded", "false");
    const operatorValue = document.createElement("span");
    const operatorChevron = createChevronIcon("down");
    operatorTrigger.append(operatorValue, operatorChevron);
    const operatorMenu = document.createElement("div");
    operatorMenu.className = "agent-thread-card__featured-notes-operator-menu";
    operatorMenu.setAttribute("role", "listbox");
    operatorMenu.hidden = true;
    const operators = [
      ["equals", "editor.threadCard.featuredNotes.operator.equals"],
      ["contains", "editor.threadCard.featuredNotes.operator.contains"],
    ] as const;
    const operatorButtons: HTMLButtonElement[] = [];
    const setOperatorOpen = (open: boolean): void => {
      operatorMenu.hidden = !open;
      operatorTrigger.setAttribute("aria-expanded", String(open));
      operatorSelect.dataset.state = open ? "open" : "closed";
    };
    const selectOperator = (value: FeaturedNoteFilter["operator"]): void => {
      // 下拉里已不再提供 excludes。历史配置可能仍存着它, 若只回落显示而不归一化,
      // 隐藏域会继续保留 excludes, 与用户看到的"等于"不一致并被原样写回。
      const selected = operators.find(([candidate]) => candidate === value) ?? operators[0];
      operatorInput.value = selected[0];
      operatorValue.textContent = this.t(selected[1]);
      for (const button of operatorButtons) {
        const isSelected = button.dataset.value === selected[0];
        button.dataset.selected = String(isSelected);
        button.setAttribute("aria-selected", String(isSelected));
        button.querySelector(".agent-thread-card__featured-notes-operator-check")
          ?.classList.toggle("is-visible", isSelected);
      }
      setOperatorOpen(false);
    };
    for (const [value, labelKey] of operators) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.value = value;
      option.setAttribute("role", "option");
      const optionText = document.createElement("span");
      optionText.textContent = this.t(labelKey);
      const check = createCheckIcon();
      check.classList.add("agent-thread-card__featured-notes-operator-check");
      option.append(optionText, check);
      option.addEventListener("click", () => selectOperator(value));
      operatorButtons.push(option);
      operatorMenu.append(option);
    }
    operatorTrigger.addEventListener("click", () => {
      setOperatorOpen(operatorTrigger.getAttribute("aria-expanded") !== "true");
    });
    operatorTrigger.addEventListener("keydown", (event) => {
      const currentIndex = operators.findIndex(([value]) => value === operatorInput.value);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = (currentIndex + direction + operators.length) % operators.length;
        selectOperator(operators[nextIndex][0]);
        operatorTrigger.focus();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        setOperatorOpen(false);
      }
    });
    operatorSelect.append(operatorInput, operatorTrigger, operatorMenu);
    operatorField.append(operatorSelect);
    selectOperator(condition.operator);
    row.addEventListener("pointerdown", (event) => {
      if (!operatorSelect.contains(event.target as Node)) setOperatorOpen(false);
    });

    const valueField = document.createElement("label");
    valueField.className = "agent-thread-card__featured-notes-settings-field-value";
    const valueInput = document.createElement("input");
    valueInput.name = "value";
    valueInput.value = condition.value;
    valueInput.required = true;
    valueInput.autocomplete = "off";
    valueInput.placeholder = this.t("editor.threadCard.featuredNotes.propertyValuePlaceholder");
    valueField.append(valueInput);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "agent-thread-card__featured-notes-settings-remove-condition";
    removeButton.setAttribute(
      "aria-label",
      this.t("editor.threadCard.featuredNotes.removeCondition"),
    );
    removeButton.title = this.t("editor.threadCard.featuredNotes.removeCondition");
    removeButton.append(createTrashIcon());
    removeButton.addEventListener("click", () => handlers.onRemove());

    row.append(keyField, operatorField, valueField, removeButton);
    return row;
  }

  private createFeaturedNotesNavigationButton(
    text: string,
    label: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-thread-card__featured-notes-nav";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    return button;
  }

  private createFeaturedNoteCard(note: FeaturedNoteCard): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "agent-thread-card__featured-note";
    card.setAttribute("aria-label", [note.name, note.title, note.description].filter(Boolean).join(" — "));

    const icon = document.createElement("span");
    icon.className = "agent-thread-card__featured-note-icon";
    icon.setAttribute("aria-hidden", "true");
    appendFeaturedNoteIconContent(icon, note.icon);

    const content = document.createElement("span");
    content.className = "agent-thread-card__featured-note-content";
    const title = document.createElement("span");
    title.className = "agent-thread-card__featured-note-title";
    title.textContent = note.name ? `${note.name} › ${note.title}` : note.title;
    const description = document.createElement("span");
    description.className = "agent-thread-card__featured-note-description";
    description.textContent = note.description;
    content.append(title, description);
    // 图标独占首行 (原先这一行右侧还有个「试试」按钮, 已移除)。
    card.append(icon, content);

    card.addEventListener("click", (event) => {
      event.stopPropagation();
      // 点击 = 把这条笔记作为行内引用追加到 composer 输入框 (而不是打开笔记)。
      // 宿主未接该回调时 (例如独立的设置预览) 退化为打开笔记。
      if (this.onSelectFeaturedNote) {
        this.onSelectFeaturedNote({
          id: note.id,
          filename: note.title,
          title: note.title,
        });
        return;
      }
      void openNoteByMemoId(note.id);
    });
    card.addEventListener("mousedown", (event) => event.stopPropagation());
    return card;
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
      "",
      (anchor) => this.toggleWorkspacePopover(anchor),
    );
    button.querySelector(".agent-thread-card__composer-workspace-value")?.remove();
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
      "",
      (anchor) => this.toggleSettingsPopover("permission", anchor),
    );
    button.classList.replace(
      "agent-thread-card__composer-workspace",
      "agent-thread-card__composer-permission",
    );
    const value = button.querySelector<HTMLElement>(
      ".agent-thread-card__composer-workspace-value",
    );
    value?.remove();
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
    const currentIcon = this.composerWorkspaceButton.querySelector(
      ".agent-thread-card__composer-workspace-icon",
    );
    const nextIcon = createComposerWorkspaceIcon();
    const chevron = this.composerWorkspaceButton.querySelector(
      ".agent-thread-card__empty-control-chevron",
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
      ".agent-thread-card__empty-control-chevron",
    );
    currentIcon?.remove();
    if (nextIcon && chevron) {
      this.composerPermissionButton.insertBefore(nextIcon, chevron);
    }
    const value = this.getCurrentPermissionLabel();
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
        this.getComposerModelDisplayLabel(),
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
    this.workspacePage = "access";
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
    this.popover.classList.toggle(
      "agent-thread-card__codex-settings-popover--has-submenu",
      this.getTypeKey() === "codex" && kind === "model",
    );
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
    this.popover.classList.remove(
      "agent-thread-card__codex-settings-popover--has-submenu",
    );
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
            readOnlyOptions,
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
   * 第二页 ── 仓库列表, 可增删。 这里编辑的是当前笔记本 `.flowix/agent.json`
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
    const config = useAgentAccessStore.getState().config;
    const instance = this.getInstanceId()
      ? useAgentSessionStore.getState().getInstance(this.getInstanceId()!)
      : undefined;
    const runtimeConfig = instance?.runtimeConfig;
    const memoState = useMemoStore.getState();
    const configuredNotebookId = runtimeConfig?.notebookId;
    const notebook =
      (configuredNotebookId
        ? memoState.notebooks.find((item) => item.id === configuredNotebookId)
        : null) ?? memoState.selectedNotebook;
    const notebookId = configuredNotebookId ?? notebook?.id;
    const files = resolveNotebookAgentFiles(
      config,
      useAgentAccessStore.getState().notebookConfigs,
      notebookId,
    );
    return (files?.folders ?? []).map((path) => {
      const key = normalizeWorkspacePath(path).toLowerCase();
      const entry = config.entries.find(
        (item) => normalizeWorkspacePath(item.path).toLowerCase() === key,
      );
      const trimmed = path.replace(/[\\/]+$/, "");
      return {
        path,
        name: entry?.name?.trim() || trimmed.split(/[\\/]/).pop() || trimmed,
        // 全局 entries 里已经没有这条 path 时按缺失处理, 但行仍然显示, 让用户
        // 能把它从列表里删掉, 而不是留一条看不见的脏数据。
        missing: entry ? entry.missing === true : true,
      };
    });
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
    const result = await useAgentAccessStore.getState().addFolderFromPicker();
    if (!result.ok) {
      if (result.code === "already-tracked") {
        this.toast?.("error", this.t("agent.access.alreadyTracked"));
      } else if (result.code === "save-failed") {
        this.toast?.("error", this.t("agent.access.saveFailed"));
      }
      return;
    }
    const notebookId = this.getRepositoryScopeNotebookId();
    if (!notebookId) {
      // 没有笔记本作用域时, 全局授权条目仍然保留, 但没有 add-dir 列表可写。
      this.rerenderRepositories();
      return;
    }
    // picker 返回前已经 loadInitial 过一次, 所以要用最新 store 状态解析, 而不
    // 是复用这次渲染的闭包快照。
    const latest = useAgentAccessStore.getState();
    const latestFiles = resolveNotebookAgentFiles(
      latest.config,
      latest.notebookConfigs,
      notebookId,
    );
    const key = normalizeWorkspacePath(result.entry.path).toLowerCase();
    if (
      (latestFiles?.folders ?? []).some(
        (path) => normalizeWorkspacePath(path).toLowerCase() === key,
      )
    ) {
      this.toast?.("info", this.t("agent.access.folderExists"));
      this.rerenderRepositories();
      return;
    }
    const saved = await latest.setDefaultFiles(notebookId, {
      folders: [...(latestFiles?.folders ?? []), result.entry.path],
      notebooks: latestFiles?.notebooks ?? [],
    });
    if (!saved) {
      this.toast?.("error", this.t("agent.access.saveFailed"));
      return;
    }
    this.rerenderRepositories();
  }

  private async removeRepository(path: string, name: string): Promise<void> {
    const notebookId = this.getRepositoryScopeNotebookId();
    if (!notebookId) return;
    const state = useAgentAccessStore.getState();
    const files = resolveNotebookAgentFiles(state.config, state.notebookConfigs, notebookId);
    const nextFolders = (files?.folders ?? []).filter((item) => item !== path);
    const saved = await state.setDefaultFiles(notebookId, {
      folders: nextFolders,
      notebooks: files?.notebooks ?? [],
    });
    if (!saved) {
      this.toast?.("error", this.t("agent.access.saveFailed"));
      return;
    }
    this.toast?.("success", this.t("agent.access.folderDeleted", { name }));
    this.rerenderRepositories();
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
    const runtimeConfig = instance?.runtimeConfig;
    const state = normalizeConversationWorkspaceState(runtimeConfig);
    const snapshot = state?.applied ?? state?.desired ?? runtimeConfig?.workspaceSnapshot;
    const configuredNotebookId = runtimeConfig?.notebookId ?? snapshot?.notebookId;
    if (configuredNotebookId) return configuredNotebookId;
    return useMemoStore.getState().selectedNotebook?.id ?? undefined;
  }

  schedulePosition(): void {
    if (!this.open || this.popover.hidden || this.isDestroyed()) return;
    if (this.positionFrame !== null) return;
    this.positionFrame = window.requestAnimationFrame(() => {
      this.positionFrame = null;
      this.positionPopover();
      this.positionOpenCodexSubmenus();
    });
  }

  dispose(): void {
    this.featuredNotesRequestId += 1;
    this.featuredNotesViewportCleanup?.();
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

  // Returns the legacy inherit option label when a real default model is
  // available. Codex now renders the actual default model instead of this
  // synthetic label; DeepSeek Harness deliberately does not use inherit.
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
    const selection = this.resolveCurrentSelection();
    const modelOptions = this.getLoadedModelOptions();
    const inheritLabel = this.getTypeKey() === "deepseek-harness"
      ? ""
      : this.getExternalModelDefaultLabel();
    const showInheritOption =
      this.getTypeKey() !== "deepseek-harness" && this.getTypeKey() !== "codex";
    const options: AgentModelOption[] = [
      ...(showInheritOption && inheritLabel
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
    if (fallback) return fallback.label;
    return this.getTypeKey() === "codex"
      ? ""
      : this.getExternalModelDefaultLabel();
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

    // Codex 的 reasoning effort 与模型强相关，使用「模型 → 深度」的
    // 二级菜单表达这一层级关系。其它 runtime 仍保持原来的扁平模型列表，
    // 避免把 Codex 专属的推理设置带到 Claude / OpenCode 等 Agent。
    if (this.getTypeKey() === "codex") {
      const modelSection = document.createElement("div");
      modelSection.className = "agent-thread-card__codex-settings-section";
      modelSection.textContent = this.t("agent.model.title");
      this.popover.append(modelSection);

      options.forEach((option) => {
        this.popover.append(
          this.createCodexModelSubmenu(option, current, currentProviderId),
        );
      });
      return;
    }

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

  /** Codex-only model → reasoning effort submenu. */
  private createCodexModelSubmenu(
    option: AgentModelOption,
    current: AgentCodexModel,
    currentProviderId: string | undefined,
  ): HTMLElement {
    const group = document.createElement("div");
    group.className = "agent-thread-card__codex-settings-model-group";
    group.dataset.codexModelSubmenuGroup = "true";

    const isCurrentModel =
      option.id === current &&
      (option.providerId ?? "") === (currentProviderId ?? "");
    const trigger = this.createCodexModelSubmenuTrigger(
      option,
      isCurrentModel,
      group,
    );
    const submenu = document.createElement("div");
    submenu.className = "agent-thread-card__codex-settings-submenu";
    submenu.setAttribute("role", "menu");
    submenu.id = `codex-model-depth-${Math.random().toString(36).slice(2)}`;
    trigger.setAttribute("aria-controls", submenu.id);
    trigger.setAttribute("aria-expanded", "false");

    const currentReasoning =
      this.readRuntimeSetting("reasoning") ??
      useAgentSessionStore.getState().sessionMeta.settings.agentCodexReasoningEffort;
    CODEX_REASONING_OPTIONS.forEach((reasoning) => {
      submenu.append(
        createCodexSettingsItem(
          reasoning.label,
          reasoning.id === currentReasoning,
          () => {
            // Depth selection is a complete Codex model selection: keep the
            // selected model and update the depth before closing the picker.
            this.setExternalAgentModel(option);
            this.writeRuntimeSetting("reasoning", reasoning.id);
            this.setSettingsPopoverOpen(false);
          },
        ),
      );
    });

    group.append(trigger, submenu);

    let closeTimer: number | null = null;
    const cancelClose = (): void => {
      if (closeTimer === null) return;
      window.clearTimeout(closeTimer);
      closeTimer = null;
    };
    const openSubmenu = (): void => {
      cancelClose();
      this.popover
        .querySelectorAll<HTMLElement>(
          ".agent-thread-card__codex-settings-model-group",
        )
        .forEach((item) => {
          if (item !== group) this.setCodexModelSubmenuExpanded(item, false);
        });
      this.setCodexModelSubmenuExpanded(group, true);
    };
    const scheduleClose = (): void => {
      cancelClose();
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        this.setCodexModelSubmenuExpanded(group, false);
      }, 160);
    };
    group.addEventListener("mouseenter", openSubmenu);
    group.addEventListener("mouseleave", scheduleClose);
    group.addEventListener("focusin", openSubmenu);
    group.addEventListener("focusout", (event) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node) || !group.contains(nextTarget)) {
        scheduleClose();
      }
    });
    return group;
  }

  private positionOpenCodexSubmenus(): void {
    this.popover
      .querySelectorAll<HTMLElement>(
        '.agent-thread-card__codex-settings-model-group[data-submenu-open="true"]',
      )
      .forEach((group) => {
        const submenu = group.querySelector<HTMLElement>(
          ".agent-thread-card__codex-settings-submenu",
        );
        if (submenu) this.positionCodexSubmenu(group, submenu);
      });
  }

  private positionCodexSubmenu(
    group: HTMLElement,
    submenu: HTMLElement,
  ): void {
    const trigger = group.querySelector<HTMLElement>(
      ".agent-thread-card__codex-settings-item--submenu",
    );
    if (!trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    const groupRect = group.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    const padding = CODEX_SETTINGS_POPOVER_VIEWPORT_PADDING_PX;
    const width = submenuRect.width || CODEX_SETTINGS_POPOVER_WIDTH_PX;
    const height = submenuRect.height || CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const rightCandidate = triggerRect.right + CODEX_SETTINGS_SUBMENU_GAP_PX;
    const canOpenRight =
      rightCandidate + width <= viewportWidth - padding;
    const preferredLeft = canOpenRight
      ? rightCandidate
      : triggerRect.left - CODEX_SETTINGS_SUBMENU_GAP_PX - width;
    const maxLeft = Math.max(padding, viewportWidth - padding - width);
    const left = Math.min(Math.max(preferredLeft, padding), maxLeft);
    const maxTop = Math.max(padding, viewportHeight - padding - height);
    const top = Math.min(Math.max(triggerRect.top, padding), maxTop);

    submenu.style.left = `${left - groupRect.left}px`;
    submenu.style.top = `${top - groupRect.top}px`;
    submenu.dataset.submenuSide = canOpenRight ? "right" : "left";
  }

  private createCodexModelSubmenuTrigger(
    option: AgentModelOption,
    selected: boolean,
    group: HTMLElement,
  ): HTMLElement {
    const trigger = createCodexSettingsItem(
      option.label,
      selected,
      () => {
        this.popover
          .querySelectorAll<HTMLElement>(
            ".agent-thread-card__codex-settings-model-group",
          )
        .forEach((item) => {
          if (item !== group) this.setCodexModelSubmenuExpanded(item, false);
        });
        this.setExternalAgentModel(option);
        this.setCodexModelSubmenuExpanded(group, true);
      },
    );
    trigger.classList.add("agent-thread-card__codex-settings-item--submenu");
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.append(createChevronIcon("right"));
    return trigger;
  }

  private setCodexModelSubmenuExpanded(
    group: HTMLElement,
    expanded: boolean,
  ): void {
    const trigger = group.querySelector<HTMLElement>(
      ".agent-thread-card__codex-settings-item--submenu",
    );
    const submenu = group.querySelector<HTMLElement>(
      ".agent-thread-card__codex-settings-submenu",
    );
    if (!trigger || !submenu) return;
    trigger.setAttribute("aria-expanded", expanded ? "true" : "false");
    group.dataset.submenuOpen = expanded ? "true" : "false";
    if (expanded) {
      window.requestAnimationFrame(() => {
        if (group.isConnected && submenu.isConnected) {
          this.positionCodexSubmenu(group, submenu);
        }
      });
    }
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
    this.positionOpenCodexSubmenus();
  }
}
