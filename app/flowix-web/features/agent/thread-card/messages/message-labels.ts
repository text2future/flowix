import { translate, type AppLanguage } from "@/lib/i18n";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
type AgentMessage = ThreadState["messages"][number];

export function getMessageDateTimeText(message: AgentMessage, language: AppLanguage): string {
  const date = new Date(message.timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function getMessageDurationText(
  message: AgentMessage,
  language: AppLanguage,
): string | undefined {
  const durationMs = message.turnDurationMs;
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return undefined;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (language === "zh-CN") {
    return minutes === 0 ? `${seconds}秒` : `${minutes}分${seconds}秒`;
  }
  return `Duration ${minutes}m${seconds}s`;
}

export function getCommandModeLabel(message: AgentMessage, language: AppLanguage): string | null {
  if (
    message.messageType !== "dsh-command" &&
    message.messageType !== "dsh-command-prompt" &&
    message.messageType !== "codex-command"
  ) {
    return null;
  }

  const command = message.content.trim();
  if (
    message.messageType === "dsh-command-prompt" ||
    /^\/plan(?:\s|$)/iu.test(command)
  ) {
    return translate(language, "editor.threadCard.commandMode.plan");
  }
  if (/^\/goal(?:\s|$)/iu.test(command)) {
    return translate(language, "editor.threadCard.commandMode.goal");
  }
  return null;
}

