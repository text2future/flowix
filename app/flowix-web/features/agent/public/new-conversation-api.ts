/**
 * "新建并打开 Agent 会话" 的命令入口。
 *
 * 这两个动作需要 agent-session-store 才能造实例并导航，但调用点（笔记列表的
 * 新建菜单、状态栏的 Pi 按钮）都在首屏可达的模块里。因此这里只暴露**同步的
 * 触发函数**，真正的实现在函数体内动态 import —— 用户点下按钮时才加载。
 *
 * 两个命令本来就没有返回值（调用方也不 await），所以同步薄壳不改变语义。
 */
import { fireAndForget } from '@/lib/fire-and-forget';
import type { AgentTypeKey } from '@/types/agent';

export function createAndOpenAgentConversation(
  typeKey: AgentTypeKey,
  notebookId: string | null,
): void {
  fireAndForget(
    import('@features/agent/use-cases/new-conversation')
      .then((module) => module.createAndOpenAgentConversation(typeKey, notebookId)),
    'agent:create-and-open-conversation',
  );
}

export function createAndOpenPiConversation(): void {
  fireAndForget(
    import('@features/agent/use-cases/new-conversation')
      .then((module) => module.createAndOpenPiConversation()),
    'agent:create-and-open-pi-conversation',
  );
}

export function createAndOpenAgentConversationWithPrompt(
  typeKey: AgentTypeKey,
  notebookId: string | null,
  prompt: string,
): void {
  fireAndForget(
    import('@features/agent/use-cases/new-conversation')
      .then((module) => module.createAndOpenAgentConversationWithPrompt(typeKey, notebookId, prompt)),
    'agent:create-and-open-conversation-with-prompt',
  );
}
