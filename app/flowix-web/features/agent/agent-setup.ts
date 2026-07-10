import { openUrl } from '@tauri-apps/plugin-opener';
import { windows } from '@platform/tauri/client';
import type { AgentTypeKey } from '@/types/agent';
import { isAgentTypeComingSoon } from '@/lib/agent-types';

const AGENT_SETUP_URLS: Partial<Record<AgentTypeKey, string>> = {
  codex: 'https://developers.openai.com/codex/cli',
  claude: 'https://code.claude.com/docs/en/setup',
  gemini: 'https://google-gemini.github.io/gemini-cli/docs/cli/headless.html',
  hermes: 'https://hermes-agent.nousresearch.com/docs/user-guide/cli',
  openclaw: 'https://docs.openclaw.ai/cli',
};

export async function openAgentSetup(typeKey: AgentTypeKey): Promise<void> {
  if (isAgentTypeComingSoon(typeKey)) return;

  if (typeKey === 'flowix') {
    await windows.openPreferences('agent');
    return;
  }

  const url = AGENT_SETUP_URLS[typeKey];
  if (url) {
    await openUrl(url);
  }
}
