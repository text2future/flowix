import type { ChatMessage as ChatMessageType } from "../../../../types";
import { parseYamlMeta } from "../../../../lib/message/parse";
import { truncateStart } from "../../../../lib/message/format";
import { Quote } from "lucide-react";
import { MarkdownRenderer } from "./markdown-renderer";
import "../../../../css/agent-message.css";

interface MessageUserProps {
  message: ChatMessageType;
}

export function MessageUser({ message }: MessageUserProps) {
  // Parse YAML meta + optional `<citation>` block. The citation lives at the
  // top of the payload and is rendered as a card above the bubble body,
  // matching the inputbox's pre-send preview.
  const { meta, citation, content } = parseYamlMeta(message.content);

  return (
    <div className="flex flex-row-reverse gap-3">
      <div className="flex flex-col gap-1 w-fit items-end max-w-full">
        {meta.selecteditem && (
          <div
            className="flex items-center gap-1 text-xs text-[var(--agent-text-primary)] bg-[var(--popover)] px-2 py-1 rounded border border-[var(--border)] max-w-[300px]"
            title={meta.selecteditem}
          >
            <span className="">{truncateStart(meta.selecteditem)}</span>
          </div>
        )}
        {citation && (
          <div
            className="citation-card w-full"
            title={citation}
          >
            <Quote className="citation-card-icon" />
            <span className="citation-card-text">{citation}</span>
          </div>
        )}
        <div className="bg-[var(--agent-bg-user)] rounded-lg p-3 text-sm text-[var(--agent-text-primary)] agent-message w-fit max-w-full">
          <MarkdownRenderer content={content} />
        </div>
      </div>
    </div>
  );
}