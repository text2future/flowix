// format.ts ── 字符串 / 时间格式化工具, 非工具元数据。
//
// 历史: formatToolName 一度在此文件 ── 它是工具元数据, 已迁到 ./tools.tsx
// (单源真源, getToolLabel)。本文件保留 truncateStart / extractFileName
// 两个纯字符串工具, 被 message-tool.tsx / message-user.tsx / agent-message.ts
// 共用 ── 不归"工具元数据", 保留。

export function truncateStart(path: string, maxChars: number = 20): string {
  if (path.length <= maxChars) return path;
  return "..." + path.slice(-maxChars);
}

/**
 * Extracts a compact file name for tool message summaries.
 * Removes the file extension from a path's final component.
 */
export function extractFileName(path: string): string {
  // Strip the extension from the on-disk filename.
  const fileName = path.split("/").pop() ?? path.split("\\").pop() ?? path;

  const lastDot = fileName.lastIndexOf(".");
  const afterDot = lastDot >= 0 ? fileName.slice(lastDot + 1) : "";
  const hasProperExtension =
    lastDot > 0 && /^[a-zA-Z]{1,5}$/.test(afterDot) && afterDot.length <= 5;

  const withoutExt = hasProperExtension ? fileName.slice(0, lastDot) : fileName;

  return withoutExt || fileName;
}
