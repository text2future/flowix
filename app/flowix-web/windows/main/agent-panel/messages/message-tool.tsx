'use client';

import { useMemo, useState } from "react";
import type { ChatMessage } from "../../../../types";
import { getToolIcon } from "../../../../lib/message/icons";
import { truncateStart } from "../../../../lib/message/format";
import {
  agentMessageValueToText,
  createAgentMessageViewModel,
} from "../../../../lib/message/agent-message";
import { cn } from "../../../../lib/utils";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
} from "lucide-react";

interface ToolResult {
  success?: boolean;
  data?: any;
  error?: string | null;
}

function parseToolResult(content: string): ToolResult {
  if (!content.trim()) {
    return {};
  }

  try {
    return JSON.parse(content);
  } catch {
    return { success: true, data: content };
  }
}

function CompactCode({ value, maxLines = 8 }: { value: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = value.split("\n");
  const hasMore = lines.length > maxLines || value.length > 1600;
  const display = expanded ? value : lines.slice(0, maxLines).join("\n").slice(0, 1600);

  if (!value.trim()) {
    return <span className="text-xs text-[var(--muted-foreground)]">无输出</span>;
  }

  return (
    <div className="space-y-1.5">
      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--muted)] px-2 py-1.5 text-xs font-mono text-[var(--muted-foreground)]">
        {display}{hasMore && !expanded ? "\n..." : ""}
      </pre>
      {hasMore && (
        <button
          type="button"
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--agent-foreground)]"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}

function FileList({ paths }: { paths: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? paths : paths.slice(0, 8);

  if (paths.length === 0) {
    return <span className="text-xs text-[var(--muted-foreground)]">无匹配项</span>;
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-1">
        {visible.map((path) => (
          <div key={path} className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="font-mono" title={path}>{truncateStart(path, 72)}</span>
          </div>
        ))}
      </div>
      {paths.length > 8 && (
        <button
          type="button"
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--agent-foreground)]"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : `展开 ${paths.length - 8} 项`}
        </button>
      )}
    </div>
  );
}

function EntriesList({ entries }: { entries: any[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? entries : entries.slice(0, 10);

  if (entries.length === 0) {
    return <span className="text-xs text-[var(--muted-foreground)]">空目录</span>;
  }

  return (
    <div className="space-y-1.5">
      <div className="grid gap-1">
        {visible.map((entry, index) => {
          const isDir = Boolean(entry.is_dir);
          const Icon = isDir ? Folder : FileText;
          const label = String(entry.name ?? entry.path ?? `item-${index}`);
          return (
            <div key={`${label}-${index}`} className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono" title={String(entry.path ?? label)}>
                {label}
              </span>
              {!isDir && typeof entry.size === "number" && (
                <span className="shrink-0 text-[var(--muted-foreground)]">{entry.size} B</span>
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
          {expanded ? "收起" : `展开 ${entries.length - 10} 项`}
        </button>
      )}
    </div>
  );
}

function GrepResult({ matches }: { matches: any[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? matches : matches.slice(0, 6);

  if (matches.length === 0) {
    return <span className="text-xs text-[var(--muted-foreground)]">无匹配项</span>;
  }

  return (
    <div className="space-y-1.5">
      {visible.map((match, index) => (
        <div key={index} className="rounded-md bg-[var(--muted)] px-2 py-1.5">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <FileText className="h-3.5 w-3.5" />
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
          {expanded ? "收起" : `展开 ${matches.length - 6} 条`}
        </button>
      )}
    </div>
  );
}

function ToolBody({ toolName, result }: { toolName?: string; result: ToolResult }) {
  const name = toolName?.toLowerCase();
  const data = result.data;

  if (result.error) {
    return <CompactCode value={result.error} maxLines={4} />;
  }

  if (name === "read") {
    return (
      <div className="space-y-1.5">
        {data?.path && <MetaLine label="文件" value={String(data.path)} />}
        <CompactCode value={String(data?.content ?? "")} />
        {data?.truncated && <span className="text-xs text-[var(--muted-foreground)]">内容已截断</span>}
      </div>
    );
  }

  if (name === "write") {
    return (
      <div className="space-y-1">
        <MetaLine label="文件" value={String(data?.path ?? "")} />
        <MetaLine label="字节" value={String(data?.bytes_written ?? 0)} />
        {data?.append && <MetaLine label="模式" value="追加" />}
      </div>
    );
  }

  if (name === "edit") {
    return (
      <div className="space-y-1">
        <MetaLine label="文件" value={String(data?.path ?? "")} />
        <MetaLine label="原内容" value={`${String(data?.old_bytes ?? 0)} B`} />
        <MetaLine label="新内容" value={`${String(data?.new_bytes ?? 0)} B`} />
        <MetaLine label="字节" value={String(data?.bytes_written ?? 0)} />
      </div>
    );
  }

  if (name === "ls") {
    return <EntriesList entries={Array.isArray(data?.entries) ? data.entries : []} />;
  }

  if (name === "glob") {
    return <FileList paths={Array.isArray(data?.matches) ? data.matches.map(String) : []} />;
  }

  if (name === "grep") {
    return <GrepResult matches={Array.isArray(data?.matches) ? data.matches : []} />;
  }

  if (name === "bash") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)]">
          <span>退出码: {data?.exit_code ?? "未知"}</span>
          {data?.truncated && <span>已截断</span>}
        </div>
        {data?.stdout && <CompactCode value={String(data.stdout)} />}
        {data?.stderr && <CompactCode value={String(data.stderr)} maxLines={5} />}
        {!data?.stdout && !data?.stderr && <span className="text-xs text-[var(--muted-foreground)]">无输出</span>}
      </div>
    );
  }

  return <CompactCode value={agentMessageValueToText(data ?? result)} />;
}

function MetaLine({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="shrink-0 text-[var(--muted-foreground)]">{label}</span>
      <span className="min-w-0 break-all font-mono text-[var(--muted-foreground)]" title={value}>
        {truncateStart(value, 84)}
      </span>
    </div>
  );
}

function ToolInput({ input }: { input?: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const text = useMemo(() => {
    if (!input || Object.keys(input).length === 0) return "";
    return JSON.stringify(input, null, 2);
  }, [input]);

  if (!text) return null;

  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--agent-foreground)]"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        输入参数
      </button>
      {expanded && <CompactCode value={text} maxLines={6} />}
    </div>
  );
}

// 代码内开关：设为 true 可在工具消息中显示输出结果和输入参数（默认 false）
const SHOW_TOOL_DETAILS = false;

export function MessageTool({ message }: { message: ChatMessage }) {
  const result = parseToolResult(String(message.toolData || message.content || ""));
  const ToolIcon = getToolIcon(message.toolName);
  const isLoading = Boolean(message.isLoading);
  const messageView = createAgentMessageViewModel(message);

  return (
    <div className="flex gap-3">
      <div className="w-full pr-1 py-1.5">
        <div className="flex items-center gap-2">
          <ToolIcon className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
          <span className="text-sm text-[var(--agent-foreground)]">{messageView.toolLabel}</span>
          {messageView.toolSummary && (
            <span className="min-w-0 truncate font-mono text-xs text-[var(--muted-foreground)]" title={messageView.toolSummary}>
              {messageView.toolSummary}
            </span>
          )}
          {isLoading && <Loader2 className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin text-[var(--muted-foreground)]" />}
        </div>

        {SHOW_TOOL_DETAILS && !isLoading && (
          <div className={cn("mt-2 border-l border-[var(--border)] pl-3")}>
            <div className="space-y-2">
              <ToolBody toolName={message.toolName} result={result} />
              <ToolInput input={message.toolInput} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
