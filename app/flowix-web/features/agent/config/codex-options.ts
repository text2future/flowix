import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
} from "@/types/agent";

export const CODEX_MODEL_OPTIONS: Array<{
  id: AgentCodexModel;
  label: string;
}> = [
  { id: "gpt-5.5", label: "gpt-5.5" },
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
];

/** 统一文案：所有 agent 对话框底部权限选择器共用 3 档。 */
export const SHARED_ACCESS_OPTIONS: Array<{
  id: AgentPermissionMode;
  label: string;
}> = [
  { id: "danger-full-access", label: "完全访问" },
  { id: "workspace-write", label: "空间读写" },
  { id: "read-only", label: "只读" },
];

// Codex App Server 只支持这 3 档沙箱; 用 SHARED_ACCESS_OPTIONS 同一份配置。
export const CODEX_APP_SERVER_ACCESS_OPTIONS = SHARED_ACCESS_OPTIONS;

export const CODEX_REASONING_OPTIONS: Array<{
  id: AgentCodexReasoningEffort;
  label: string;
}> = [
  { id: "low", label: "Light" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
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

  // gpt-6-luna → "GPT-6 Luna" ── GPT 品牌和版本保留 "-", 后续段用空格并首字母大写。
  // codex-5-mini → "Codex 5 Mini" ── Codex 品牌之后一律空格。
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
        : `${brand}-${tokens[0]} ${tokens.slice(1).map(formatModelNameToken).join(" ")}`;
    }
    return `${brand} ${tokens.map(formatModelNameToken).join(" ")}`;
  }

  return key;
}

function formatModelNameToken(token: string): string {
  if (!token) return token;
  return `${token[0].toUpperCase()}${token.slice(1)}`;
}
