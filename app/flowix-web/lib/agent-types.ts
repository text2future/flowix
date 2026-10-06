import type { AgentRuntimeCapabilities, AgentType, AgentTypeKey } from '@/types/agent';

export type { AgentTypeKey };

// Agent 图标集中管理 ─────────────────────────────────────────
// 所有 agent 类型图标统一在此处 import, 后续要换图标只改这一个文件。
// 实际静态资源:
//   - codex.svg               Codex CLI 品牌图标(从桌面导入)
//   - icon-claude-code.svg    Claude Code 品牌图标
import iconCodex from '@/assets/codex.svg';
import iconClaudeCode from '@/assets/icon-claude-code.svg';
import iconGeminiCli from '@/assets/icon-gemini-cli.svg';
import iconHermesAgent from '@/assets/icon-hermes-agent.svg';
import iconOpenClaw from '@/assets/icon-openclaw.svg';
import iconOpenCode from '@/assets/icon-opencode.svg';
import iconDeepSeek from '@/assets/icon-deepseek.svg';
import iconPi from '@/assets/icon-pi.svg';

// DSH is an optional separately installed runtime. Keep the product default on
// an external CLI path so users who never install DSH do not create unusable
// DSH-backed cards implicitly; persisted/card-level choices still win.
export const DEFAULT_AGENT_TYPE_KEY: AgentTypeKey = 'codex';

/**
 * Agent icons that are rendered with the current theme color instead of
 * preserving their original brand colors.
 */
export const THEME_ADAPTIVE_AGENT_ICON_KEYS = new Set<AgentTypeKey>([
  'deepseek-harness',
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
  'deepseek-harness',
  'codex',
  'claude',
  'opencode',
] as const satisfies readonly AgentTypeKey[];

/**
 * Product entry points that must remain discoverable even before their local
 * runtime has been installed. Other agents only appear in the new-conversation
 * menu after runtime detection confirms that they are installed.
 */
export const ALWAYS_VISIBLE_NEW_CONVERSATION_AGENT_KEYS = new Set<AgentTypeKey>([
  'deepseek-harness',
  'codex',
  'claude',
  'pi',
]);

export function isAlwaysVisibleNewConversationAgent(typeKey: AgentTypeKey): boolean {
  return ALWAYS_VISIBLE_NEW_CONVERSATION_AGENT_KEYS.has(typeKey);
}

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

const SIMPLE_CLI_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsTextStreaming: false,
  supportsToolEvents: false,
  externalSessionBacked: false,
};

export const AGENT_TYPES: AgentType[] = [
  {
    key: 'pi',
    icon: iconPi,
    name: 'Pi',
    desc: 'Use Pi coding agent',
    capabilities: STREAMING_EXTERNAL_CLI_CAPABILITIES,
  },
  {
    key: 'deepseek-harness',
    icon: iconDeepSeek,
    name: 'DeepSeek Harness',
    desc: 'Use the bundled DeepSeek Harness',
    nameKey: 'agent.types.deepseekHarness.name',
    descKey: 'agent.types.deepseekHarness.desc',
    capabilities: { ...STREAMING_EXTERNAL_CLI_CAPABILITIES, supportsThreadArchive: true },
  },
  {
    key: 'codex',
    icon: iconCodex,
    name: 'Codex',
    desc: 'Use Codex coding agent',
    nameKey: 'agent.types.codex.name',
    descKey: 'agent.types.codex.desc',
    capabilities: { ...EXTERNAL_CLI_CAPABILITIES, supportsThreadArchive: true },
  },
  {
    key: 'claude',
    icon: iconClaudeCode,
    name: 'Claude Code',
    desc: 'Use Claude Code agent',
    nameKey: 'agent.types.claude.name',
    descKey: 'agent.types.claude.desc',
    capabilities: STREAMING_EXTERNAL_CLI_CAPABILITIES,
  },
  {
    key: 'opencode',
    icon: iconOpenCode,
    name: 'OpenCode',
    desc: 'Use OpenCode through Agent Client Protocol',
    nameKey: 'agent.types.opencode.name',
    descKey: 'agent.types.opencode.desc',
    capabilities: { ...STREAMING_EXTERNAL_CLI_CAPABILITIES, supportsThreadArchive: true },
  },
  {
    key: 'hermes',
    icon: iconHermesAgent,
    name: 'Hermes',
    desc: 'Use Hermes',
    nameKey: 'agent.types.hermes.name',
    descKey: 'agent.types.hermes.desc',
    capabilities: { ...EXTERNAL_CLI_CAPABILITIES, supportsThreadArchive: true },
  },
  {
    key: 'gemini',
    icon: iconGeminiCli,
    name: 'Gemini CLI',
    desc: 'Use Gemini CLI agent',
    nameKey: 'agent.types.gemini.name',
    descKey: 'agent.types.gemini.desc',
    releaseStatus: 'coming-soon',
    capabilities: SIMPLE_CLI_CAPABILITIES,
  },
  {
    key: 'openclaw',
    icon: iconOpenClaw,
    name: 'OpenClaw',
    desc: 'Use OpenClaw agent',
    nameKey: 'agent.types.openclaw.name',
    descKey: 'agent.types.openclaw.desc',
    releaseStatus: 'coming-soon',
    capabilities: SIMPLE_CLI_CAPABILITIES,
  },
];

export function getAgentType(typeKey: string | null | undefined): AgentType {
  return (
    AGENT_TYPES.find((t) => t.key === typeKey) ??
    AGENT_TYPES.find((t) => t.key === DEFAULT_AGENT_TYPE_KEY) ??
    AGENT_TYPES[0]
  );
}

export function normalizeAgentTypeKey(typeKey: string | null | undefined): AgentTypeKey {
  return getAgentType(typeKey).key;
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
