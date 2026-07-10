import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentRuntimeConfig,
  AgentTypeKey,
} from "@/types/agent";
import { CODEX_ACCESS_OPTIONS } from "@features/agent/config/codex-options";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { normalizeContextValue } from "@features/agent/store/context-block";

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
}

export interface AgentRuntimeSpec {
  typeKey: AgentTypeKey;
  emptySettings: readonly AgentRuntimeSettingKind[];
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
  { id: "danger-full-access", label: "Full access" },
];

const NO_ACCESS_OPTIONS: readonly AgentAccessOption[] = [];

function normalizeWorkspacePath(path: string | null | undefined): string {
  return normalizeContextValue(path).replace(/[\\/]+$/, "");
}

function getEnabledAgentWorkspacePaths(): string[] {
  const paths = useAgentAccessStore
    .getState()
    .config.entries.filter((entry) => entry.enabled && !entry.missing)
    .map((entry) => normalizeWorkspacePath(entry.path))
    .filter(Boolean);
  return Array.from(new Set(paths));
}

function getPrimaryAgentWorkspacePath(): string | undefined {
  const entry = useAgentAccessStore
    .getState()
    .config.entries.find(
      (item) =>
        item.kind === "folder" &&
        item.workspace &&
        item.enabled &&
        !item.missing,
    );
  return normalizeWorkspacePath(entry?.path) || undefined;
}

function getFirstEnabledAgentFolderPath(): string | undefined {
  const entry = useAgentAccessStore
    .getState()
    .config.entries.find(
      (item) => item.kind === "folder" && item.enabled && !item.missing,
    );
  return normalizeWorkspacePath(entry?.path) || undefined;
}

export function normalizeCodexPermissionMode(
  mode: AgentPermissionMode | undefined,
): AgentPermissionMode {
  return mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "danger-full-access"
    ? mode
    : "danger-full-access";
}

const AGENT_RUNTIME_SPECS: Record<AgentTypeKey, AgentRuntimeSpec> = {
  flowix: {
    typeKey: "flowix",
    emptySettings: [],
    accessOptions: NO_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      flowix: { cwd, workspacePaths },
    }),
  },
  codex: {
    typeKey: "codex",
    emptySettings: ["model", "reasoning", "permission"],
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
    emptySettings: ["permission"],
    accessOptions: CODEX_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode }) => ({
      claude: { cwd, workspacePaths, permissionMode },
    }),
  },
  gemini: {
    typeKey: "gemini",
    emptySettings: [],
    accessOptions: NO_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      gemini: { cwd, workspacePaths },
    }),
  },
  hermes: {
    typeKey: "hermes",
    emptySettings: ["permission"],
    accessOptions: HERMES_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode }) => ({
      hermes: { cwd, workspacePaths, permissionMode },
    }),
  },
  openclaw: {
    typeKey: "openclaw",
    emptySettings: [],
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
}: BuildAgentRuntimeConfigInput): AgentRuntimeConfig {
  const workspacePaths = getEnabledAgentWorkspacePaths();
  const primaryWorkspace =
    getPrimaryAgentWorkspacePath() ||
    getFirstEnabledAgentFolderPath() ||
    normalizeWorkspacePath(cwd) ||
    undefined;
  return getAgentRuntimeSpec(typeKey).buildRuntimeConfig({
    cwd: primaryWorkspace,
    workspacePaths,
    permissionMode,
    codexModel,
    codexReasoningEffort,
  });
}
