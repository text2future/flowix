export const CONTEXT_PROMPT_MARKER = '<## CONTEXT PROMPT ##>';

// 匹配 `<## CONTEXT PROMPT ##>` 的所有大小写变体 ── LLM/上游在拼装 user
// 首条消息时偶尔会把标记写成 `<## CONTEXT Prompt ##>` (小写 p) 等,
// 直接 split 会出现漏切, 标题就会被上下文片段污染。
const SYSTEM_CONTEXT_PATTERN = /(?:<\s*##\s*CONTEXT\s+PROMPT\s+##\s*>|\[Flowix workspace context\])/i;

export function stripSystemBlock(content: string): string {
  if (!content) return content;
  const visible = content.replace(/\s*<!-- FLOWIX_ACTIVE_DOCUMENT_CONTEXT\n[\s\S]*?\nEND_FLOWIX_ACTIVE_DOCUMENT_CONTEXT -->/g, '');
  const match = visible.match(SYSTEM_CONTEXT_PATTERN);
  if (!match || match.index === undefined) return visible.trim();
  return visible.slice(0, match.index).trim();
}
