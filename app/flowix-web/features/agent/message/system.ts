export const CONTEXT_PROMPT_MARKER = '<## CONTEXT PROMPT ##>';

// 匹配 `<## CONTEXT PROMPT ##>` 的所有大小写变体 ── LLM/上游在拼装 user
// 首条消息时偶尔会把标记写成 `<## CONTEXT Prompt ##>` (小写 p) 等,
// 直接 split 会出现漏切, 标题就会被上下文片段污染。
const CONTEXT_PROMPT_PATTERN = /<\s*##\s*CONTEXT\s+PROMPT\s+##\s*>/i;

export function stripSystemBlock(content: string): string {
  if (!content) return content;
  const match = content.match(CONTEXT_PROMPT_PATTERN);
  if (!match || match.index === undefined) return content.trim();
  return content.slice(0, match.index).trim();
}
