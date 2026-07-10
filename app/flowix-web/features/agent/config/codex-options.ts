import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
} from "@/types/agent";
import type { I18nKey } from "@features/i18n";

export const CODEX_MODEL_OPTIONS: Array<{
  id: AgentCodexModel;
  label: string;
}> = [
  { id: "gpt-5.5", label: "gpt-5.5" },
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
];

export const CODEX_PERMISSION_IDS: AgentPermissionMode[] = [
  "danger-full-access",
  "workspace-write",
  "read-only",
];

export const CODEX_ACCESS_OPTIONS: Array<{ id: AgentPermissionMode; label: string }> = [
  { id: "danger-full-access", label: "Full access" },
  { id: "workspace-write", label: "Workspace write" },
  { id: "read-only", label: "Read only" },
];

export const CODEX_REASONING_OPTIONS: Array<{
  id: AgentCodexReasoningEffort;
  label: string;
}> = [
  { id: "low", label: "Light" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
];

export function getCodexPermissionLabel(
  t: (key: I18nKey) => string,
  id: AgentPermissionMode,
): string {
  switch (id) {
    case "inherit":
      return t("agent.permission.default");
    case "read-only":
      return t("agent.permission.readOnly");
    case "workspace-write":
      return t("agent.permission.workspaceWrite");
    case "danger-full-access":
      return t("agent.permission.dangerFullAccess");
  }
}
