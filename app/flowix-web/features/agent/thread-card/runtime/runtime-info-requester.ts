import { agent, deepseekHarness } from "@platform/tauri/client";
import type { AgentTypeKey } from "@/types/agent";
import type { BadgeHoverCardRuntimeInfo } from "./use-badge-runtime-info";

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
        // Pi owns the authoritative session-wide totals. These include
        // assistant turns, tool usage, and compaction/branch summaries.
        const stats = await agent.getPiSessionStats(threadId);
        const tokens = stats.tokens ?? {};
        const numeric = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) ? value : undefined;
        const inputParts = [tokens.input, tokens.cacheRead, tokens.cacheWrite]
          .map(numeric);
        const inputTokens = inputParts.some((value) => value !== undefined)
          ? inputParts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
          : undefined;
        const candidateSessionId = getSessionId();
        const sessionId = stats.sessionId || (
          candidateSessionId && candidateSessionId !== threadId
            ? candidateSessionId
            : undefined
        );
        return {
          sessionId: sessionId ?? undefined,
          model: stats.model ?? undefined,
          usage: {
            input_tokens: inputTokens,
            cached_input_tokens: numeric(tokens.cacheRead),
            output_tokens: numeric(tokens.output),
            total_tokens: numeric(tokens.total),
            context_used_tokens: numeric(stats.contextUsage?.tokens),
            model_context_window: numeric(stats.contextUsage?.contextWindow),
          },
        };
      };
    case "dsh":
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
