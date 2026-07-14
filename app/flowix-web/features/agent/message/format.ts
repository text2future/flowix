// format.ts ── 字符串 / 时间格式化工具, 非工具元数据。
//
// 历史: formatToolName 一度在此文件 ── 它是工具元数据, 已迁到 ./tools.tsx
// (单源真源, getToolLabel)。本文件保留 truncateStart / extractFileName /
// formatRelativeTime 三个工具, 被 message-tool.tsx / message-user.tsx /
// agent-message.ts 共用 ── 不归"工具元数据", 保留。

import { translate, type AppLanguage, type I18nParams } from "@features/i18n";

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

export function formatRelativeTime(timestamp: number, language: AppLanguage = "zh-CN"): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  const intlLocale = language === "zh-CN" ? "zh-CN" : "en-US";
  if (diffSec < 60) return translate(language, "agent.time.justNow");
  if (diffMin < 60) return translate(language, "agent.time.minutesAgo", { m: diffMin } satisfies I18nParams);
  if (diffHour < 24) return translate(language, "agent.time.hoursAgo", { h: diffHour } satisfies I18nParams);
  if (diffDay < 7) return translate(language, "agent.time.daysAgo", { d: diffDay } satisfies I18nParams);
  return new Date(timestamp).toLocaleDateString(intlLocale);
}
