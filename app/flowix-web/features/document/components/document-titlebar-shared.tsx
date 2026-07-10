'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Ellipsis, Loader2, Palette, Search } from 'lucide-react';
import {
  LinkSimpleIcon,
  CopyIcon,
  PushPinIcon,
  PushPinSlashIcon,
  FileMdIcon,
  FileDocIcon,
  ClockIcon,
  TrashSimpleIcon,
  BoxArrowDownIcon,
  SwatchesIcon,
  StackSimpleIcon,
} from '@phosphor-icons/react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@shared/ui/dropdown-menu';
import { Tooltip } from '@shared/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@shared/ui/dialog';
import {
  MEMO_COLORS,
  MEMO_COLOR_HEX,
  type MemoColor,
  type MemoItem,
} from '@features/memo';
import {
  flushDocumentPath,
  getDocumentBuffer,
  useDocumentStore,
  type DocumentIdentity,
} from '@features/document';
import { memos as memosClient, type MemoVersionMeta } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import {
  useAgentConversationStore,
  type AgentConversationInstance,
} from '@features/agent/store/agent-conversation-store';
import { getAgentType, DEFAULT_AGENT_TYPE_KEY } from '@/lib/agent-types';
import { canonicalPath } from '@/lib/path';
import { useI18n, translate, type AppLanguage, type I18nKey, type I18nParams } from '@features/i18n';

const AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT =
  'flowix:agent-thread-card-fullscreen-change';
const AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT =
  'flowix:agent-thread-card-request-fullscreen';

/**
 * Document state for the titlebar. Exactly one is active at a time:
 *   - 'empty':    no memo, no external file (titlebar shows only the shell
 *                 and the optional sidebar toggle)
 *   - 'memo':     an internal memo is open → memo action group on the right
 *   - 'external': an external file is open → path display in the middle,
 *                 "保存为笔记" button on the right
 */
export type DocumentState = 'empty' | 'memo' | 'external';

// =====================================================================
// External file path display — platform-agnostic, zero-prop besides path
// =====================================================================

export function ExternalPathDisplay({ path }: { path: string }) {
  // Split "/Users/rop/.../file.md" into segments and drop the leading empty
  // entry from the leading slash. Trailing/duplicate slashes are also dropped
  // by filter(Boolean).
  const segments = path.split('/').filter(Boolean);

  return (
    <div className="w-fit max-w-full min-w-0 pl-3" title={path}>
      <div className="flex items-center overflow-hidden text-xs text-[var(--foreground)]">
        {segments.map((segment, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <ChevronRight
                aria-hidden="true"
                className="mx-1 h-3 w-3 shrink-0 text-[var(--muted-foreground)]"
              />
            )}
            <span className="shrink-0">{segment}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// External save button — icon + text identical across platforms,
// className (height / radius / bg / border / padding) supplied by caller
// =====================================================================

export function ExternalSaveButton({
  isSaving,
  onSave,
  className,
}: {
  isSaving: boolean;
  onSave: () => void;
  className: string;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={isSaving}
      className={className}
    >
      <BoxArrowDownIcon className="h-4 w-4" />
      <span className="text-xs">{isSaving ? t("document.external.save.saving") : t("document.external.save.label")}</span>
    </button>
  );
}

// =====================================================================
// External copy-path button — icon only, iconButtonClass supplied by caller
// (uses the same class as the memo action icon buttons for visual unity)
// =====================================================================

export function ExternalCopyButton({
  onCopy,
  iconButtonClass,
}: {
  onCopy: () => void;
  iconButtonClass: string;
}) {
  const { t } = useI18n();
  return (
    <Tooltip content={t("document.external.copyPathTooltip")}>
      <button
        type="button"
        onClick={onCopy}
        aria-label={t("document.external.copyPath")}
        className={iconButtonClass}
      >
        <CopyIcon className="w-4 h-4" />
      </button>
    </Tooltip>
  );
}

// =====================================================================
// Memo color picker — multi-select, dropdown of 7 swatches
// 触发按钮:
//   - 空数组 (无颜色) 时显示 `Palette` 图标
//   - 至少 1 个颜色时显示叠加的小圆点 (右上偏移, 制造"多色"的视觉密度)
// 7 个色块 + 1 个 "无" 按钮: 点色块 toggle, 点 "无" 清空全部。 每次切换
// 把整组新颜色走 `onChange` 一次性写回后端, 由 memo-event 链路回灌 store。
// =====================================================================

const COLOR_LABEL_KEYS: Record<MemoColor, I18nKey> = {
  red: "document.color.red",
  orange: "document.color.orange",
  yellow: "document.color.yellow",
  green: "document.color.green",
  cyan: "document.color.cyan",
  blue: "document.color.blue",
  gray: "document.color.gray",
};

function getColorLabel(color: MemoColor, language: AppLanguage): string {
  return translate(language, COLOR_LABEL_KEYS[color]);
}

export function MemoColorPicker({
  colors,
  iconButtonClass,
  onChange,
}: {
  colors: MemoColor[];
  iconButtonClass: string;
  onChange: (next: MemoColor[]) => void;
}) {
  const { t, language } = useI18n();
  const selected = new Set(colors);

  const toggle = (c: MemoColor) => {
    const next = new Set(selected);
    if (next.has(c)) {
      next.delete(c);
    } else {
      next.add(c);
    }
    // 保持 MEMO_COLORS 声明顺序, 列表 / 触发按钮展示稳定。
    onChange(MEMO_COLORS.filter((c) => next.has(c)));
  };

  const clear = () => onChange([]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tooltip content={t("document.color.tooltip")}>
          <button
            type="button"
            aria-label={t("document.color.button")}
            className={iconButtonClass}
          >
            {colors.length > 0 ? (
              <span aria-hidden="true" className="relative block h-3.5 w-3.5">
                {colors.slice(0, 3).map((c, i) => (
                  <span
                    key={c}
                    className="absolute h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor: MEMO_COLOR_HEX[c],
                      top: colors.length === 1 ? '2px' : `${(i % 2) * 4}px`,
                      left: colors.length === 1 ? '2px' : `${(i % 2) * 4}px`,
                      zIndex: 10 - i,
                    }}
                  />
                ))}
              </span>
            ) : (
              <Palette className="w-4 h-4" />
            )}
          </button>
        </Tooltip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[180px] p-2"
      >
        <div className="flex items-center gap-1.5">
          <Tooltip content={t("document.color.noColorTooltip")}>
            <button
              type="button"
              aria-label={t("document.color.clear")}
              onClick={clear}
              className={`relative h-7 w-7 rounded-md border bg-transparent transition-colors ${
                colors.length === 0
                  ? 'border-[var(--muted-foreground)]'
                  : 'border-[var(--border)] hover:border-[var(--muted-foreground)]'
              }`}
            />
          </Tooltip>
          {MEMO_COLORS.map((c) => {
            const isSelected = selected.has(c);
            return (
              <button
                key={c}
                type="button"
                aria-label={getColorLabel(c, language)}
                aria-pressed={isSelected}
                onClick={() => toggle(c)}
                className="relative h-7 w-7 rounded-md transition-transform hover:scale-110"
                style={{ backgroundColor: MEMO_COLOR_HEX[c] }}
              >
                {isSelected && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 flex items-center justify-center text-white opacity-70"
                  >
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AgentThreadTitlebarItem {
  id: string;
  title: string;
  type: string;
  threadId: string | null;
  element: HTMLElement | null;
  isRunning: boolean;
  updatedAt?: number;
  createdAt?: number;
}

interface AgentThreadCardElementMaps {
  byInstanceId: Map<string, HTMLElement>;
  byThreadId: Map<string, HTMLElement>;
}

function getAgentThreadCardElementMaps(): AgentThreadCardElementMaps {
  const byInstanceId = new Map<string, HTMLElement>();
  const byThreadId = new Map<string, HTMLElement>();
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('.document-container .ProseMirror section[data-agent-thread-card]')
  );

  for (const element of nodes) {
    const instanceId = element.dataset.instanceId?.trim();
    const threadId = element.dataset.threadId?.trim();
    if (instanceId) byInstanceId.set(instanceId, element);
    if (threadId) byThreadId.set(threadId, element);
  }

  return { byInstanceId, byThreadId };
}

function sameCanonicalPath(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return !!a && !!b && canonicalPath(a) === canonicalPath(b);
}

function isConversationForCurrentDocument(
  instance: AgentConversationInstance,
  currentDocumentSource: 'memo' | 'external' | null,
  currentDocumentPath: string | null,
  activeMemoSession: { memoId: string; path: string } | null,
): boolean {
  if (instance.source.kind !== 'thread-card') return false;

  if (currentDocumentSource === 'memo') {
    if (!activeMemoSession) return false;
    if (instance.source.memoId && instance.source.memoId === activeMemoSession.memoId) {
      return true;
    }
    return (
      sameCanonicalPath(instance.source.documentPath, activeMemoSession.path) ||
      sameCanonicalPath(instance.source.documentPath, currentDocumentPath)
    );
  }

  if (currentDocumentSource === 'external') {
    return sameCanonicalPath(instance.source.documentPath, currentDocumentPath);
  }

  return false;
}

function getAgentThreadTitlebarItemsFromConversations(
  t: (key: I18nKey, params?: I18nParams) => string,
  instances: Record<string, AgentConversationInstance>,
  currentDocumentSource: 'memo' | 'external' | null,
  currentDocumentPath: string | null,
  activeMemoSession: { memoId: string; path: string } | null,
): AgentThreadTitlebarItem[] {
  const elementMaps = getAgentThreadCardElementMaps();

  return Object.values(instances)
    .filter((instance) =>
      isConversationForCurrentDocument(
        instance,
        currentDocumentSource,
        currentDocumentPath,
        activeMemoSession,
      ),
    )
    .map((instance) => {
      const element =
        elementMaps.byInstanceId.get(instance.instanceId) ??
        (instance.threadId ? elementMaps.byThreadId.get(instance.threadId) : undefined) ??
        null;

      return {
        id: instance.instanceId,
        title: instance.title?.trim() || t('editor.threadCard.title'),
        type: instance.agentType || DEFAULT_AGENT_TYPE_KEY,
        threadId: instance.threadId,
        element,
        isRunning: instance.run?.status === 'running',
        updatedAt: instance.updatedAt,
        createdAt: instance.createdAt,
      };
    })
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
}

function scrollToAgentThreadCard(element: HTMLElement): void {
  element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
}

function hasFullscreenAgentThreadCard(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('.agent-thread-card--fullscreen');
}

function useAgentThreadCardFullscreenActive(): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const update = () => setActive(hasFullscreenAgentThreadCard());
    update();

    window.addEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);

    return () => {
      window.removeEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);
    };
  }, []);

  return active;
}

function openAgentThreadCardFromNavigator(item: AgentThreadTitlebarItem): void {
  if (!item.element) return;

  if (!hasFullscreenAgentThreadCard()) {
    scrollToAgentThreadCard(item.element);
    return;
  }

  window.dispatchEvent(
    new CustomEvent(AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT, {
      detail: {
        element: item.element,
        threadId: item.threadId || item.element.dataset.threadId?.trim() || item.id,
        exitOthers: true,
      },
    }),
  );
}

function withoutHoverClasses(className: string): string {
  return className
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('hover:'))
    .join(' ');
}

function formatAgentThreadTime(
  timestamp: number | undefined,
  language: AppLanguage,
  t: (key: I18nKey, params?: I18nParams) => string
): string {
  if (!timestamp) return '';

  const intlLocale = language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const now = Date.now();
  const diffMs = Math.max(0, now - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return t('agent.time.justNow');
  if (diffMin < 60) return t('agent.time.minutesAgo', { m: diffMin } satisfies I18nParams);
  if (diffHour < 24) return t('agent.time.hoursAgo', { h: diffHour } satisfies I18nParams);
  if (diffDay < 7) return t('agent.time.daysAgo', { d: diffDay } satisfies I18nParams);
  return new Date(timestamp).toLocaleDateString(intlLocale);
}

function AgentThreadNavigator({
  iconButtonClass,
}: {
  iconButtonClass: string;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AgentThreadTitlebarItem[]>([]);
  const conversationInstances = useAgentConversationStore((state) => state.instances);
  const currentDocumentPath = useDocumentStore((state) => state.currentDocumentPath);
  const currentDocumentSource = useDocumentStore((state) => state.currentDocumentSource);
  const activeMemoSession = useDocumentStore((state) => state.activeMemoSession);
  const isLargeButton = iconButtonClass.includes('w-8') || iconButtonClass.includes('h-8');
  const buttonSizeClass = isLargeButton ? 'h-8 px-1.5 rounded-xl' : 'h-7 px-1 rounded-lg';
  const buttonSurfaceClass = isLargeButton
    ? 'border border-[var(--border)] bg-[var(--bg-titlebar)]'
    : '';
  const triggerItem = items.find((item) => item.isRunning) ?? items[0] ?? null;
  const triggerAgentType = getAgentType(triggerItem?.type ?? DEFAULT_AGENT_TYPE_KEY);

  const refreshItems = () => {
    const nextItems = getAgentThreadTitlebarItemsFromConversations(
      t,
      conversationInstances,
      currentDocumentSource,
      currentDocumentPath,
      activeMemoSession,
    );
    setItems(nextItems);
    return nextItems;
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      refreshItems();
    }
    setOpen(nextOpen);
  };

  useEffect(() => {
    refreshItems();
  }, [conversationInstances, currentDocumentPath, currentDocumentSource, activeMemoSession]);

  return (
    <div className="inline-flex shrink-0 items-center">
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('document.agent.menu')}
            title={t('document.agent.menuTooltip')}
            className={`inline-flex ${buttonSizeClass} ${buttonSurfaceClass} shrink-0 items-center justify-center gap-0.5 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]`}
          >
            <span
              aria-hidden="true"
              className={`agent-thread-navigator__trigger-icon ${
                triggerItem?.isRunning ? 'agent-thread-navigator__icon--running' : ''
              }`}
            >
              <img
                src={triggerAgentType.icon}
                alt=""
                draggable={false}
              />
            </span>
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[224px] p-1">
          <DropdownMenuLabel className="py-1.5 shrink-0 px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            {t('document.agent.conversationsTitle')}
          </DropdownMenuLabel>
          <div className="max-h-[300px] space-y-1 overflow-y-auto">
          {items.length > 0 ? (
            items.map((item, index) => {
              const timeLabel = formatAgentThreadTime(item.updatedAt || item.createdAt, language, t);
              const agentType = getAgentType(item.type);
              return (
                <DropdownMenuItem
                  key={`${item.id}-${index}`}
                  onClick={() => openAgentThreadCardFromNavigator(item)}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--border)] p-1 ${
                      item.isRunning ? 'agent-thread-navigator__icon--running' : ''
                    }`}
                  >
                    <img
                      src={agentType.icon}
                      alt=""
                      draggable={false}
                      className="h-full w-full object-contain"
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left text-sm text-[var(--agent-foreground)]">
                    {item.title}
                  </span>
                  {timeLabel && (
                    <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
                      {timeLabel}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })
          ) : (
            <div className="px-2 py-2 text-xs text-[var(--muted-foreground)]">
              {t('document.agent.empty')}
            </div>
          )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// =====================================================================
// Memo action group — color + search + ellipsis dropdown
// iconButtonClass (size / radius / bg / border) supplied by caller
// =====================================================================

const VERSION_SOURCE_LABEL_KEYS: Record<MemoVersionMeta['source'], I18nKey> = {
  auto: "document.version.source.auto",
  manual: "document.version.source.manual",
  restore_backup: "document.version.source.restoreBackup",
};

function formatVersionTime(timestamp: number, language: AppLanguage): string {
  const intlLocale = language === "zh-CN" ? "zh-CN" : "en-US";
  // 英文用「June 24, 2025」简写形式 (long month + day + year, 无时间); 中文保留
  // 紧凑数字格式带时分, 列表项之间的时间信息更密。
  const options: Intl.DateTimeFormatOptions =
    language === "zh-CN"
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "long", day: "numeric" };
  return new Intl.DateTimeFormat(intlLocale, options).format(new Date(timestamp));
}

function formatVersionSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function VersionHistorySubmenu({
  memoId,
  refreshKey,
  restoringVersionId,
  onSelectVersion,
}: {
  memoId: string;
  refreshKey: number;
  restoringVersionId: string | null;
  onSelectVersion: (version: MemoVersionMeta) => void;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<MemoVersionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);

    void memosClient.listVersions(memoId)
      .then((items) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        setVersions(items);
      })
      .catch((err) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        console.error('[VersionHistorySubmenu] listVersions failed', err);
        setError(t("document.version.loadFailed"));
      })
      .finally(() => {
        if (mountedRef.current && requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      });
  }, [open, memoId, refreshKey, t]);

  const orderedVersions = useMemo(
    () => [...versions].sort((a, b) => b.createdAt - a.createdAt),
    [versions],
  );

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--muted)]"
        onFocus={() => setOpen(true)}
      >
        <ClockIcon className="w-4 h-4 mr-2" />
        <span className="flex-1 text-left">{t("document.version.menuLabel")}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
      </button>

      {open && (
        <div className="absolute right-full top-0 z-[1501] w-[300px] rounded-lg border border-[var(--border)] bg-[var(--card)] py-2 shadow-lg">
          <div
            className="flex items-center justify-between"
            style={{ padding: '0.15rem 0.375rem 0.35rem' }}
          >
            <div
              className="text-[var(--muted-foreground)]"
              style={{ fontSize: '0.75rem', lineHeight: 1.2 }}
            >
              {t("document.version.allHistory")}
            </div>
            <div className="text-[11px] text-[var(--muted-foreground)]">
              {orderedVersions.length}/20
            </div>
          </div>

          <div className="max-h-[272px] overflow-y-auto px-1">
            {loading && (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--muted-foreground)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("document.version.loading")}
              </div>
            )}

            {!loading && error && (
              <div className="px-2 py-3 text-xs text-[var(--destructive)]">{error}</div>
            )}

            {!loading && !error && orderedVersions.length === 0 && (
              <div className="px-2 py-3 text-xs text-[var(--muted-foreground)]">
                {t("document.version.empty")}
              </div>
            )}

            {!loading && !error && orderedVersions.map((version) => {
              const isRestoring = restoringVersionId === version.id;
              return (
              <button
                key={version.id}
                type="button"
                disabled={isRestoring}
                onClick={() => {
                  setOpen(false);
                  onSelectVersion(version);
                }}
                className="block w-full rounded-md px-2 py-2 text-left hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-60"
                title={version.title || version.filename}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)]">
                    {formatVersionTime(version.createdAt, language)}
                  </span>
                  {isRestoring && (
                    <Loader2 className="h-3 w-3 animate-spin text-[var(--muted-foreground)]" />
                  )}
                  <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                    {translate(language, VERSION_SOURCE_LABEL_KEYS[version.source] ?? "") || version.source}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
                  <span className="min-w-0 flex-1 truncate">
                    {version.title || version.filename}
                  </span>
                  <span className="shrink-0">{formatVersionSize(version.size)}</span>
                </div>
              </button>
            )})}
          </div>
        </div>
      )}
    </div>
  );
}

export function MemoActions({
  memo,
  iconButtonClass,
  onOpenSearch,
  onCopyLink,
  onCopyFullText,
  onOpenProperties,
  onTogglePin,
  onExportMarkdown,
  onSaveAsTemplate,
  onExportWord,
  onRequestDeleteMemo,
  onColorsChange,
}: {
  memo: MemoItem;
  iconButtonClass: string;
  onOpenSearch: () => void;
  onCopyLink: () => void;
  onCopyFullText: () => void;
  onOpenProperties: () => void;
  onTogglePin: () => void;
  onExportMarkdown: () => void;
  onSaveAsTemplate: () => void;
  onExportWord: () => void;
  onRequestDeleteMemo: () => void;
  onColorsChange: (next: MemoColor[]) => void;
}) {
  const { t, language } = useI18n();
  const isPinned = !!memo.favorited;
  const [confirmVersion, setConfirmVersion] = useState<MemoVersionMeta | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [versionRefreshKey, setVersionRefreshKey] = useState(0);
  const isAgentThreadCardFullscreen = useAgentThreadCardFullscreenActive();
  const searchButtonClass = isAgentThreadCardFullscreen
    ? `${withoutHoverClasses(iconButtonClass)} cursor-not-allowed opacity-45`
    : iconButtonClass;

  const handleConfirmRestoreVersion = async () => {
    if (!confirmVersion || restoringVersionId) return;

    const version = confirmVersion;
    const identity: DocumentIdentity = { kind: 'memo', id: memo.id };
    setRestoringVersionId(version.id);

    try {
      const activeMemoSession = useDocumentStore.getState().activeMemoSession;
      const activePath = activeMemoSession?.memoId === memo.id
        ? activeMemoSession.path
        : null;

      if (activePath) {
        const flushed = await flushDocumentPath(identity, activePath);
        if (!flushed) {
          toast.error(t("document.version.saveCurrentFailed"));
          return;
        }
      }

      const expectedContent = activePath
        ? getDocumentBuffer(identity).lastSavedContent
        : undefined;
      const restored = await memosClient.restoreVersion(memo.id, version.id, expectedContent);

      if (!restored) {
        toast.error(t("document.version.restoreFailed"));
        return;
      }

      const latestActiveMemoSession = useDocumentStore.getState().activeMemoSession;
      if (latestActiveMemoSession?.memoId === memo.id) {
        useDocumentStore.getState().replaceActiveMemoPath(memo.id, restored.path);
        window.dispatchEvent(new CustomEvent('flowix:memo-version-restored', {
          detail: {
            memoId: memo.id,
            path: restored.path,
            content: restored.content,
          },
        }));
      }

      setConfirmVersion(null);
      setVersionRefreshKey((key) => key + 1);
      toast.success(t("document.version.restored"));
    } catch (err) {
      console.error('[MemoActions] restore version failed', err);
      toast.error(t("document.version.restoreFailed"));
    } finally {
      setRestoringVersionId(null);
    }
  };

  return (
    <>
      {(memo.agents?.length ?? 0) > 0 && (
        <AgentThreadNavigator iconButtonClass={iconButtonClass} />
      )}
      <MemoColorPicker
        colors={memo.colors}
        iconButtonClass={iconButtonClass}
        onChange={onColorsChange}
      />
      <Tooltip
        content={t("document.titlebar.searchTooltip")}
        shortcut="editor.find"
        disabled={isAgentThreadCardFullscreen}
      >
        <button
          type="button"
          disabled={isAgentThreadCardFullscreen}
          aria-disabled={isAgentThreadCardFullscreen}
          onClick={() => {
            if (!isAgentThreadCardFullscreen) onOpenSearch();
          }}
          className={searchButtonClass}
        >
          <Search className="w-4 h-4" />
        </button>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Tooltip content={t("document.titlebar.moreTooltip")}>
            <button className={iconButtonClass}>
              <Ellipsis className="w-4 h-4" />
            </button>
          </Tooltip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[200px] px-1 py-1.5 space-y-1">
          <DropdownMenuItem
            onClick={onCopyLink}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <LinkSimpleIcon className="w-4 h-4 mr-2" /> {t("document.action.copyLink")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onCopyFullText}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <CopyIcon className="w-4 h-4 mr-2" /> {t("document.action.copyFullText")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onOpenProperties}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <StackSimpleIcon className="w-4 h-4 mr-2" /> {t("document.action.properties")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onTogglePin}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            {isPinned ? (
              <><PushPinSlashIcon className="w-4 h-4 mr-2" /> {t("document.action.unpin")}</>
            ) : (
              <><PushPinIcon className="w-4 h-4 mr-2" /> {t("document.action.pin")}</>
            )}
          </DropdownMenuItem>
          <hr className="mx-2 border-t border-[var(--border)] opacity-50" />
          <DropdownMenuItem
            onClick={onSaveAsTemplate}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <SwatchesIcon className="w-4 h-4 mr-2" /> {t("document.action.saveAsTemplate")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onExportMarkdown}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <FileMdIcon className="w-4 h-4 mr-2" /> {t("document.action.exportMarkdown")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onExportWord}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <FileDocIcon className="w-4 h-4 mr-2" /> {t("document.action.exportWord")}
          </DropdownMenuItem>
          <hr className="mx-2 border-t border-[var(--border)] opacity-50" />
          <VersionHistorySubmenu
            memoId={memo.id}
            refreshKey={versionRefreshKey}
            restoringVersionId={restoringVersionId}
            onSelectVersion={setConfirmVersion}
          />
          <DropdownMenuItem
            onClick={onRequestDeleteMemo}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
          >
            <TrashSimpleIcon className="w-4 h-4 mr-2" /> {t("document.action.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={!!confirmVersion} onOpenChange={(open) => !open && setConfirmVersion(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("document.version.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("document.version.confirmDescription", { time: confirmVersion ? formatVersionTime(confirmVersion.createdAt, language) : '' } satisfies I18nParams)}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              disabled={!!restoringVersionId}
              onClick={() => setConfirmVersion(null)}
              className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("document.version.cancel")}
            </button>
            <button
              type="button"
              disabled={!!restoringVersionId}
              onClick={handleConfirmRestoreVersion}
              className="inline-flex h-8 items-center gap-2 rounded-lg bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {restoringVersionId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("document.version.confirm")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
