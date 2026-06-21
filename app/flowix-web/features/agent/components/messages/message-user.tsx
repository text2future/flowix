import { memo } from "react";
import type { ChatMessage as ChatMessageType } from "@/types";
import { parseYamlMeta } from "@features/agent/message/parse";
import { truncateStart } from "@features/agent/message/format";
import { getAgentMessageVisibleContent } from "@features/agent/message/agent-message";
import { MarkdownRenderer } from "@features/agent/components/messages/markdown-renderer";
import { CitationCard } from "@features/agent/components/citation-card";

interface MessageUserProps {
  message: ChatMessageType;
}

function MessageUserInner({ message }: MessageUserProps) {
  // Parse YAML meta + optional `<citation>` block. The citation lives at the
  // top of the payload and is rendered as a card above the bubble body,
  // matching the inputbox's pre-send preview.
  const { meta, citation, content } = parseYamlMeta(message.content);
  const visibleContent = getAgentMessageVisibleContent({ ...message, content });

  return (
    <>
      <div className="flex flex-row-reverse gap-3">
        <div className="flex flex-col gap-1 w-fit items-end max-w-full">
          <div className="py-2" />
          {meta.selecteditem && (
            <div
              className="flex items-center gap-1 text-xs text-[var(--agent-foreground)] bg-[var(--card)] px-2 py-1 rounded border border-[var(--border)] max-w-[300px]"
              title={meta.selecteditem}
            >
              <span>{truncateStart(meta.selecteditem)}</span>
            </div>
          )}
          {citation && <CitationCard text={citation} />}
          <div className="bg-[var(--muted)] rounded-tl-lg rounded-tr-2xl rounded-bl-lg rounded-br-lg py-2 px-3 text-sm text-[var(--agent-foreground)] w-fit max-w-full">
            <MarkdownRenderer content={visibleContent} />
          </div>
        </div>
      </div>
      <div className="py-1" />
    </>
  );
}

// Layer 1: user 消息一旦发送 content 不再变化, memo 之后历史 user 消息
// 永远跳过 re-render.
export const MessageUser = memo(
  MessageUserInner,
  (prev, next) =>
    prev.message === next.message ||
    (prev.message.id === next.message.id &&
      prev.message.content === next.message.content)
);
