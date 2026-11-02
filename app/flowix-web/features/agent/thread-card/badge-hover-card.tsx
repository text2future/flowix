import * as React from "react";
import { Check, Copy } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@shared/ui/hover-card";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AgentTypeKey, UsageInfo } from "@/types/agent";
import { useBadgeRuntimeInfo, type BadgeHoverCardRuntimeInfo } from "./runtime/use-badge-runtime-info";

interface BadgeHoverCardProps {
  /** Internal identity only; never rendered. */
  threadId?: string;
  /** Provider session id already loaded with the conversation instance. */
  sessionId?: string;
  /** Latest or active run identity; scopes fetched data to one run. */
  runId?: string;
  /** 当前 run 锁定的 LLM model id(由通用 metadata 协议填入) */
  model?: string;
  /** 当前 run 累计 token 用量(undefined 表示未上报) */
  usage?: UsageInfo;
  onRequestRuntimeInfo?: () => Promise<BadgeHoverCardRuntimeInfo | null>;
  agentType: AgentTypeKey;
  piMode?: "code" | "writing";
  cwd?: string;
  onOpenChange?: (open: boolean) => void;
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

function formatTokenCount(value: number | null | undefined): string {
  return typeof value === "number" ? formatTokens(value) : "";
}

function lastPathSegment(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function HoverCardSkeleton({ width }: { width: string }) {
  return (
    <span
      aria-hidden="true"
      className="agent-thread-card__hover-skeleton"
      style={{ width }}
    />
  );
}

function cacheHitRate(usage: UsageInfo | undefined, codex: boolean): number | undefined {
  const input = usage?.input_tokens;
  const cached = usage?.cached_input_tokens;
  if (
    typeof input !== "number" ||
    typeof cached !== "number" ||
    input < 0 ||
    cached < 0
  ) {
    return undefined;
  }
  const denominator = codex ? input : input + cached;
  return denominator > 0 ? Math.min(1, cached / denominator) : undefined;
}

function contextUsageRate(usage: UsageInfo | undefined): number | undefined {
  // Codex reports the latest request's input as the context currently sent to
  // the model; Harness may provide its own projected context_used_tokens.
  const used = usage?.context_used_tokens ?? usage?.input_tokens;
  const window = usage?.model_context_window;
  if (
    typeof used !== "number" ||
    typeof window !== "number" ||
    used < 0 ||
    window <= 0
  ) {
    return undefined;
  }
  return Math.min(1, used / window);
}

function percentageFromRate(rate: number | undefined): string {
  return rate === undefined ? "" : `${Math.round(rate * 100)}%`;
}

/**
 * Agent conversation identity badge 的运行信息卡片。
 *
 * 通用 metadata 协议字段均通过 props 传入,组件本身不读取 store。
 *
 * Pi 显示 model、session id、token 用量、缓存命中、工作目录和运行模式；
 * 其他 agent 保留通用模型/用量信息，并按需展示 Codex 配额。
 */
export function BadgeHoverCard({
  threadId,
  sessionId,
  runId,
  model,
  usage,
  onRequestRuntimeInfo,
  agentType,
  piMode,
  cwd,
  onOpenChange,
}: BadgeHoverCardProps) {
  const { t, language } = useI18n();
  const pi = agentType === "pi";
  const codex = agentType === "codex";
  const [copied, setCopied] = React.useState(false);
  const runtimeInfo = useBadgeRuntimeInfo({
    identity: `${threadId ?? ""}:${sessionId ?? ""}:${runId ?? ""}`,
    model,
    usage,
    sessionId,
    onRequest: onRequestRuntimeInfo,
  });
  const {
    displayModel,
    displayUsage,
    displaySessionId,
    codexInfo,
    runtimeInfoPending,
    requestRuntimeInfo,
  } = runtimeInfo;

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      onOpenChange?.(open);
      if (open) requestRuntimeInfo();
    },
    [onOpenChange, requestRuntimeInfo],
  );

  const hitRate = cacheHitRate(displayUsage, codex);
  const contextRate = contextUsageRate(displayUsage);
  const displayCwd = cwd ? lastPathSegment(cwd) : "";
  const sessionIdPending = runtimeInfoPending && displaySessionId === null;
  const modelPending = runtimeInfoPending && !displayModel;
  const tokensPending = runtimeInfoPending &&
    !formatTokenCount(displayUsage?.input_tokens) &&
    !formatTokenCount(displayUsage?.output_tokens);
  const cachePending = runtimeInfoPending && hitRate === undefined;
  const contextPending = runtimeInfoPending && contextRate === undefined;
  const codexPending = runtimeInfoPending && !codexInfo;
  const quotaWindows = codex
    ? Object.values(codexInfo?.rateLimits?.rateLimitsByLimitId ?? {})
        .flatMap((limit) => [limit.primary, limit.secondary])
        .filter((window): window is NonNullable<typeof window> => Boolean(window))
    : [];
  const fiveHour = quotaWindows.find((window) => window.windowDurationMins === 300);
  const weekly = quotaWindows.find((window) => window.windowDurationMins === 10080);
  const resetCount = codexInfo?.rateLimits?.rateLimitResetCredits?.availableCount;
  const quotaText = (window: typeof fiveHour) => {
    if (!window) return "-";
    const remaining = `${Math.max(0, 100 - window.usedPercent)}%`;
    if (!window.resetsAt) return remaining;
    const resetAt = new Date(window.resetsAt * 1000);
    return `${remaining} ${window.windowDurationMins === 300
      ? resetAt.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", hour12: false })
      : resetAt.toLocaleDateString(language, { month: "long", day: "numeric" })}`;
  };
  const piModelParts = displayModel?.includes("/")
    ? displayModel.slice(displayModel.indexOf("/") + 1)
    : displayModel ?? "";

  const handleCopy = React.useCallback(async () => {
    if (!displaySessionId) return;
    try {
      await navigator.clipboard.writeText(displaySessionId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 静默失败
    }
  }, [displaySessionId]);

  return (
    <HoverCard
      openDelay={120}
      closeDelay={150}
      onOpenChange={handleOpenChange}
    >
      <HoverCardTrigger asChild>
        <span
          aria-hidden="true"
          className="agent-conversation-identity__badge-trigger"
          onPointerEnter={requestRuntimeInfo}
        />
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        sideOffset={6}
        className={cn(
          "w-[14.4rem] rounded-xl border-[var(--border-popup)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)] px-3 py-2.5",
          pi && "w-[17rem]",
        )}
      >
        <div className="flex flex-col gap-1.5">
          {/* Provider-owned session id; never expose Flowix's local thread id. */}
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--foreground)]"
              title={displaySessionId ?? ""}
            >
              {sessionIdPending ? <HoverCardSkeleton width="8rem" /> : displaySessionId || "-"}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!displaySessionId}
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

          {pi && (
            <>
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
                <span className="text-[var(--muted-foreground)]">{t("editor.threadCard.model")}</span>
                <span className={cn(
                  "agent-thread-card__model-value min-w-0",
                  piModelParts ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]",
                )}>
                  {modelPending ? <HoverCardSkeleton width="4rem" /> : piModelParts || "-"}
                </span>
              </div>
            </>
          )}

          {!pi && (
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
              <span className="text-[var(--muted-foreground)]">{t("editor.threadCard.model")}</span>
              <span className={cn(
                "agent-thread-card__model-value min-w-0",
                displayModel ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]",
              )}>
                {modelPending ? <HoverCardSkeleton width="4rem" /> : displayModel || "-"}
              </span>
            </div>
          )}

          {/* Token 明细: Harness 的 inputTokens 不包含 cacheReadTokens。 */}
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.inputOutputTokens")}
            </span>
            <span className="text-right font-mono tabular-nums text-[var(--foreground)]">
              {tokensPending ? <HoverCardSkeleton width="3.5rem" /> : <>
                {formatTokenCount(displayUsage?.input_tokens) || "-"} /{" "}
                {formatTokenCount(displayUsage?.output_tokens) || "-"} tok
              </>}
            </span>
          </div>

          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.cacheReadTokens")}
            </span>
            <span
              className="agent-thread-card__cache-hit-value"
              aria-label={percentageFromRate(hitRate) || "-"}
            >
              {cachePending ? <HoverCardSkeleton width="1.75rem" /> : (
                <span className="font-mono tabular-nums text-[var(--foreground)]">
                  {percentageFromRate(hitRate) || "-"}
                </span>
              )}
            </span>
          </div>

          {!pi && <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.contextUsage")}
            </span>
            <span
              className="agent-thread-card__cache-hit-value"
              aria-label={percentageFromRate(contextRate) || "-"}
            >
              {contextPending ? <HoverCardSkeleton width="1.75rem" /> : (
                <span className="font-mono tabular-nums text-[var(--foreground)]">
                  {percentageFromRate(contextRate) || "-"}
                </span>
              )}
              {contextRate === undefined ? null : (
                <span
                  aria-hidden="true"
                  className="agent-thread-card__context-ring"
                  style={{ "--proportion": `${contextRate * 100}%` } as React.CSSProperties}
                />
              )}
            </span>
          </div>}

          {displayCwd ? (
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2 text-[11px]">
              <span className="shrink-0 text-[var(--muted-foreground)]">
                {t(pi ? "editor.threadCard.workingDirectory" : "editor.threadCard.cwd")}
              </span>
              <span
                className="agent-thread-card__cwd-value"
                title={cwd}
              >
                {displayCwd}
              </span>
            </div>
          ) : null}
          {piMode ? (
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
              <span className="text-[var(--muted-foreground)]">{t("editor.threadCard.mode")}</span>
              <span className="text-right text-[var(--foreground)]">
                {t(piMode === "code" ? "editor.threadCard.piCodeMode" : "editor.threadCard.piWritingMode")}
              </span>
            </div>
          ) : null}
          {codex ? (
            <>
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
                <span className="text-[var(--muted-foreground)]">
                  {t("editor.threadCard.codexPlan")}
                </span>
                <span className="text-right font-mono tabular-nums text-[var(--foreground)]">
                  {codexPending ? <HoverCardSkeleton width="3rem" /> : codexInfo?.account?.planType ?? "-"}
                </span>
              </div>
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
                <span className="text-[var(--muted-foreground)]">
                  {t("editor.threadCard.codexQuota5h")}
                </span>
                <span className="text-right font-mono tabular-nums text-[var(--foreground)]">
                  {codexPending ? <HoverCardSkeleton width="4rem" /> : quotaText(fiveHour)}
                </span>
              </div>
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
                <span className="text-[var(--muted-foreground)]">
                  {t("editor.threadCard.codexQuotaWeekly")}
                </span>
                <span className="text-right font-mono tabular-nums text-[var(--foreground)]">
                  {codexPending ? <HoverCardSkeleton width="3rem" /> : quotaText(weekly)}
                </span>
              </div>
              {typeof resetCount === "number" && Number.isFinite(resetCount) && resetCount > 0 ? (
                <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
                  <span className="text-[var(--muted-foreground)]">
                    {t("editor.threadCard.codexQuotaResetCount")}
                  </span>
                  <span className="agent-thread-card__codex-reset-count text-right font-mono tabular-nums text-[var(--foreground)]">
                    {resetCount}
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
