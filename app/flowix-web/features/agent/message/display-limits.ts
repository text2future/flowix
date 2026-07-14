export const USER_MESSAGE_DISPLAY_MAX_CHARS = 1000;
export const ASSISTANT_MESSAGE_DISPLAY_MAX_CHARS = 12000;
export const REASONING_MESSAGE_DISPLAY_MAX_CHARS = 6000;
export const TOOL_MESSAGE_DISPLAY_MAX_CHARS = 1000;
export const TOOL_RESULT_DISPLAY_MAX_CHARS = 4096;
export const TOOL_RESULT_OUTPUT_PREVIEW_MAX_CHARS = 2000;

const DISPLAY_ELLIPSIS = "…";
const TRUNCATED_MARKER = "\n...[truncated]";

export type MessageDisplayBudgetRole = "user" | "assistant" | "reasoning";

export interface DisplayBudgetResult {
  text: string;
  isOverBudget: boolean;
}

export function getMessageDisplayMaxChars(
  role: MessageDisplayBudgetRole,
): number {
  if (role === "user") return USER_MESSAGE_DISPLAY_MAX_CHARS;
  if (role === "reasoning") return REASONING_MESSAGE_DISPLAY_MAX_CHARS;
  return ASSISTANT_MESSAGE_DISPLAY_MAX_CHARS;
}

export function truncateByCodePoint(
  text: string,
  maxChars: number,
  suffix = DISPLAY_ELLIPSIS,
): string {
  if (maxChars <= 0) return suffix;
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join("") + suffix;
}

export function applyMessageDisplayBudget(
  role: MessageDisplayBudgetRole,
  text: string,
  expanded: boolean,
): DisplayBudgetResult {
  const maxChars = getMessageDisplayMaxChars(role);
  const isOverBudget = Array.from(text).length > maxChars;
  return {
    text: expanded || !isOverBudget ? text : truncateByCodePoint(text, maxChars),
    isOverBudget,
  };
}

export function truncateUserMessageForDisplay(text: string): string {
  return applyMessageDisplayBudget("user", text, false).text;
}

export function truncateToolMessageForDisplay(text: string): string {
  return truncateByCodePoint(text, TOOL_MESSAGE_DISPLAY_MAX_CHARS);
}

export function truncateToolResultForDisplay(text: string): string {
  return truncateByCodePoint(
    text,
    TOOL_RESULT_DISPLAY_MAX_CHARS,
    TRUNCATED_MARKER,
  );
}

export function truncateToolResultOutputPreview(text: string): string {
  return truncateByCodePoint(
    text,
    TOOL_RESULT_OUTPUT_PREVIEW_MAX_CHARS,
    TRUNCATED_MARKER,
  );
}
