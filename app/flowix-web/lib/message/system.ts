const SYSTEM_BLOCK_RE = /<(system|system-reminder)>[\s\S]*?<\/\1>\s*/g;

export function stripSystemBlock(content: string): string {
  if (!content) return content;
  return content.replace(SYSTEM_BLOCK_RE, '').trim();
}
