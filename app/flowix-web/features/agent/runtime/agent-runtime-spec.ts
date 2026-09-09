import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentRuntimeConfig,
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

export interface BuildAgentRuntimeConfigInput {
  typeKey: AgentTypeKey;
  /** 当前笔记本路径 (= systemReminderDirectory), always used as cwd. */
  notebookPath?: string;
  permissionMode: AgentPermissionMode;
  codexModel: AgentCodexModel;
  codexReasoningEffort: AgentCodexReasoningEffort;
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

const NO_ACCESS_OPTIONS: readonly AgentAccessOption[] = [];

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

const AGENT_RUNTIME_SPECS: Record<AgentTypeKey, AgentRuntimeSpec> = {
  codex: {
    typeKey: "codex",
    emptySettings: ["model", "reasoning", "permission"],
    accessOptions: CODEX_APP_SERVER_ACCESS_OPTIONS,
    // The notebook owns cwd; conversation snapshots freeze it at first send.
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: true },
    buildRuntimeConfig: ({
      cwd,
      workspacePaths,
      permissionMode,
      codexModel,
      codexReasoningEffort,
    }) => ({
      codex: {
        cwd,
        workspacePaths,
        permissionMode: normalizeCodexPermissionMode(permissionMode),
        model: codexModel,
        reasoningEffort: codexReasoningEffort,
      },
    }),
  },
  claude: {
    typeKey: "claude",
    emptySettings: ["model", "permission"],
    accessOptions: CLAUDE_ACCESS_OPTIONS,
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: false },
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode, codexModel }) => ({
      // 统一归一化: 持久化或历史数据中的 yolo 视作 danger-full-access,
      // 与 UI 不再提供 yolo 选项保持一致。
      claude: { cwd, workspacePaths, permissionMode: normalizeCodexPermissionMode(permissionMode), model: codexModel },
    }),
  },
  gemini: {
    typeKey: "gemini",
    emptySettings: [],
    accessOptions: NO_ACCESS_OPTIONS,
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: false },
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      gemini: { cwd, workspacePaths },
    }),
  },
  hermes: {
    typeKey: "hermes",
    emptySettings: ["permission"],
    accessOptions: HERMES_ACCESS_OPTIONS,
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: false },
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode }) => ({
      hermes: { cwd, workspacePaths, permissionMode },
    }),
  },
  openclaw: {
    typeKey: "openclaw",
    emptySettings: [],
    accessOptions: NO_ACCESS_OPTIONS,
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: false },
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      openclaw: { cwd, workspacePaths },
    }),
  },
  opencode: {
    typeKey: "opencode",
    emptySettings: ["model", "permission"],
    accessOptions: SHARED_ACCESS_OPTIONS,
    workspace: { selectBeforeFirstRun: false, switchWhileRunning: false, switchBetweenRuns: false, switchRequiresRuntimeRestart: false, preservesConversationSession: false },
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode, codexModel }) => ({
      opencode: { cwd, workspacePaths, permissionMode, model: codexModel },
    }),
  },
  "deepseek-harness": {
    typeKey: "deepseek-harness",
    // DSH follows the native llm-pi-ai provider configuration but allows a per-card
    // model override (runtime_config.deepseek_harness.model, "inherit" falls
    // back to the global dsh-settings model). Its tool Agent preset and
    // per-card permission mode are configurable here as well.
    emptySettings: ["model", "mode", "permission"],
    accessOptions: DSH_ACCESS_OPTIONS,
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
  return AGENT_RUNTIME_SPECS[typeKey];
}

export function supportsAgentRuntimeSetting(
  typeKey: AgentTypeKey,
  kind: AgentRuntimeSettingKind,
): boolean {
  return getAgentRuntimeSpec(typeKey).emptySettings.includes(kind);
}

export function supportsAgentEmptySettings(typeKey: AgentTypeKey): boolean {
  // files 控件已移除 (主空间由侧边栏资料列表决定), 空状态设置区只看
  // model / permission / reasoning 是否有可配置项。
  const spec = getAgentRuntimeSpec(typeKey);
  return spec.emptySettings.length > 0;
}

export function getAgentAccessOptions(
  typeKey: AgentTypeKey,
): readonly AgentAccessOption[] {
  return getAgentRuntimeSpec(typeKey).accessOptions;
}

export function buildAgentRuntimeConfig({
  typeKey,
  notebookPath,
  permissionMode,
  codexModel,
  codexReasoningEffort,
  instanceRuntimeConfig,
  defaultFiles,
  workspaceSnapshot,
}: BuildAgentRuntimeConfigInput): AgentRuntimeConfig {
  // cwd is always the selected notebook path.  `defaultFiles.folders` are
  // notebook-local add-dir roots from `.flowix/agent.json`; they are sent as
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
  const effectiveModel =
    instanceRuntimeConfig?.model?.key ?? codexModel;
  const effectiveReasoningEffort =
    instanceRuntimeConfig?.reasoningEffort ?? codexReasoningEffort;
  const runtimeConfig = getAgentRuntimeSpec(typeKey).buildRuntimeConfig({
    cwd: primaryWorkspace,
    workspacePaths,
    permissionMode: effectivePermissionMode,
    codexModel: effectiveModel,
    codexReasoningEffort: effectiveReasoningEffort,
  });
  if (typeKey === "deepseek-harness" && runtimeConfig.deepseekHarness) {
    runtimeConfig.deepseekHarness.mode =
      instanceRuntimeConfig?.deepseekHarness?.mode ?? "standard";
    runtimeConfig.deepseekHarness.providerId =
      instanceRuntimeConfig?.model?.providerId;
  }
  return runtimeConfig;
}
