'use client';

import { memo } from "react";
import type { ChatMessage } from "@/types";
import { getToolIconPath } from "@features/agent/message/tools";
import { createAgentMessageViewModel } from "@features/agent/message/agent-message";
import { Loader2 } from "lucide-react";

function MessageToolInner({ message }: { message: ChatMessage }) {
  const iconPath = getToolIconPath(message.toolName);
  const isLoading = Boolean(message.isLoading);
  const messageView = createAgentMessageViewModel(message);

  return (
    <div className="flex gap-3">
      <div className="w-full pr-1 py-1.5">
        {/* 工具展示条 ── 单行 flex: icon | label | summary | loader。
         * 间距用 individual margins 而非 parent gap, 因为 icon → label
         * 间距是其它的一半 (mr-1 = 4px), 其它都是 mr-2 (8px)。
         * label 用 whitespace-nowrap + shrink-0 防止 summary 长内容
         * 把它挤换行; summary 用 flex-1 + min-w-0 + truncate 占剩余
         * 空间并省略。loader 用 ml-auto 靠右。 */}
        <div className="flex items-center">
          <svg
            viewBox="0 0 256 256"
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 mr-1 text-[var(--muted-foreground)]"
          >
            <path d={iconPath} fill="currentColor" />
          </svg>
          <span className="shrink-0 whitespace-nowrap mr-2 text-sm text-[var(--agent-foreground)]">{messageView.toolLabel}</span>
          {messageView.toolSummary && (
            <span className="min-w-0 flex-1 truncate mr-2 font-mono text-xs text-[var(--muted-foreground)]" title={messageView.toolSummary}>
              {messageView.toolSummary}
            </span>
          )}
          {isLoading && <Loader2 className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin text-[var(--muted-foreground)]" />}
        </div>
      </div>
    </div>
  );
}

// Layer 1: tool 行的展示依赖 toolName/toolInput/toolData/isLoading.
// `createAgentMessageViewModel` 对这些字段消费, 不变则视图不变.
// toolInput / toolCalls 是对象引用 ── 浅比较即可: chat-store
// `applyToolCallChunk` / `applyToolResultChunk` 命中目标行才重建对象,
// 其它行引用稳定.
export const MessageTool = memo(
  MessageToolInner,
  (prev, next) =>
    prev.message === next.message ||
    (prev.message.id === next.message.id &&
      prev.message.toolName === next.message.toolName &&
      prev.message.toolData === next.message.toolData &&
      prev.message.toolInput === next.message.toolInput &&
      prev.message.toolCalls === next.message.toolCalls &&
      prev.message.isLoading === next.message.isLoading)
);