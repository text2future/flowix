import type { ChatMessage as ChatMessageType } from "../../../types";
import {
  MessageUser,
  MessageAssistant,
  MessageReasoning,
  MessageTool,
  MessageEnd,
} from "./messages";

interface ChatMessageProps {
  message?: ChatMessageType;
  fallback?: React.ReactNode;
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

export function ChatMessage({ message, fallback }: ChatMessageProps) {
  // Render fallback when no message
  if (fallback && !message) {
    return <>{fallback}</>;
  }

  if (!message) {
    return null;
  }

  // Look up the component by role
  const Component = roleToComponent[message.role];

  if (!Component) {
    return null;
  }

  return <Component message={message} />;
}