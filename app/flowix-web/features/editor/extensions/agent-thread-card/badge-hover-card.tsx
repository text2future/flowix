import * as React from "react";
import { Check, Copy } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@shared/ui/hover-card";
import { useI18n } from "@features/i18n";
import { cn } from "@/lib/utils";

interface BadgeHoverCardProps {
  /** SESSION ID (agent thread id) */
  sessionId: string;
  /** 当前 run 锁定的 LLM model id(由通用 metadata 协议填入) */
  model?: string;
  lastRunAt?: number;
  /** 本次运行的持续毫秒数,undefined 表示未运行 / 不可用 */
  /** 当前 run 累计 token 用量(undefined 表示未上报) */
  totalTokens?: number;
}

function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return n.toLocaleString("en-US");
  const units = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "K" },
  ];
  const unit = units.find((item) => abs >= item.value)!;
  const value = n / unit.value;
  const digits = Math.abs(value) >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")}${unit.suffix}`;
}

/**
 * 把毫秒格式化成 "1h 23m 45s" / "23m 45s" / "45s"。
 */
function formatRelativeTime(timestamp: number, language: string): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const isZh = language.startsWith("zh");
  if (totalSeconds < 60) return isZh ? "刚刚" : "just now";

  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return isZh ? `${minutes}分钟前` : `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return isZh ? `${hours}小时前` : `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return isZh ? `${days}天前` : `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return isZh ? `${months}个月前` : `${months}mo ago`;

  const years = Math.floor(days / 365);
  return isZh ? `${years}年前` : `${years}y ago`;
}

/**
 * Agent Thread Card 全屏时,hover Agent 类型徽章弹出的卡片。
 *
 * 通用 metadata 协议字段均通过 props 传入,组件本身不读取 store ──
 * 由父级 (agent-thread-card.tsx) 负责从 useChatStore 抽取并定时刷新。
 *
 * 展示 4 行:
 *   1. Session ID + 复制按钮
 *   2. Model(可选, 由 run.model 填充, 未上报时显示 "—")
 *   3. 运行持续时间(可选, run 未跑时显示 "—")
 *   4. Token 总量(可选, 网关未上报时显示 "—")
 */
export function BadgeHoverCard({
  sessionId,
  model,
  lastRunAt,
  totalTokens,
}: BadgeHoverCardProps) {
  const { language, t } = useI18n();
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 静默失败
    }
  }, [sessionId]);

  return (
    <HoverCard openDelay={120} closeDelay={150}>
      <HoverCardTrigger asChild>
        <span
          aria-hidden="true"
          className="agent-thread-card__badge-hover-trigger"
        />
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-72 px-3 py-2.5"
      >
        <div className="flex flex-col gap-1.5">
          {/* Session ID 行: 复制按钮在右 */}
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--foreground)]"
              title={sessionId || ""}
            >
              {sessionId || "—"}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!sessionId}
              aria-label={t("editor.threadCard.copySessionId")}
              className={cn(
                "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)]",
                "transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {copied ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>

          {/* Model 行 */}
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.model")}
            </span>
            <span
              className={cn(
                "font-mono",
                model
                  ? "text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)]",
              )}
            >
              {model || "—"}
            </span>
          </div>

          {/* 上次运行时间行 */}
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.lastRun")}
            </span>
            <span
              className={cn(
                "font-mono tabular-nums",
                typeof lastRunAt === "number"
                  ? "text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)]",
              )}
            >
              {typeof lastRunAt === "number"
                ? formatRelativeTime(lastRunAt, language)
                : "-"}
            </span>
          </div>

          {/* Token 总量行 */}
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.totalTokens")}
            </span>
            <span
              className={cn(
                "font-mono tabular-nums",
                typeof totalTokens === "number"
                  ? "text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)]",
              )}
            >
              {typeof totalTokens === "number" ? formatTokens(totalTokens) : "—"}
            </span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
