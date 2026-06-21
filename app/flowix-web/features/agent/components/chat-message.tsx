import { memo } from "react";
import type { ChatMessage as ChatMessageType } from "@/types";
import {
  MessageUser,
  MessageAssistant,
  MessageReasoning,
  MessageTool,
  MessageEnd,
} from "@features/agent/components/messages";

interface ChatMessageProps {
  message: ChatMessageType;
}

// Role to component mapping
const roleToComponent = {
  user: MessageUser,
  assistant: MessageAssistant,
  system: MessageAssistant,
  reasoning: MessageReasoning,
  tool: MessageTool,
  end: MessageEnd,
};

// memo 浅比较的字段 ── 与 `types/index.ts:168-185` 的 `ChatMessage` 展示字段对齐.
// 只比较影响渲染的字段, 跳过 `timestamp / llmContent / systemReminder*` 等
// 与 UI 无关字段 (timestamp 在 user/assistant 当前未渲染; llmContent 仅给后端).
//
// **必须严格对齐**: 漏字段 → 组件不更新; 多比较字段 → 浪费 CPU 但行为正确.
// 后续若 ChatMessage 新增展示字段, 同步更新此处.
function isSameMessage(a: ChatMessageType, b: ChatMessageType): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.role === b.role &&
      a.content === b.content &&
      a.reasoning === b.reasoning &&
      a.toolData === b.toolData &&
      a.toolName === b.toolName &&
      a.toolCallId === b.toolCallId &&
      a.toolInput === b.toolInput &&
      a.toolCalls === b.toolCalls &&
      a.isLoading === b.isLoading &&
      a.isCompleted === b.isCompleted &&
      a.isCollapsed === b.isCollapsed)
  );
}

// Layer 1: 用 React.memo 包裹, 避免流式 chunk 触发 messages 数组引用变化时
// 让全部历史 message 子树重新进入 react-markdown 重 parse. chat-store 内
// `closedMessages.map(m => m.id === pending ? {...m, content: ...} : m)`
// 对未命中分支直接返回 m, 对象引用稳定 → 此处浅比较能正确跳过.
function ChatMessageInner({ message }: ChatMessageProps) {
  // Look up the component by role
  const Component = roleToComponent[message.role];

  if (!Component) {
    return null;
  }

  return <Component message={message} />;
}

export const ChatMessage = memo(ChatMessageInner, (prev, next) => {
  if (prev.message === next.message) return true;
  return isSameMessage(prev.message, next.message);
});
