import type {
  AgentMessageAttachment,
  AgentChunk,
  AgentEvent,
  AgentTypeKey,
  RunInfo,
  RuntimeConfig,
} from "@/types/agent";
import type { ThreadProjection } from "@features/agent/store/session-reducer";
import type { SessionMetaSlice } from "@features/agent/store/session-meta-slice";
import type { ProjectionSlice } from "@features/agent/store/projection-slice";
import type { ConversationSlice } from "@features/agent/store/conversation-slice";
import type { ThreadHistorySlice } from "@features/agent/store/thread-history-slice";
import type { ThreadLifecycleSlice } from "@features/agent/store/thread-lifecycle-slice";
import type { FollowUpQueueSlice } from "@features/agent/store/follow-up-queue-slice";

/**
 * 组合根 `agent-session-store` 对外的类型面。类型与实现分离，
 * 保持组合根文件行数不回弹（层级边界棘轮：组合根不得重新膨胀）。
 */
export interface AgentSessionStore
  extends SessionMetaSlice,
    ProjectionSlice,
    ConversationSlice,
    ThreadHistorySlice,
    ThreadLifecycleSlice,
    FollowUpQueueSlice {
  sendMessageToThread: (
    threadId: string,
    content: string,
    typeKey?: AgentTypeKey,
    options?: {
      instanceId?: string;
      conversationTitle?: string;
      currentNoteContent?: string;
      isFirstMessage?: boolean;
      runtimeConfig?: RuntimeConfig | null;
      imagePaths?: string[];
      attachments?: AgentMessageAttachment[];
      displayContent?: string;
      runId?: string;
      /** Composer transactions must distinguish rejection from acceptance. */
      rejectOnFailure?: boolean;
    },
  ) => Promise<void>;
  stopStream: () => Promise<void>;
  stopThreadRun: (threadId: string, runId?: string) => Promise<void>;
  dispatchAgentEvent: (event: AgentEvent) => void;
  flushAgentEventBuffer: () => void;
  dispatchAgentChunk: (chunk: AgentChunk) => void;
  reconcileRunningRunsFromSnapshot: (
    running: Record<string, RunInfo>,
    requestProjections?: Readonly<Record<string, ThreadProjection>>,
  ) => void;
  reconcileRunningRuns: () => Promise<Record<string, RunInfo>>;
}
