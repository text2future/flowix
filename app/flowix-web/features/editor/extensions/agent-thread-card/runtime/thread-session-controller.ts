import type { AgentTypeKey } from "@/types/agent";
import {
  applyResolvedExternalSession,
  createExternalAgentRuntimeHandle,
  getExternalAgentRuntimeThreadId,
  getResolvedExternalSessionId,
} from "@features/agent/services/external-agent-runtime-service";

export interface ApplyResolvedSessionOptions {
  threadId: string;
  sessionId: string;
  typeKey: AgentTypeKey;
  currentThreadId: string | null;
  storedThreadId: string | null;
  isDestroyed: boolean;
  instanceId: string | null;
  updateConversationThread: (
    instanceId: string,
    update: { agentType: AgentTypeKey; threadId: string },
  ) => void;
  updateAttrs: (attrs: Record<string, unknown>) => void;
}

export class ThreadSessionController {
  readonly runtimeHandleId = createExternalAgentRuntimeHandle();

  private appliedResolvedSessionKeys = new Set<string>();

  getRuntimeThreadId(threadId: string | null): string | null {
    return getExternalAgentRuntimeThreadId(this.runtimeHandleId, threadId);
  }

  getRenderThreadId(threadId: string | null): string | null {
    const runtimeThreadId = this.getRuntimeThreadId(threadId);
    return getResolvedExternalSessionId(runtimeThreadId) ?? runtimeThreadId;
  }

  getResolvedSessionId(threadId: string | null): string | null {
    return getResolvedExternalSessionId(threadId) ?? null;
  }

  applyResolvedSession(options: ApplyResolvedSessionOptions): void {
    const {
      threadId,
      sessionId,
      typeKey,
      currentThreadId,
      storedThreadId,
      isDestroyed,
      instanceId,
      updateConversationThread,
      updateAttrs,
    } = options;
    const resolutionKey = `${threadId}->${sessionId}`;
    const runtimeThreadId = this.getRuntimeThreadId(currentThreadId);
    if (
      !sessionId ||
      sessionId === threadId ||
      this.appliedResolvedSessionKeys.has(resolutionKey) ||
      isDestroyed ||
      (
        runtimeThreadId !== threadId &&
        currentThreadId !== sessionId &&
        storedThreadId !== threadId
      )
    ) {
      return;
    }

    this.appliedResolvedSessionKeys.add(resolutionKey);
    applyResolvedExternalSession(
      this.runtimeHandleId,
      threadId,
      sessionId,
      typeKey,
    );
    if (instanceId) {
      updateConversationThread(instanceId, {
        agentType: typeKey,
        threadId: sessionId,
      });
    }
    updateAttrs({
      threadId: sessionId,
      typeKey,
    });
  }
}
