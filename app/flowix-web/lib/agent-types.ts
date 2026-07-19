import type { AgentRuntimeCapabilities, AgentType, AgentTypeKey } from '@/types/agent';

export type { AgentTypeKey };

// Agent 图标集中管理 ─────────────────────────────────────────
// 所有 agent 类型图标统一在此处 import, 后续要换图标只改这一个文件。
// 实际静态资源:
//   - flowix-agent.png        Flowix 类型图标(从桌面导入)
//   - codex.svg               Codex CLI 品牌图标(从桌面导入)
//   - icon-claude-code.svg    Claude Code 品牌图标
import flowixAgent from '@/assets/flowix-agent.png';
import iconCodex from '@/assets/codex.svg';
import iconClaudeCode from '@/assets/icon-claude-code.svg';
import iconGeminiCli from '@/assets/icon-gemini-cli.svg';
import iconHermesAgent from '@/assets/icon-hermes-agent.svg';
import iconOpenClaw from '@/assets/icon-openclaw.svg';

export const DEFAULT_AGENT_TYPE_KEY: AgentTypeKey = 'flowix';

const STREAMING_PROVIDER_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsTextStreaming: true,
  supportsToolEvents: true,
  externalSessionBacked: false,
};

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
    key: 'flowix',
    icon: flowixAgent,
    name: 'Flowix Agent',
    desc: 'Use Flowix workspace agent',
    nameKey: 'agent.types.flowix.name',
    descKey: 'agent.types.flowix.desc',
    capabilities: STREAMING_PROVIDER_CAPABILITIES,
  },
  {
    key: 'codex',
    icon: iconCodex,
    name: 'Codex',
    desc: 'Use Codex coding agent',
    nameKey: 'agent.types.codex.name',
    descKey: 'agent.types.codex.desc',
    capabilities: EXTERNAL_CLI_CAPABILITIES,
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
    key: 'hermes',
    icon: iconHermesAgent,
    name: 'Hermes',
    desc: 'Use Hermes',
    nameKey: 'agent.types.hermes.name',
    descKey: 'agent.types.hermes.desc',
    capabilities: EXTERNAL_CLI_CAPABILITIES,
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
  return AGENT_TYPES.find((t) => t.key === typeKey) ?? AGENT_TYPES[0];
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
