import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentRuntimeConfig,
  AgentTypeKey,
  RuntimeConfig,
} from "@/types/agent";
import { CODEX_ACCESS_OPTIONS } from "@features/agent/config/codex-options";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { resolvePrimaryWorkspace } from "@features/agent/runtime/primary-workspace";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";

export type AgentRuntimeSettingKind = "model" | "reasoning" | "permission";

export interface AgentAccessOption {
  id: AgentPermissionMode;
  label: string;
}

export interface BuildAgentRuntimeConfigInput {
  typeKey: AgentTypeKey;
  cwd?: string;
  permissionMode: AgentPermissionMode;
  codexModel: AgentCodexModel;
  codexReasoningEffort: AgentCodexReasoningEffort;
  instanceRuntimeConfig?: RuntimeConfig;
}

export interface AgentRuntimeSpec {
  typeKey: AgentTypeKey;
  emptySettings: readonly AgentRuntimeSettingKind[];
  supportsFilesSetting: boolean;
  accessOptions: readonly AgentAccessOption[];
  buildRuntimeConfig: (
    input: Omit<BuildAgentRuntimeConfigInput, "typeKey"> & {
      cwd?: string;
      workspacePaths: string[];
    },
  ) => AgentRuntimeConfig;
}

const HERMES_ACCESS_OPTIONS: readonly AgentAccessOption[] = [
  { id: "inherit", label: "Default" },
  { id: "danger-full-access", label: "Full Access" },
];

const CLAUDE_ACCESS_OPTIONS: readonly AgentAccessOption[] = [
  { id: "yolo", label: "YOLO" },
  { id: "danger-full-access", label: "Full Access" },
  { id: "workspace-write", label: "Workspace Write" },
  { id: "read-only", label: "Read Only" },
];

const NO_ACCESS_OPTIONS: readonly AgentAccessOption[] = [];

function getEnabledAgentWorkspacePaths(): string[] {
  const paths = useAgentAccessStore
    .getState()
    .config.entries.filter((entry) => entry.enabled && !entry.missing)
    .map((entry) => normalizeWorkspacePath(entry.path))
    .filter(Boolean);
  return Array.from(new Set(paths));
}

export function normalizeCodexPermissionMode(
  mode: AgentPermissionMode | undefined,
): AgentPermissionMode {
  return mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "danger-full-access" ||
    mode === "yolo"
    ? mode
    : "danger-full-access";
}

const AGENT_RUNTIME_SPECS: Record<AgentTypeKey, AgentRuntimeSpec> = {
  flowix: {
    typeKey: "flowix",
    emptySettings: [],
    supportsFilesSetting: true,
    accessOptions: NO_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      flowix: { cwd, workspacePaths },
    }),
  },
  codex: {
    typeKey: "codex",
    emptySettings: ["model", "reasoning", "permission"],
    supportsFilesSetting: true,
    accessOptions: CODEX_ACCESS_OPTIONS,
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
    supportsFilesSetting: true,
    accessOptions: CLAUDE_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode, codexModel }) => ({
      claude: { cwd, workspacePaths, permissionMode, model: codexModel },
    }),
  },
  gemini: {
    typeKey: "gemini",
    emptySettings: [],
    supportsFilesSetting: true,
    accessOptions: NO_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      gemini: { cwd, workspacePaths },
    }),
  },
  hermes: {
    typeKey: "hermes",
    emptySettings: ["permission"],
    supportsFilesSetting: true,
    accessOptions: HERMES_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode }) => ({
      hermes: { cwd, workspacePaths, permissionMode },
    }),
  },
  openclaw: {
    typeKey: "openclaw",
    emptySettings: [],
    supportsFilesSetting: true,
    accessOptions: NO_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      openclaw: { cwd, workspacePaths },
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
  const spec = getAgentRuntimeSpec(typeKey);
  return spec.supportsFilesSetting || spec.emptySettings.length > 0;
}

export function getAgentAccessOptions(
  typeKey: AgentTypeKey,
): readonly AgentAccessOption[] {
  return getAgentRuntimeSpec(typeKey).accessOptions;
}

export function buildAgentRuntimeConfig({
  typeKey,
  cwd,
  permissionMode,
  codexModel,
  codexReasoningEffort,
  instanceRuntimeConfig,
}: BuildAgentRuntimeConfigInput): AgentRuntimeConfig {
  const instanceFiles = instanceRuntimeConfig?.files;
  const instanceWorkspacePaths = instanceFiles
    ? [...instanceFiles.folders, ...instanceFiles.notebooks]
        .map(normalizeWorkspacePath)
        .filter(Boolean)
    : [];

  // primaryWorkspace 兜底链 ── 必须保证非空, 否则 CLI 启动会因缺 cwd 失败
  // ("Claude Code CLI exited with status exit status: 1: Please provide a
  // directory path")。 旧版用 `!instanceFiles` 把 global 兜底门控住, 让
  // thread 的 per-thread runtime 一旦存在就完全屏蔽 global workspace ──
  // 但用户点 star 设的 global workspace 不写 per-thread, 这种设计下
  // thread 没显式设 workspace 时 cwd 就空了。
  //
  // per-thread 优先 (workspace / folders), 但**不论** instanceFiles 是否
  // 存在, global workspace 始终作为兜底 ── 这样用户在 agent panel 上点
  // star 设的 workspace 才会落到所有 thread 上, CLI 启动也能拿到 cwd。
  const globalWorkspacePaths = getEnabledAgentWorkspacePaths();
  const effectiveWorkspacePaths = instanceFiles
    ? Array.from(new Set(instanceWorkspacePaths))
    : globalWorkspacePaths;
  // primaryWorkspace 与 settings controller 的 `getFilesControlLabel` 共用
  // 同一段 cascade (primary-workspace.resolvePrimaryWorkspace)。 instance 优
  // 先, 全局信息只作为"默认未配置时"的兜底, 最后落到 systemReminderDirectory。
  const resolvedPrimary = resolvePrimaryWorkspace({
    instanceFiles,
    globalEntries: useAgentAccessStore.getState().config.entries,
    cwd,
  });
  // empty 变体无 path ── 收窄后取, 否则 undefined (上层 dispatch 据此判断是否拦截)。
  const primaryWorkspace =
    resolvedPrimary.kind === "empty" ? undefined : resolvedPrimary.path;
  const effectivePermissionMode =
    instanceRuntimeConfig?.access?.sandbox ?? permissionMode;
  const effectiveModel =
    instanceRuntimeConfig?.model?.key ?? codexModel;
  const effectiveReasoningEffort =
    instanceRuntimeConfig?.reasoningEffort ?? codexReasoningEffort;
  return getAgentRuntimeSpec(typeKey).buildRuntimeConfig({
    cwd: primaryWorkspace,
    workspacePaths: effectiveWorkspacePaths,
    permissionMode: effectivePermissionMode,
    codexModel: effectiveModel,
    codexReasoningEffort: effectiveReasoningEffort,
  });
}
