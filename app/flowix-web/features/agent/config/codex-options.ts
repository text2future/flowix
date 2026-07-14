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
  { id: "danger-full-access", label: "Full Access" },
  { id: "workspace-write", label: "Workspace Write" },
  { id: "read-only", label: "Read Only" },
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

// 仅用于 UI 展示的模型 key 美化函数: 不改变真实 model id, 不影响
// `id` 字段; 只把下拉项的 `label` 渲染得易读。 不匹配的 key 原样返回,
// 所以 "inherit" / "Codex default" 这类非标准 id 不受影响。
export function formatModelDisplayLabel(key: string): string {
  const lower = key.toLowerCase();

  // claude-opus-4-8 → "Claude Opus 4.8"
  // claude-haiku-4-5-20251001 这种带日期戳的版本不在规则内, 原样返回。
  const claudeMatch = lower.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (claudeMatch) {
    const family = claudeMatch[1][0].toUpperCase() + claudeMatch[1].slice(1);
    const version = claudeMatch[3]
      ? `${claudeMatch[2]}.${claudeMatch[3]}`
      : claudeMatch[2];
    return `Claude ${family} ${version}`;
  }

  // gpt-m.n-terra → "GPT-m.n terra" ── 品牌与首段保留 "-", 后续段用空格。
  // codex-xxx-xxx → "Codex xxx xxx" ── 品牌之后一律空格。
  // gpt-5.5 → "GPT-5.5"; codex-5 → "Codex 5"。
  const brandMatch = lower.match(/^(gpt|codex)-(.+)$/);
  if (brandMatch) {
    const brandLower = brandMatch[1];
    // GPT 全大写 (品牌识别需要), Codex 首字母大写 ── 用全等比较避免
    // 误把 "Codex" 这类已经是首大写的输入再次处理。
    const brand = brandLower === "gpt" ? "GPT" : "Codex";
    const tokens = brandMatch[2].split("-");
    if (brandLower === "gpt") {
      return tokens.length === 1
        ? `${brand}-${tokens[0]}`
        : `${brand}-${tokens[0]} ${tokens.slice(1).join(" ")}`;
    }
    return `${brand} ${tokens.join(" ")}`;
  }

  return key;
}

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
