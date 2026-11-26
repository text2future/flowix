import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentCodexServiceTier,
  AgentPermissionMode,
  AgentRuntimeConfig,
  AgentId,
  AgentTypeKey,
  FilesConfig,
  RuntimeConfig,
  WorkspaceSnapshot,
} from "@/types/agent";
import type { I18nKey } from "@/lib/i18n";
import {
  CODEX_APP_SERVER_ACCESS_OPTIONS,
  SHARED_ACCESS_OPTIONS,
} from "@features/agent/config/codex-options";
import { resolvePrimaryWorkspace } from "@features/agent/runtime/primary-workspace";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";
import { normalizeAgentId } from "@/lib/agent-types";

export type AgentRuntimeSettingKind =
  | "model"
  | "reasoning"
  | "mode"
  | "permission";

export interface AgentAccessOption {
  id: AgentPermissionMode;
  /** English fallback label; rendered directly when `labelKey` is absent. */
  label: string;
  /** Preferred i18n label key; translated by the UI before display. */
  labelKey?: I18nKey;
}

export interface AgentModeOption {
  id: string;
  label: string;
  labelKey?: I18nKey;
  descriptionKey?: I18nKey;
}

export const DEEPSEEK_HARNESS_MODE_OPTIONS = [
  { id: "standard", label: "Standard", labelKey: "agent.mode.standard", descriptionKey: "agent.mode.standard.description" },
  { id: "code", label: "Code", labelKey: "agent.mode.code", descriptionKey: "agent.mode.code.description" },
  { id: "minimal", label: "Minimal", labelKey: "agent.mode.minimal", descriptionKey: "agent.mode.minimal.description" },
  { id: "cordis", label: "Cordis", labelKey: "agent.mode.cordis", descriptionKey: "agent.mode.cordis.description" },
] as const satisfies readonly AgentModeOption[];

export const PI_MODE_OPTIONS = [
  { id: "writing", label: "Writing", labelKey: "agent.mode.writing" },
  { id: "code", label: "Code", labelKey: "agent.mode.piCode" },
] as const satisfies readonly AgentModeOption[];

export interface BuildAgentRuntimeConfigInput {
  typeKey: AgentTypeKey;
  /** 当前笔记本路径 (= systemReminderDirectory), always used as cwd. */
  notebookPath?: string;
  permissionMode: AgentPermissionMode;
  codexModel: AgentCodexModel;
  codexReasoningEffort: AgentCodexReasoningEffort;
  codexServiceTier?: AgentCodexServiceTier;
  /** Shared Pi extension mode; legacy conversation values are ignored. */
  piCodeMode?: boolean;
  instanceRuntimeConfig?: RuntimeConfig;
  /** Notebook-local add-dir files; retained as a compatibility input shape. */
  defaultFiles?: FilesConfig;
  /** Conversation-scoped path snapshot; takes precedence over live inputs. */
  workspaceSnapshot?: WorkspaceSnapshot | null;
}

export interface AgentRuntimeSpec {
  typeKey: AgentTypeKey;
  emptySettings: readonly AgentRuntimeSettingKind[];
  accessOptions: readonly AgentAccessOption[];
  modeOptions: readonly AgentModeOption[];
  workspace: {
    selectBeforeFirstRun: boolean;
    /** Whether selection remains editable while the current run is active. */
    switchWhileRunning: boolean;
    switchBetweenRuns: boolean;
    switchRequiresRuntimeRestart: boolean;
    preservesConversationSession: boolean;
  };
  buildRuntimeConfig: (
    input: Omit<BuildAgentRuntimeConfigInput, "typeKey"> & {
      cwd?: string;
      workspacePaths: string[];
    },
  ) => AgentRuntimeConfig;
}

// Hermes 与其他 agent 共用同一份 3 档配置 (完全访问 / 空间读写 / 只读)。
const HERMES_ACCESS_OPTIONS = SHARED_ACCESS_OPTIONS;

// DSH 的 SDK 沙箱只支持 read-only / workspace-write / danger-full-access 三档
// (没有 yolo); inherit / 未知值归一化到 danger-full-access (与其他 agent 统一默认)。
// 标签与所有 agent 统一为完全访问 / 空间读写 / 只读, 不再走 i18n labelKey。
const DSH_ACCESS_OPTIONS: readonly AgentAccessOption[] = [
  { id: "danger-full-access", label: "完全访问" },
  { id: "workspace-write", label: "空间读写" },
  { id: "read-only", label: "只读" },
];

const CLAUDE_ACCESS_OPTIONS = SHARED_ACCESS_OPTIONS;

export function normalizeCodexPermissionMode(
  mode: AgentPermissionMode | undefined,
): AgentPermissionMode {
  return mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "danger-full-access"
    ? mode
    : "danger-full-access";
}

/**
 * DeepSeek Harness 专属归一化: `yolo` 是 Codex CLI 的语义, DSH SDK 沙箱
 * 不存在该档位; `inherit` / 未知值回落到 `danger-full-access` ── 与所有
 * agent 默认完全访问一致。
 */
export function normalizeDshPermissionMode(
  mode: AgentPermissionMode | undefined,
): AgentPermissionMode {
  return mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "danger-full-access"
    ? mode
    : "danger-full-access";
}

const AGENT_RUNTIME_SPECS: Record<AgentId, AgentRuntimeSpec> = {
  codex: {
    typeKey: "codex",
    emptySettings: ["model", "reasoning", "permission"],
    accessOptions: CODEX_APP_SERVER_ACCESS_OPTIONS,
    modeOptions: [],
    // The notebook owns cwd; conversation snapshots freeze it at first send.
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: true },
    buildRuntimeConfig: ({
      cwd,
      workspacePaths,
      permissionMode,
      codexModel,
      codexReasoningEffort,
      codexServiceTier,
    }) => ({
      codex: {
        cwd,
        workspacePaths,
        permissionMode: normalizeCodexPermissionMode(permissionMode),
        model: codexModel,
        reasoningEffort: codexReasoningEffort,
        ...(codexServiceTier ? { serviceTier: codexServiceTier } : {}),
      },
    }),
  },
  claudecode: {
    typeKey: "claudecode",
    emptySettings: ["model", "permission"],
    accessOptions: CLAUDE_ACCESS_OPTIONS,
    modeOptions: [],
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: false },
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode, codexModel }) => ({
      // 统一归一化: 持久化或历史数据中的 yolo 视作 danger-full-access,
      // 与 UI 不再提供 yolo 选项保持一致。
      claude: { cwd, workspacePaths, permissionMode: normalizeCodexPermissionMode(permissionMode), model: codexModel },
    }),
  },
  hermes: {
    typeKey: "hermes",
    emptySettings: ["permission"],
    accessOptions: HERMES_ACCESS_OPTIONS,
    modeOptions: [],
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: false },
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode }) => ({
      hermes: { cwd, workspacePaths, permissionMode },
    }),
  },
  opencode: {
    typeKey: "opencode",
    emptySettings: ["model", "permission"],
    accessOptions: SHARED_ACCESS_OPTIONS,
    modeOptions: [],
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: false },
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode, codexModel }) => ({
      opencode: { cwd, workspacePaths, permissionMode, model: codexModel },
    }),
  },
  pi: {
    typeKey: "pi",
    // Pi RPC has no sandbox prompt, but its built-in tools can be selected with
    // --tools. The permission mode maps to the available tool set in the host;
    // codemode follows the shared Pi preference and is changed in Pi preferences.
    emptySettings: ["model", "permission"],
    accessOptions: SHARED_ACCESS_OPTIONS,
    modeOptions: PI_MODE_OPTIONS,
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: true, preservesConversationSession: true },
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode, codexModel }) => ({
      pi: {
        cwd,
        workspacePaths,
        permissionMode: normalizeCodexPermissionMode(permissionMode),
        model: codexModel,
        codeMode: true,
      },
    }),
  },
  dsh: {
    typeKey: "dsh",
    // DSH follows the native llm-pi-ai provider configuration but allows a per-card
    // model override (runtime_config.deepseek_harness.model, "inherit" falls
    // back to the global dsh-settings model). Its tool Agent preset and
    // per-card permission mode are configurable here as well.
    emptySettings: ["model", "mode", "permission"],
    accessOptions: DSH_ACCESS_OPTIONS,
    modeOptions: DEEPSEEK_HARNESS_MODE_OPTIONS,
    // Harness session resume restores the session's original cwd. Until DSH
    // exposes a resume-with-cwd capability, changing workspace would be
    // misleading, even if Flowix can restart the transport.
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: true, preservesConversationSession: true },
    buildRuntimeConfig: ({
      cwd,
      workspacePaths,
      permissionMode,
      codexModel,
    }) => ({
      deepseekHarness: {
        cwd,
        workspacePaths,
        permissionMode: normalizeDshPermissionMode(permissionMode),
        model: codexModel,
        providerId: undefined,
      },
    }),
  },
};

export function getAgentRuntimeSpec(typeKey: AgentTypeKey): AgentRuntimeSpec {
  return AGENT_RUNTIME_SPECS[normalizeAgentId(typeKey) ?? "codex"];
}

export function supportsAgentRuntimeSetting(
  typeKey: AgentTypeKey,
  kind: AgentRuntimeSettingKind,
): boolean {
  return getAgentRuntimeSpec(typeKey).emptySettings.includes(kind);
}

export function supportsAgentEmptySettings(typeKey: AgentTypeKey): boolean {
  // files 控件已移除 (主空间由侧边栏资料列表决定), 空状态设置区只看
  // model / mode / permission / reasoning 是否有可配置项。
  const spec = getAgentRuntimeSpec(typeKey);
  return spec.emptySettings.length > 0;
}

export function getAgentAccessOptions(
  typeKey: AgentTypeKey,
): readonly AgentAccessOption[] {
  return getAgentRuntimeSpec(typeKey).accessOptions;
}

export function getAgentModeOptions(
  typeKey: AgentTypeKey,
): readonly AgentModeOption[] {
  return getAgentRuntimeSpec(typeKey).modeOptions;
}

export function buildAgentRuntimeConfig({
  typeKey,
  notebookPath,
  permissionMode,
  codexModel,
  codexReasoningEffort,
  codexServiceTier,
  piCodeMode,
  instanceRuntimeConfig,
  defaultFiles,
  workspaceSnapshot,
}: BuildAgentRuntimeConfigInput): AgentRuntimeConfig {
  // cwd is always the selected notebook path.  `defaultFiles.folders` are
  // notebook add-dir roots from local.db; they are sent as
  // workspacePaths and are kept separate from cwd.  Once a run starts, the
  // persisted workspace snapshot remains authoritative for later turns.
  const frozenPaths = (workspaceSnapshot?.workspacePaths ?? [])
    .map(normalizeWorkspacePath)
    .filter(Boolean);
  const folderPaths = (defaultFiles?.folders ?? [])
    .map(normalizeWorkspacePath)
    .filter(Boolean);
  const notebookPathNorm = normalizeWorkspacePath(notebookPath) || undefined;

  const resolvedPrimary = resolvePrimaryWorkspace({ defaultFiles, notebookPath });
  const livePrimary = resolvedPrimary.kind === "empty" ? undefined : resolvedPrimary.path;
  const snapshotPrimary = normalizeWorkspacePath(workspaceSnapshot?.cwd) || undefined;
  const primaryWorkspace = snapshotPrimary ?? livePrimary;
  const workspacePaths = workspaceSnapshot
    ? Array.from(new Set(frozenPaths.filter((path) => path !== primaryWorkspace)))
    : Array.from(new Set(folderPaths.filter((path) => path !== notebookPathNorm)));

  // DSH 与其他 agent 共用 danger-full-access 默认 (完全访问), 不再单独
  // 走 workspace-write; instance 配置仍优先于全局 / 类型默认。
  const instancePermission = instanceRuntimeConfig?.access?.sandbox;
  const effectivePermissionMode = instancePermission ?? permissionMode;
  const effectiveModel = instanceRuntimeConfig?.model?.key ??
    (typeKey === "pi" ? undefined : codexModel);
  const effectiveReasoningEffort =
    instanceRuntimeConfig?.reasoningEffort ?? codexReasoningEffort;
  const runtimeConfig = getAgentRuntimeSpec(typeKey).buildRuntimeConfig({
    cwd: primaryWorkspace,
    workspacePaths,
    permissionMode: effectivePermissionMode,
    codexModel: effectiveModel ?? "",
    codexReasoningEffort: effectiveReasoningEffort,
    codexServiceTier:
      instanceRuntimeConfig?.serviceTier ?? codexServiceTier,
  });
  runtimeConfig.notebookId = workspaceSnapshot?.notebookId ?? instanceRuntimeConfig?.notebookId;
  if (normalizeAgentId(typeKey) === "dsh" && runtimeConfig.deepseekHarness) {
    runtimeConfig.deepseekHarness.mode =
      instanceRuntimeConfig?.deepseekHarness?.mode ?? "standard";
    runtimeConfig.deepseekHarness.providerId =
      instanceRuntimeConfig?.model?.providerId;
  }
  if (typeKey === "pi" && runtimeConfig.pi) {
    runtimeConfig.pi.providerId = instanceRuntimeConfig?.model?.providerId;
    runtimeConfig.pi.reasoningEffort = instanceRuntimeConfig?.reasoningEffort;
    runtimeConfig.pi.codeMode = piCodeMode ?? true;
  }
  return runtimeConfig;
}
