import { agent, deepseekHarness } from "@platform/tauri/client";
import type { AgentTypeKey } from "@/types/agent";
import type { BadgeHoverCardRuntimeInfo } from "../badge-hover-card";

/**
 * 按 agent 类型构造 BadgeHoverCard 的 runtime info 懒加载请求器。
 *
 * - threadId/sessionId 统一在调用时重新读取, 避免闭包捕获陈旧值;
 * - threadId 为空时直接返回 null, 不向后台发 invoke;
 * - 未适配的 agent 类型返回 undefined, 与组件"无懒加载"语义一致。
 */
export function createRuntimeInfoRequester(
  typeKey: AgentTypeKey,
  getThreadId: () => string | null | undefined,
  getSessionId: () => string | null | undefined = () => undefined,
): (() => Promise<BadgeHoverCardRuntimeInfo | null>) | undefined {
  switch (typeKey) {
    case "pi":
      return async () => {
        const threadId = getThreadId();
        if (!threadId) return null;
        const candidateSessionId = getSessionId();
        const sessionId = candidateSessionId && candidateSessionId !== threadId
          ? candidateSessionId
          : await agent.getPiSessionId(threadId);
        return { sessionId: sessionId ?? undefined, usage: {} };
      };
    case "deepseek-harness":
      return async () => {
        const threadId = getThreadId();
        if (!threadId) return null;
        const [sessionId, usage] = await Promise.all([
          agent.getDeepSeekHarnessSessionId(threadId),
          deepseekHarness.sessionUsage(threadId),
        ]);
        return usage
          ? { ...usage, sessionId: sessionId ?? undefined }
          : { sessionId: sessionId ?? undefined, usage: {} };
      };
    case "opencode":
      return async () => {
        const threadId = getThreadId();
        if (!threadId) return null;
        return {
          sessionId: getSessionId() ?? undefined,
          usage: {},
        };
      };
    case "codex":
      return async () => {
        const threadId = getThreadId();
        // Account and rate-limit data are global Codex runtime metadata and
        // are available before a conversation has created a provider
        // session. Only per-thread usage needs a session id.
        const candidateSessionId = getSessionId();
        const knownSessionId = candidateSessionId && candidateSessionId !== threadId
          ? candidateSessionId
          : null;
        const sessionId = knownSessionId ?? (threadId
          ? await agent.getCodexSessionId(threadId)
          : null);
        const info = await agent.getCodexRuntimeInfo(sessionId);
        return {
          sessionId: sessionId ?? undefined,
          usage: info.usage ?? {},
          codex: info,
        };
      };
    default:
      return undefined;
  }
}
