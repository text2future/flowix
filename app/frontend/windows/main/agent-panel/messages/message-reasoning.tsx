import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChatMessage as ChatMessageType } from "../../../../types";
import { useSettingsStore } from "../../../../lib/store";
import { MarkdownRenderer } from "./markdown-renderer";
import "../../../../css/agent-message.css";

interface MessageReasoningProps {
  message: ChatMessageType;
}

export function MessageReasoning({ message }: MessageReasoningProps) {
  const reasoningCollapsed = useSettingsStore((state) => state.reasoningCollapsed);
  const toggleReasoningCollapsed = useSettingsStore((state) => state.toggleReasoningCollapsed);

  const buttonText = message.isCompleted ? "Thought completed" : "Thinking";

  return (
    <div className="flex gap-3">
      <div className="flex flex-col gap-1 w-full">
        <button
          onClick={toggleReasoningCollapsed}
          className="flex items-center gap-2 text-sm text-[var(--agent-text-primary)] hover:text-[var(--muted-foreground)] transition-colors"
        >
          {reasoningCollapsed ? (
            <ChevronRight className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
          <span>{buttonText}</span>
        </button>

        {!reasoningCollapsed && (
          <div className="agent-message flex flex-col items-start gap-2 text-sm text-[var(--agent-text-secondary)] mt-1 pl-4 ml-1.5 border-l border-[var(--border)]">
            <MarkdownRenderer content={message.content} />
          </div>
        )}
      </div>
    </div>
  );
}
