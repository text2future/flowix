export function formatToolName(name: string | undefined): string {
  if (!name) return "未知";

  const labels: Record<string, string> = {
    read: "读取",
    write: "写入",
    edit: "编辑",
    ls: "列出目录",
    glob: "通配匹配",
    grep: "内容搜索",
    bash: "执行命令",
    command_execution: "cmd",
    list_notebooks: "列出笔记本",
  };

  if (labels[name]) return labels[name];

  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function truncateStart(path: string, maxChars: number = 20): string {
  if (path.length <= maxChars) return path;
  return "..." + path.slice(-maxChars);
}

/**
 * Extracts a compact file name for tool message summaries.
 * Removes the memo id suffix in the #xxxxxx format and then the extension.
 */
export function extractFileName(path: string): string {
  // v3 改造: filename 已经是磁盘文件名 (xxx.md), 不再带 #memoid 后缀,
  // 因此 memoIdPattern 分支移除 ── 直接按扩展名规则剥掉 .md / .txt 等。
  const fileName = path.split("/").pop() ?? path.split("\\").pop() ?? path;

  const lastDot = fileName.lastIndexOf(".");
  const afterDot = lastDot >= 0 ? fileName.slice(lastDot + 1) : "";
  const hasProperExtension =
    lastDot > 0 && /^[a-zA-Z]{1,5}$/.test(afterDot) && afterDot.length <= 5;

  const withoutExt = hasProperExtension ? fileName.slice(0, lastDot) : fileName;

  return withoutExt || fileName;
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay < 7) return `${diffDay}天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}
