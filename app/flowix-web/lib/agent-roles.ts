import type { AgentRole, AgentRoleKey, AgentRuntime } from '../types/agent';

// Agent 图标集中管理 ─────────────────────────────────────────
// 所有 agent 角色图标统一在此处 import,后续要换图标只改这一个文件。
// 实际静态资源:
//   - flowix-agent.png        Flowix Agent 角色图标(从桌面导入)
//   - codex.svg               Codex CLI 品牌图标(从桌面导入)
//   - icon-claude-code.svg    Claude Code 品牌图标(备用,未接入 Role)
import flowixAgent from '../assets/flowix-agent.png';
import iconCodex from '../assets/codex.svg';

export const DEFAULT_AGENT_ROLE_KEY: AgentRoleKey = 'flowix';

export const AGENT_ROLES: AgentRole[] = [
  {
    key: 'flowix',
    runtime: 'flowix',
    icon: flowixAgent,
    name: 'Flowix',
    desc: 'Use Flowix workspace agent',
  },
  {
    key: 'codex',
    runtime: 'codex',
    icon: iconCodex,
    name: 'Codex',
    desc: 'Use Codex coding agent',
  },
];

export function getAgentRole(roleKey: string | null | undefined): AgentRole {
  return AGENT_ROLES.find((role) => role.key === roleKey) ?? AGENT_ROLES[0];
}

export function getAgentRoleByRuntime(runtime: AgentRuntime): AgentRole {
  return AGENT_ROLES.find((role) => role.runtime === runtime) ?? AGENT_ROLES[0];
}

export function normalizeAgentRoleKey(roleKey: string | null | undefined): AgentRoleKey {
  return getAgentRole(roleKey).key;
}