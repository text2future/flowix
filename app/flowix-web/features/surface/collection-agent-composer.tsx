'use client';

/**
 * 集合底部的悬浮 AI 输入框 ── **针对任意集合**，不区分文件夹集合还是独立集合文件。
 *
 * 发送即在当前笔记本里新建一个该 agent 的会话（提示词带上集合上下文由 agent 自己读），
 * 所以它只依赖 notebookId；没有笔记本上下文时只禁用输入，不隐藏。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { AgentIcon } from '@features/agent/public/icon-api';
import {
  createAndOpenAgentConversationWithPrompt,
  useNewConversationAgentSelection,
} from '@features/agent/public/shell-api';
import { getAgentType } from '@/lib/agent-types';
import { useI18n } from '@/lib/i18n';
import type { AgentTypeKey } from '@/types/agent';

/** 收起态固定宽（产品稿）。 */
const COLLAPSED_WIDTH = 120;
/** 展开态 = 视口 80vw，但不超过 680px，且不溢出所在面板（两侧各留 16px 内边距）。 */
const EXPANDED_VIEWPORT_RATIO = 0.8;
const EXPANDED_MAX_WIDTH = 680;
const WRAPPER_HORIZONTAL_PADDING = 32;

export function CollectionAgentComposer({
  notebookId,
  host,
}: {
  notebookId: string | null;
  /** 集合自己所在的位置：新会话永远开到「另一侧」，避免把它顶掉。 */
  host: 'main-third' | 'browser-column';
}) {
  const { t } = useI18n();
  // 产品稿默认 Pi；用户设置里禁用 Pi 时回落到第一个可用（运行期就绪）类型。
  // 仅展示「支持的 Agent」：可选项 + 用户启用 + 运行期 ready，与「新建对话」菜单同源。
  const [agentType, setAgentType] = useState<AgentTypeKey>('pi');
  const [draft, setDraft] = useState('');
  const supportedAgentTypes = useNewConversationAgentSelection().options;

  // ── 伸展动画 ──────────────────────────────────────────────────────────────
  // 收起 120px；输入框/按钮获得焦点（或 agent 菜单打开、已有草稿）后伸展到
  // 80vw（上限 680px，且不超过面板宽度）。宽度用像素值过渡，px→px 在 WKWebView
  // 里插值最稳（px→vw 会退化成跳变）。
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [, setMenuOpen] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth,
  );

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    const measure = () =>
      setAvailableWidth(Math.max(0, node.clientWidth - WRAPPER_HORIZONTAL_PADDING));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 草稿非空时不收回，否则输入内容会被裁掉。只有输入框自身聚焦才展开；
  // 点击 agent 图标（含打开菜单）不展开。
  const expanded = inputFocused || draft.trim().length > 0;
  const expandedWidth = Math.min(
    Math.round(viewportWidth * EXPANDED_VIEWPORT_RATIO),
    EXPANDED_MAX_WIDTH,
    availableWidth > 0 ? availableWidth : EXPANDED_MAX_WIDTH,
  );
  const pillWidth = expanded ? Math.max(COLLAPSED_WIDTH, expandedWidth) : COLLAPSED_WIDTH;

  useEffect(() => {
    if (!supportedAgentTypes.some((type) => type.id === agentType)) {
      setAgentType(supportedAgentTypes[0]?.id ?? 'pi');
    }
  }, [supportedAgentTypes, agentType]);

  const agentName = getAgentType(agentType).name;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sendPrompt = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt || !notebookId) return;
    // 默认在右栏 browser 里新开会话，并把这段输入直接发出去（不是预填）。
    // 集合本身就在 browser 列时反过来开进 Work，否则会把正在编辑的集合顶掉。
    createAndOpenAgentConversationWithPrompt(agentType, notebookId, prompt, {
      destination: host === 'browser-column' ? 'main-third' : 'browser-column',
      autoSend: true,
    });
    setDraft('');
    // 内容已经搬到对话里：收起胶囊回到 120px，让位给刚打开的会话。
    inputRef.current?.blur();
  }, [agentType, draft, host, notebookId]);

  return <div
    ref={wrapperRef}
    className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-4"
  >
    {/* 参照 agent card 胶囊输入框的规格：＋ 附件按钮在输入框左侧（与
        composer-dom-factory 的 DOM 顺序一致），发送按钮是深色圆形 → 箭头。
        收起 120px，聚焦后以中心为锚点向两侧伸展（mx-auto 保证对称生长）。 */}
    <div
      className={`pointer-events-auto mx-auto flex items-center gap-1.5 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--input-bg,var(--card))] py-[5px] pl-2 pr-[5px] transition-[width,box-shadow] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
        expanded
          ? 'shadow-[0_8px_32px_-8px_rgb(0_0_0/0.16)]'
          : 'shadow-[0_2px_24px_-3px_rgb(0_0_0/0.06)]'
      }`}
      style={{ width: pillWidth }}
    >
      <DropdownMenu onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('collection.agentSwitch')}
            title={t('collection.agentSwitch')}
            className="flex h-[26px] shrink-0 items-center gap-0.5 rounded-md p-1 text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] active:bg-[var(--hover-bg)] data-[state=open]:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          >
            <AgentIcon typeKey={agentType} alt={agentName} className="h-[18px] w-[18px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DropdownMenuLabel className="flex items-center gap-1.5 px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
            {t('collection.agentSwitch')}
          </DropdownMenuLabel>
          {supportedAgentTypes.map((type) => (
            <DropdownMenuItem
              key={type.id}
              className={`flex h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] ${type.id === agentType ? 'font-medium' : ''}`}
              onClick={() => setAgentType(type.id)}
            >
              <AgentIcon typeKey={type.id} alt="" className="h-4 w-4 shrink-0 object-contain" />
              <span className="min-w-0 flex-1 truncate">{type.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={() => setInputFocused(true)}
        onBlur={() => setInputFocused(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            sendPrompt();
          }
        }}
        placeholder={notebookId ? t('collection.composerPlaceholder', { name: agentName }) : ''}
        disabled={!notebookId}
        className="h-[30px] min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
      />
      <button
        type="button"
        onClick={sendPrompt}
        disabled={!draft.trim() || !notebookId}
        aria-label={t('collection.composerSend', { name: agentName })}
        title={t('collection.composerSend', { name: agentName })}
        aria-hidden={!expanded}
        tabIndex={expanded ? undefined : -1}
        // 收起态把发送按钮收成 0 宽，让 120px 里留给输入框（否则只剩 40px 用不了）。
        className={`flex h-[28px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] transition-[width,opacity,transform,background-color] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:opacity-90 disabled:cursor-not-allowed disabled:bg-[var(--muted)] disabled:text-[var(--muted-foreground)] motion-reduce:transition-none ${
          expanded ? 'w-[28px] scale-100 opacity-100' : 'w-0 scale-75 opacity-0'
        }`}
      >
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  </div>;
}
