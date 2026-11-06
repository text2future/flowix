import type { AgentRuntimeCapabilities, AgentType, AgentTypeKey } from '@/types/agent';

export type { AgentTypeKey };

// Agent 图标集中管理 ─────────────────────────────────────────
// 所有 agent 类型图标统一在此处 import, 后续要换图标只改这一个文件。
// 实际静态资源:
//   - codex.svg               Codex CLI 品牌图标(从桌面导入)
//   - icon-claude-code.svg    Claude Code 品牌图标
//   - icon-pi.svg             Pi 品牌图标(矢量, 带透明通道)
import iconCodex from '@/assets/codex.svg';
import iconClaudeCode from '@/assets/icon-claude-code.svg';
import iconHermesAgent from '@/assets/icon-hermes-agent.svg';
import iconOpenCode from '@/assets/icon-opencode.svg';
import iconDeepSeek from '@/assets/icon-deepseek.svg';
import iconPi from '@/assets/icon-pi.svg';

// DSH is an optional separately installed runtime. Keep the product default on
// an external CLI path so users who never install DSH do not create unusable
// DSH-backed cards implicitly; persisted/card-level choices still win.
export const DEFAULT_AGENT_TYPE_KEY: AgentTypeKey = 'codex';

/** One-time storage/API boundary normalization for IDs written by older builds. */
export function normalizeAgentId(value: string | null | undefined): AgentTypeKey | null {
  switch (value) {
    case 'claude': return 'claudecode';
    case 'deepseek-harness':
    case 'deepseek_harness': return 'dsh';
    case 'codex':
    case 'claudecode':
    case 'hermes':
    case 'opencode':
    case 'pi':
    case 'dsh': return value;
    default: return null;
  }
}

/**
 * Agent icons that are rendered with the current theme color instead of
 * preserving their original brand colors.
 */
export const THEME_ADAPTIVE_AGENT_ICON_KEYS = new Set<AgentTypeKey>([
  'dsh',
  'opencode',
  'hermes',
]);

export function isThemeAdaptiveAgentIcon(typeKey: AgentTypeKey): boolean {
  return THEME_ADAPTIVE_AGENT_ICON_KEYS.has(typeKey);
}

/**
 * Agent order used when a navigation entry needs one representative local
 * runtime. Keep this separate from AGENT_TYPES: that list is the product's
 * catalog order, while the sidebar follows the requested local-agent
 * preference order.
 */
export const LOCAL_AGENT_DISPLAY_PRIORITY = [
  'dsh',
  'codex',
  'claudecode',
  'opencode',
] as const satisfies readonly AgentTypeKey[];

export function pickFirstAvailableAgent(
  statusByType: Partial<Record<AgentTypeKey, { available: boolean }>>,
): AgentTypeKey | null {
  return LOCAL_AGENT_DISPLAY_PRIORITY.find((key) => statusByType[key]?.available === true) ?? null;
}

const EXTERNAL_CLI_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsTextStreaming: false,
  supportsToolEvents: true,
  externalSessionBacked: true,
};

// 外部 CLI + 文本流式: adapter 产出高频增量 Text delta(走 rAF 合流), 同时保留
// external session 对齐。Claude Code 开 --include-partial-messages 后用这档;
// Codex 等 item 级(整段 Text)的 CLI 暂用 EXTERNAL_CLI_CAPABILITIES, 将来其
// adapter 升级成 token 级流式时改用本档即可 ── 同一通用机制, 非 provider 逻辑。
const STREAMING_EXTERNAL_CLI_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsTextStreaming: true,
  supportsToolEvents: true,
  externalSessionBacked: true,
};

export const AGENT_TYPES: AgentType[] = [
  {
    id: 'pi',
    runtimeKind: 'builtin',
    icon: iconPi,
    name: 'AI Chat',
    desc: 'Use Pi coding agent',
    nameKey: 'agent.types.pi.name',
    capabilities: STREAMING_EXTERNAL_CLI_CAPABILITIES,
  },
  {
    id: 'codex',
    runtimeKind: 'external-cli',
    icon: iconCodex,
    name: 'Codex',
    desc: 'Use Codex coding agent',
    nameKey: 'agent.types.codex.name',
    descKey: 'agent.types.codex.desc',
    capabilities: { ...EXTERNAL_CLI_CAPABILITIES, supportsThreadArchive: true },
  },
  {
    id: 'claudecode',
    runtimeKind: 'external-cli',
    icon: iconClaudeCode,
    name: 'Claude Code',
    desc: 'Use Claude Code agent',
    nameKey: 'agent.types.claude.name',
    descKey: 'agent.types.claude.desc',
    capabilities: STREAMING_EXTERNAL_CLI_CAPABILITIES,
  },
  {
    id: 'opencode',
    runtimeKind: 'external-cli',
    icon: iconOpenCode,
    name: 'OpenCode',
    desc: 'Use OpenCode through Agent Client Protocol',
    nameKey: 'agent.types.opencode.name',
    descKey: 'agent.types.opencode.desc',
    capabilities: { ...STREAMING_EXTERNAL_CLI_CAPABILITIES, supportsThreadArchive: true },
  },
  {
    id: 'hermes',
    runtimeKind: 'external-cli',
    icon: iconHermesAgent,
    name: 'Hermes',
    desc: 'Use Hermes',
    nameKey: 'agent.types.hermes.name',
    descKey: 'agent.types.hermes.desc',
    capabilities: { ...EXTERNAL_CLI_CAPABILITIES, supportsThreadArchive: true },
  },
  {
    id: 'dsh',
    runtimeKind: 'builtin',
    icon: iconDeepSeek,
    name: 'DeepSeek Harness',
    desc: 'Use the bundled DeepSeek Harness',
    nameKey: 'agent.types.deepseekHarness.name',
    descKey: 'agent.types.deepseekHarness.desc',
    capabilities: { ...STREAMING_EXTERNAL_CLI_CAPABILITIES, supportsThreadArchive: true },
  },
];

export function getAgentType(typeKey: string | null | undefined): AgentType {
  const id = normalizeAgentId(typeKey);
  return (
    AGENT_TYPES.find((t) => t.id === id) ??
    AGENT_TYPES.find((t) => t.id === DEFAULT_AGENT_TYPE_KEY) ??
    AGENT_TYPES[0]
  );
}

export function normalizeAgentTypeKey(typeKey: string | null | undefined): AgentTypeKey {
  return normalizeAgentId(typeKey) ?? DEFAULT_AGENT_TYPE_KEY;
}

export function supportsTextStreaming(typeKey: string | null | undefined): boolean {
  return getAgentType(typeKey).capabilities.supportsTextStreaming;
}

export function isAgentTypeComingSoon(typeKey: string | null | undefined): boolean {
  return getAgentType(typeKey).releaseStatus === 'coming-soon';
}

export function isAgentTypeSelectable(typeKey: string | null | undefined): boolean {
  return !isAgentTypeComingSoon(typeKey);
}
