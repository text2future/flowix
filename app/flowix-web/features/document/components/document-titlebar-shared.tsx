'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Ellipsis, Loader2, Palette } from 'lucide-react';
import {
  LinkSimpleIcon,
  CopyIcon,
  PushPinIcon,
  PushPinSlashIcon,
  FileMdIcon,
  FileDocIcon,
  ClockIcon,
  TrashSimpleIcon,
  SwatchesIcon,
  StackSimpleIcon,
} from '@phosphor-icons/react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { replaceActiveMemoPath } from '@features/workspace/use-cases/workspace-navigation';
import type { WorkspaceHostId } from '@features/workspace/store/workspace-focus-store';
import { useI18n, translate, type AppLanguage, type I18nKey, type I18nParams } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { normalizeAgentTypeKey } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { ICON_FULLSCREEN_EXIT_PATH } from '@features/agent/thread-card/agent-thread-card-icons';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { BadgeHoverCard } from '@features/agent/thread-card/badge-hover-card';
import { computeAgentThreadCardBadgeData } from '@features/agent/thread-card/runtime/run-status-presenter';
import { createRuntimeInfoRequester } from '@features/agent/thread-card/runtime/runtime-info-requester';
import { getResolvedExternalSessionId } from '@features/agent/services/external-agent-runtime-service';
import { getAgentConversationRuntimeCwd } from '@features/agent/conversation-presentation';

const logger = createLogger('document-titlebar');

/** Shared titlebar action button classes used by document and Agent titlebars. */
export const DOCUMENT_TITLEBAR_ICON_BUTTON_MAC =
  'w-8 h-8 flex enabled:!cursor-pointer disabled:!cursor-not-allowed items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-xl transition-colors bg-[var(--bg-titlebar)] border border-[var(--border)]';
export const DOCUMENT_TITLEBAR_ICON_BUTTON_WIN =
  'w-8 h-8 flex enabled:!cursor-pointer disabled:!cursor-not-allowed items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg transition-colors';

export interface DocumentTitlebarProps {
  reserveWindowsControls?: boolean;
  document: {
    currentMemo: MemoItem | null;
    externalFilePath?: string | null;
  };
  sidebar: {
    hidden: boolean;
    noteNavigationVisible: boolean;
    onToggle: () => void;
    onPreviewTriggerEnter?: () => void;
    onPreviewTriggerLeave?: () => void;
  };
  navigation: {
    canNavigateBack: boolean;
    canNavigateForward: boolean;
    onNavigateBack: () => void;
    onNavigateForward: () => void;
    visible?: boolean;
  };
  contentCapabilities: {
    properties: boolean;
    copyFullText: boolean;
    exportContent: boolean;
    saveAsTemplate: boolean;
    versionHistory: boolean;
  };
  actions: {
    onCopyLink: () => void;
    onCopyFullText: () => void;
    onOpenProperties: () => void;
    onTogglePin: () => void;
    onExportMarkdown: () => void;
    onSaveAsTemplate: () => void;
    onExportWord: () => void;
    onRequestDeleteMemo: () => void;
    onColorsChange?: (next: MemoColor[]) => void;
  };
}

const AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT =
  'flowix:agent-thread-card-fullscreen-change';
const AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT =
  'flowix:agent-thread-card-request-fullscreen';

interface AgentThreadCardFullscreenInfo {
  title: string;
  typeKey: AgentTypeKey;
  /** Agent conversation instance id — used to look up runtime info (sessionId, cwd) for the badge hover card. */
  instanceId: string | null;
  /** Provider/external thread id, when the conversation has been bound to one. */
  threadId: string | null;
}

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
// External document titlebar badge — shown next to the path in the
// child-window titlebar so the user knows this tab edits an external file
// (the on-disk markdown lives outside the notebook and is not a memo).
// =====================================================================

export function ExternalTitlebarBadge() {
  const { t } = useI18n();
  return (
    <span
      className="shrink-0 whitespace-nowrap pl-3 text-xs text-[var(--muted-foreground)]"
      aria-label={t("document.external.titlebarBadge")}
    >
      {t("document.external.titlebarBadge")}
    </span>
  );
}

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
        className="w-[180px] rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
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

/**
 * Which workspace column's chrome should react to a fullscreen Thread Card.
 * A fullscreen card is `position: fixed` but keeps its DOM position, so the
 * hosting column resolves reliably through the closest [data-workspace-host]
 * ancestor — each column only reacts to its own cards.
 */
export type AgentThreadCardFullscreenHost = WorkspaceHostId;

function getFullscreenAgentThreadCard(
  host: AgentThreadCardFullscreenHost,
): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  // Only the active browser-column tab stays mounted, so at most one card per
  // host can be fullscreen; the first host match wins.
  const cards = document.querySelectorAll<HTMLElement>('.agent-thread-card--fullscreen');
  for (const card of cards) {
    if (card.closest(`[data-workspace-host="${host}"]`)) return card;
  }
  return null;
}

function hasFullscreenAgentThreadCard(host: AgentThreadCardFullscreenHost): boolean {
  return getFullscreenAgentThreadCard(host) !== null;
}

function getFullscreenAgentThreadCardInfo(
  host: AgentThreadCardFullscreenHost,
): AgentThreadCardFullscreenInfo | null {
  const card = getFullscreenAgentThreadCard(host);
  if (!card) return null;

  const instanceId = card.dataset.instanceId?.trim() || null;
  const threadId = card.dataset.threadId?.trim() || null;
  return {
    title: card.dataset.title?.trim() ?? '',
    typeKey: normalizeAgentTypeKey(card.dataset.agentType),
    instanceId,
    threadId,
  };
}

export function useAgentThreadCardFullscreenActive(
  host: AgentThreadCardFullscreenHost = 'main-third',
): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const update = () => setActive(hasFullscreenAgentThreadCard(host));
    update();

    window.addEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);

    return () => {
      window.removeEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);
    };
  }, [host]);

  return active;
}

export function useFullscreenAgentThreadCardInfo(
  host: AgentThreadCardFullscreenHost = 'main-third',
): AgentThreadCardFullscreenInfo | null {
  const [info, setInfo] = useState<AgentThreadCardFullscreenInfo | null>(null);

  useEffect(() => {
    const update = () => setInfo(getFullscreenAgentThreadCardInfo(host));
    update();

    window.addEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);

    return () => {
      window.removeEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);
    };
  }, [host]);

  return info;
}

/** The exit affordance for an embedded fullscreen Thread Card. */
export function AgentThreadCardFullscreenExitButton({
  className,
  host = 'main-third',
}: {
  className: string;
  host?: AgentThreadCardFullscreenHost;
}) {
  const { t } = useI18n();
  const active = useAgentThreadCardFullscreenActive(host);

  if (!active) return null;

  return (
    <Tooltip content={t('editor.threadCard.exitFullscreen')}>
      <button
        type="button"
        onClick={() => {
          window.dispatchEvent(new CustomEvent(AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT, {
            detail: { host, exitOthers: true },
          }));
        }}
        aria-label={t('editor.threadCard.exitFullscreen')}
        title={t('editor.threadCard.exitFullscreen')}
        className={`${className} [-webkit-app-region:no-drag]`}
      >
        <svg
          viewBox="0 0 256 256"
          aria-hidden="true"
          focusable="false"
          className="agent-thread-card__fullscreen-icon"
        >
          <path d={ICON_FULLSCREEN_EXIT_PATH} fill="currentColor" />
        </svg>
      </button>
    </Tooltip>
  );
}

/** Agent identity displayed in a column titlebar while a Thread Card is fullscreen. */
export function AgentThreadCardFullscreenIdentity({
  host = 'main-third',
}: {
  host?: AgentThreadCardFullscreenHost;
} = {}) {
  const { t } = useI18n();
  const info = useFullscreenAgentThreadCardInfo(host);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // 用 selector 而不是 getState() ── session/runtime store 更新时让组件
  // 重新 render, 否则外部 session id / cwd 注入后不会反映到 popup 内容。
  const instance = useAgentSessionStore((state) =>
    info?.instanceId ? state.getInstance(info.instanceId) : null,
  );
  const codexModel = useAgentSessionStore(
    (state) => state.sessionMeta.settings.agentCodexModel,
  );

  if (!info) return null;

  const title = instance?.title?.trim() || info.title || t('common.untitled');
  const commitTitle = () => {
    const nextTitle = titleDraft.trim();
    if (nextTitle && nextTitle !== title) {
      void useAgentSessionStore.getState().renameAgentConversation({
        instanceId: info.instanceId,
        threadId: instance?.threadId ?? info.threadId,
        title: nextTitle,
        typeKey: info.typeKey,
      });
    }
    setIsEditingTitle(false);
  };

  // Document titlebar 自身在 data-tauri-drag-region 容器里, badge wrapper + trigger
  // 都必须显式 [-webkit-app-region:no-drag], 否则 Radix HoverCard 的 hover 会被
  // macOS 窗口拖拽吞掉。同步处理 ── 与第三列 AgentConversationHeader 行为对齐。
  const productThreadId = instance?.threadId ?? info.threadId ?? '';
  const providerSessionId = instance?.sessionId ?? (
    productThreadId ? getResolvedExternalSessionId(productThreadId) : null
  );
  const { model, usage } = computeAgentThreadCardBadgeData({
    threadState: undefined,
    codexModel,
    typeKey: info.typeKey,
  });
  const cwd = getAgentConversationRuntimeCwd(instance);

  return (
    <div
      data-tauri-drag-region
      className="ml-2 flex min-w-0 items-center gap-2"
    >
      <span className="agent-thread-card__badge-hover-wrapper shrink-0 [-webkit-app-region:no-drag]">
        <BadgeHoverCard
          threadId={productThreadId || undefined}
          sessionId={providerSessionId ?? undefined}
          model={model}
          usage={usage}
          onRequestRuntimeInfo={createRuntimeInfoRequester(
            info.typeKey,
            () => productThreadId || null,
            () => providerSessionId,
          )}
          codex={info.typeKey === 'codex'}
          cwd={cwd}
        />
        <span className="agent-type-badge shrink-0" aria-hidden="true">
          <AgentIcon typeKey={info.typeKey} alt="" className="agent-type-badge__icon" />
        </span>
      </span>
      {isEditingTitle ? (
        <div className="min-w-0 flex-[0_1_auto] truncate rounded px-0.5 py-1 text-sm font-semibold leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] focus-within:bg-[var(--muted)] [-webkit-app-region:no-drag]">
          <input
            autoFocus
            value={titleDraft}
            aria-label="重命名会话"
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                commitTitle();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setIsEditingTitle(false);
              }
            }}
            className="agent-thread-card__title-input h-auto max-w-full min-w-0 border-0 bg-transparent p-0 font-inherit leading-none text-[var(--foreground)] shadow-none outline-none ring-0 focus:border-0 focus:bg-transparent focus:outline-none focus:ring-0 [-webkit-app-region:no-drag]"
          />
        </div>
      ) : (
        <span
          className="min-w-0 flex-[0_1_auto] truncate rounded px-0.5 py-1 text-sm font-semibold leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] [-webkit-app-region:no-drag]"
          onDoubleClick={() => {
            setTitleDraft(title);
            setIsEditingTitle(true);
          }}
        >
          {title}
        </span>
      )}
    </div>
  );
}

// =====================================================================
// Memo action group — color + ellipsis dropdown
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

    void memosClient.listVersions(memoId)
      .then((items) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        setVersions(items);
      })
      .catch((err) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        logger.error('list versions failed', { error: err, memoId });
        setOpen(false);
        toast.error(t("document.version.loadFailed"));
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
        className="group flex h-7 w-full cursor-pointer items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
        onFocus={() => setOpen(true)}
      >
        <ClockIcon className="w-4 h-4 mr-2" />
        <span className="flex-1 text-left">{t("document.version.menuLabel")}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]" />
      </button>

      {open && (
        <div className="absolute right-full top-0 z-[151] w-[300px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
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

            {!loading && orderedVersions.length === 0 && (
              <div className="px-2 py-3 text-xs text-[var(--muted-foreground)]">
                {t("document.version.empty")}
              </div>
            )}

            {!loading && orderedVersions.map((version) => {
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
                className="group block w-full rounded-lg px-2 py-2 text-left hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-60"
                title={version.title || version.filename}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)] group-hover:text-[var(--foreground)]">
                    {formatVersionTime(version.createdAt, language)}
                  </span>
                  {isRestoring && (
                    <Loader2 className="h-3 w-3 animate-spin text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
                  )}
                  <span className="rounded bg-[var(--background)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)] group-hover:bg-[var(--card)] group-hover:text-[var(--foreground)]">
                    {translate(language, VERSION_SOURCE_LABEL_KEYS[version.source] ?? "") || version.source}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
                  <span className="min-w-0 flex-1 truncate group-hover:text-[var(--foreground)]">
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
  onCopyLink,
  onCopyFullText,
  onOpenProperties,
  onTogglePin,
  onExportMarkdown,
  onSaveAsTemplate,
  onExportWord,
  onRequestDeleteMemo,
  onColorsChange,
  canEditProperties,
  canCopyFullText,
  canExportContent,
  canSaveAsTemplate,
  canViewVersionHistory,
}: {
  memo: MemoItem;
  iconButtonClass: string;
  onCopyLink: () => void;
  onCopyFullText: () => void;
  onOpenProperties: () => void;
  onTogglePin: () => void;
  onExportMarkdown: () => void;
  onSaveAsTemplate: () => void;
  onExportWord: () => void;
  onRequestDeleteMemo: () => void;
  onColorsChange: (next: MemoColor[]) => void;
  canEditProperties: boolean;
  canCopyFullText: boolean;
  canExportContent: boolean;
  canSaveAsTemplate: boolean;
  canViewVersionHistory: boolean;
}) {
  const { t, language } = useI18n();
  const isPinned = !!memo.favorited;
  const [confirmVersion, setConfirmVersion] = useState<MemoVersionMeta | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [versionRefreshKey, setVersionRefreshKey] = useState(0);

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
        replaceActiveMemoPath(memo.id, restored.path);
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
      logger.error('restore version failed', { error: err, memoId: memo.id });
      toast.error(t("document.version.restoreFailed"));
    } finally {
      setRestoringVersionId(null);
    }
  };

  return (
    <>
      <MemoColorPicker
        colors={memo.colors}
        iconButtonClass={iconButtonClass}
        onChange={onColorsChange}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Tooltip content={t("document.titlebar.moreTooltip")}>
            <button className={iconButtonClass}>
              <Ellipsis className="w-4 h-4" />
            </button>
          </Tooltip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DropdownMenuItem
            onClick={onCopyLink}
            className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
          >
            <LinkSimpleIcon className="w-4 h-4 mr-2" /> {t("document.action.copyLink")}
          </DropdownMenuItem>
          {canCopyFullText && (
            <DropdownMenuItem
              onClick={onCopyFullText}
              className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              <CopyIcon className="w-4 h-4 mr-2" /> {t("document.action.copyFullText")}
            </DropdownMenuItem>
          )}
          {canEditProperties && (
            <DropdownMenuItem
              onClick={onOpenProperties}
              className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              <StackSimpleIcon className="w-4 h-4 mr-2" /> {t("document.action.properties")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={onTogglePin}
            className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
          >
            {isPinned ? (
              <><PushPinSlashIcon className="w-4 h-4 mr-2" /> {t("document.action.unpin")}</>
            ) : (
              <><PushPinIcon className="w-4 h-4 mr-2" /> {t("document.action.pin")}</>
            )}
          </DropdownMenuItem>
          {(canSaveAsTemplate || canExportContent) && (
            <div role="separator" aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--border-popup)] opacity-60" />
          )}
          {canSaveAsTemplate && (
            <DropdownMenuItem
              onClick={onSaveAsTemplate}
              className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              <SwatchesIcon className="w-4 h-4 mr-2" /> {t("document.action.saveAsTemplate")}
            </DropdownMenuItem>
          )}
          {canExportContent && (
            <>
              <DropdownMenuItem
                onClick={onExportMarkdown}
                className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <FileMdIcon className="w-4 h-4 mr-2" /> {t("document.action.exportMarkdown")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onExportWord}
                className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <FileDocIcon className="w-4 h-4 mr-2" /> {t("document.action.exportWord")}
              </DropdownMenuItem>
            </>
          )}
          <div role="separator" aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--border-popup)] opacity-60" />
          {canViewVersionHistory && (
            <VersionHistorySubmenu
              memoId={memo.id}
              refreshKey={versionRefreshKey}
              restoringVersionId={restoringVersionId}
              onSelectVersion={setConfirmVersion}
            />
          )}
          <DropdownMenuItem
            onClick={onRequestDeleteMemo}
            className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-[var(--destructive)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
          >
            <TrashSimpleIcon className="w-4 h-4 mr-2" /> {t("document.action.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={!!confirmVersion} onOpenChange={(open) => !open && setConfirmVersion(null)}>
        <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
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
