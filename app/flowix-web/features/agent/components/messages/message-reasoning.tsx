import { memo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChatMessage as ChatMessageType } from "@/types";
import { useSettingsStore } from "@features/shell";
import {
  getAgentMessageVisibleContent,
  getAgentReasoningLabel,
} from "@features/agent/message/agent-message";
import { MarkdownRenderer } from "@features/agent/components/messages/markdown-renderer";

interface MessageReasoningProps {
  message: ChatMessageType;
}

function MessageReasoningInner({ message }: MessageReasoningProps) {
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

// Layer 1: 当 message props 不变时跳过. 内部消费的 `reasoningCollapsed` /
// `toggleReasoningCollapsed` 来自 useSettingsStore, store 变化时 zustand
// 会自然触发该组件重渲, 与外层 memo 不冲突 (memo 只挡 props 相同时的
// 父级 re-render, 不挡 hook 订阅触发的内部更新).
export const MessageReasoning = memo(
  MessageReasoningInner,
  (prev, next) =>
    prev.message === next.message ||
    (prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.message.reasoning === next.message.reasoning &&
      prev.message.isCompleted === next.message.isCompleted)
);
