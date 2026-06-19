import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChatMessage as ChatMessageType } from "../../../../types";
import { useSettingsStore } from "../../../../lib/store";
import {
  getAgentMessageVisibleContent,
  getAgentReasoningLabel,
} from "../../../../lib/message/agent-message";
import { MarkdownRenderer } from "./markdown-renderer";

interface MessageReasoningProps {
  message: ChatMessageType;
}

export function MessageReasoning({ message }: MessageReasoningProps) {
  const reasoningCollapsed = useSettingsStore((state) => state.reasoningCollapsed);
  const toggleReasoningCollapsed = useSettingsStore((state) => state.toggleReasoningCollapsed);

  const buttonText = getAgentReasoningLabel(message);
  const visibleContent = getAgentMessageVisibleContent(message);

  return (
    <div className="flex gap-3">
      <div className="flex flex-col gap-1 w-full">
        <button
          onClick={toggleReasoningCollapsed}
          className="flex items-center gap-2 text-sm text-[var(--agent-foreground)] hover:text-[var(--muted-foreground)] transition-colors"
        >
          {reasoningCollapsed ? (
            <ChevronRight className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
          <span>{buttonText}</span>
        </button>

        {!reasoningCollapsed && (
          <div className="flex flex-col items-start gap-2 text-sm text-[var(--muted-foreground)] mt-1 pl-4 ml-1.5 border-l border-[var(--border)]">
            <MarkdownRenderer content={visibleContent} />
          </div>
        )}
      </div>
    </div>
  );
}
