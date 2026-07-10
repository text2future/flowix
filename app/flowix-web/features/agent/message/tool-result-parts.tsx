"use client";

import { useState } from "react";
import { TOOL_ICON_PATHS } from "@features/agent/message/tool-icon-paths";
import { truncateStart } from "@features/agent/message/format";
import { useI18n, type I18nParams } from "@features/i18n";

/* TOOL_ICON_PATHS 来自 ./tool-icon-paths.ts ── 直接依赖避免与
 * ./tools.tsx 形成循环 (本文件 → tool-icon-paths 走 path 字符串,
 * 互不指向对方)。 */

/* ════════════════════════════════════════════════════════════════════════
 *  Tool 结果渲染原语 ── file/folder entry 图标 + 代码块展示
 * ════════════════════════════════════════════════════════════════════════
 *
 *  FileList / EntriesList / GrepResult 用这些原语组合出 glob / ls /
 *  grep 工具结果的"列表型"展示 ── 每行一个 entry 图标 + 文本。
 *  CompactCode 展示代码块 (含展开/收起); MetaLine 展示 key-value 行。
 * ════════════════════════════════════════════════════════════════════════ */

/* ── CompactCode ── 带展开/收起的代码块 ──────────────────────────────
 * value: 完整字符串; maxLines: 默认折叠后显示的行数; 字符超 1600 也触发展开 */
export function CompactCode({
  value,
  maxLines = 8,
}: {
  value: string;
  maxLines?: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const lines = value.split("\n");
  const hasMore = lines.length > maxLines || value.length > 1600;
  const display = expanded
    ? value
    : lines
        .slice(0, maxLines)
        .join("\n")
        .slice(0, 1600);

  if (!value.trim()) {
    return (
      <span className="text-xs text-[var(--muted-foreground)]">{t("agent.tool.empty")}</span>
    );
  }

  return (
    <div className="space-y-1.5">
      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--muted)] px-2 py-1.5 text-xs font-mono text-[var(--muted-foreground)]">
        {display}
        {hasMore && !expanded ? "\n..." : ""}
      </pre>
      {hasMore && (
        <button
          type="button"
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--agent-foreground)]"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("agent.tool.collapse") : t("agent.tool.expand")}
        </button>
      )}
    </div>
  );
}

/* ── FileList ── glob 匹配路径列表 ────────────────────────────────── */
export function FileList({ paths }: { paths: string[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? paths : paths.slice(0, 8);

  if (paths.length === 0) {
    return (
      <span className="text-xs text-[var(--muted-foreground)]">{t("agent.tool.noMatches")}</span>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-1">
        {visible.map((path) => (
          <div
            key={path}
            className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]"
          >
            <svg
              viewBox="0 0 256 256"
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0"
            >
              <path d={TOOL_ICON_PATHS.fileText} fill="currentColor" />
            </svg>
            <span className="font-mono" title={path}>
              {truncateStart(path, 72)}
            </span>
          </div>
        ))}
      </div>
      {paths.length > 8 && (
        <button
          type="button"
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--agent-foreground)]"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("agent.tool.collapse") : t("agent.tool.expandItems", { count: paths.length - 8 } satisfies I18nParams)}
        </button>
      )}
    </div>
  );
}

/* ── EntriesList ── ls 目录条目列表 ────────────────────────────────── */
export function EntriesList({ entries }: { entries: any[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? entries : entries.slice(0, 10);

  if (entries.length === 0) {
    return (
      <span className="text-xs text-[var(--muted-foreground)]">{t("agent.tool.emptyDir")}</span>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="grid gap-1">
        {visible.map((entry, index) => {
          const isDir = Boolean(entry.is_dir);
          const iconPath = isDir ? TOOL_ICON_PATHS.folder : TOOL_ICON_PATHS.fileText;
          const label = String(entry.name ?? entry.path ?? `item-${index}`);
          return (
            <div
              key={`${label}-${index}`}
              className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]"
            >
              <svg
                viewBox="0 0 256 256"
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0"
              >
                <path d={iconPath} fill="currentColor" />
              </svg>
              <span
                className="min-w-0 flex-1 truncate font-mono"
                title={String(entry.path ?? label)}
              >
                {label}
              </span>
              {!isDir && typeof entry.size === "number" && (
                <span className="shrink-0 text-[var(--muted-foreground)]">
                  {entry.size} B
                </span>
              )}
            </div>
          );
        })}
      </div>
      {entries.length > 10 && (
        <button
          type="button"
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--agent-foreground)]"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("agent.tool.collapse") : t("agent.tool.expandEntries", { count: entries.length - 10 } satisfies I18nParams)}
        </button>
      )}
    </div>
  );
}

/* ── GrepResult ── grep 匹配结果 ───────────────────────────────────── */
export function GrepResult({ matches }: { matches: any[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? matches : matches.slice(0, 6);

  if (matches.length === 0) {
    return (
      <span className="text-xs text-[var(--muted-foreground)]">{t("agent.tool.noMatches")}</span>
    );
  }

  return (
    <div className="space-y-1.5">
      {visible.map((match, index) => (
        <div key={index} className="rounded-md bg-[var(--muted)] px-2 py-1.5">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <svg viewBox="0 0 256 256" aria-hidden="true" className="h-3.5 w-3.5">
              <path d={TOOL_ICON_PATHS.fileText} fill="currentColor" />
            </svg>
            <span className="font-mono" title={String(match.path ?? "")}>
              {truncateStart(String(match.path ?? ""), 56)}:{match.line}
            </span>
          </div>
          <div className="break-words font-mono text-xs text-[var(--muted-foreground)]">
            {String(match.text ?? "")}
          </div>
        </div>
      ))}
      {matches.length > 6 && (
        <button
          type="button"
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--agent-foreground)]"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("agent.tool.collapse") : t("agent.tool.expandMatches", { count: matches.length - 6 } satisfies I18nParams)}
        </button>
      )}
    </div>
  );
}

/* ── MetaLine ── 单条 "label: value" 元数据行 ──────────────────────── */
export function MetaLine({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="shrink-0 text-[var(--muted-foreground)]">{label}</span>
      <span
        className="min-w-0 break-all font-mono text-[var(--muted-foreground)]"
        title={value}
      >
        {truncateStart(value, 84)}
      </span>
    </div>
  );
}