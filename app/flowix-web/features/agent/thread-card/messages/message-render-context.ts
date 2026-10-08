import type { AppLanguage } from "@/lib/i18n";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";

export type AgentMessage = ThreadState["messages"][number];

export interface AgentThreadCardMessageRenderContext {
  language: AppLanguage;
  /** True while the current turn is still producing items. */
  isLoading: boolean;
  getReasoningCollapsed: (message: AgentMessage) => boolean;
  setReasoningCollapsed: (messageId: string, collapsed: boolean) => void;
  getDisplayExpanded: (message: AgentMessage) => boolean;
  setDisplayExpanded: (messageId: string, expanded: boolean) => void;
  getToolGroupExpanded?: (groupId: string) => boolean;
  setToolGroupExpanded?: (groupId: string, expanded: boolean) => void;
  getImageSpacePath?: (filePath: string) => string | null;
  /**
   * Whether a message is still growing in the current stream. Streaming
   * messages use incremental Markdown rendering; completed messages use the
   * full parser so block boundaries converge to the final Markdown shape.
   */
  isStreaming: (message: AgentMessage) => boolean;
  onForkMessage?: (message: AgentMessage) => void | Promise<void>;
}
