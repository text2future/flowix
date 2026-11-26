'use client';

import type { ReactNode } from 'react';
import { AGENT_TYPES, isAgentTypeComingSoon } from '@/lib/agent-types';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { AgentRuntimeSnapshot, AgentTypeKey } from '@/types/agent';
import {
  normalizeAgentRuntimeStatus,
  type AgentRuntimeStatusView,
} from '@features/agent/runtime/agent-runtime-status';
import { Button } from '@shared/ui/button';
import { useAgentVisibilityPreferences } from '@features/preferences/public/runtime-api';
import { AgentIcon } from '@features/agent/components/agent-icon';

type AgentRuntimeStatusByType = Partial<Record<AgentTypeKey, AgentRuntimeSnapshot>>;

interface AgentRuntimeStatusListProps {
  statusByType: AgentRuntimeStatusByType;
  isChecking: boolean;
  /** Optional display priority; unspecified agents retain their catalog order. */
  displayOrder?: readonly AgentTypeKey[];
  onSetupClick?: (typeKey: AgentTypeKey) => void;
  rowClassName?: string;
  statusClassName?: string;
  variant?: 'menu' | 'preferences';
  renderAfterRow?: (typeKey: AgentTypeKey) => ReactNode;
  /**
   * 注入到 agent 行最右侧的额外按钮 ── 例如"折叠子配置项"的 chevron。
   * 只在 `variant === 'preferences'` 下生效, menu 变体不显示。
   * 调用方负责传入 `null` / `undefined` 时不渲染（避免空按钮占位）。
   */
  headerAction?: (typeKey: AgentTypeKey) => ReactNode;
  /**
   * 高亮某一行的整张卡片 (使用 `bg-[var(--document-bg)]`)。在 preferences 变体
   * 下生效, 通常配合"单展开态"使用 ── 当前展开的那张卡片用 document 背景,
   * 视觉上把"展开的内容"和"折叠的列表项"区分开。
   */
  highlightedKey?: AgentTypeKey | null;
  /**
   * 整行被点击时调用 (preferences 变体生效) ── 父级接这个回调做展开/折叠
   * 切换。行内的开关 / 按钮在组件内部已经 stopPropagation, 不会误触。
   */
  onCardClick?: (typeKey: AgentTypeKey) => void;
  /**
   * 需要隐藏的 agent key 集合。隐藏项既不渲染，也不会传给
   * `renderAfterRow` / `onCardClick`。
   */
  hiddenKeys?: ReadonlySet<AgentTypeKey>;
}

export function getAgentRuntimeStatusText({
  typeKey,
  status,
  isChecking,
  t,
}: {
  typeKey?: AgentTypeKey;
  status: AgentRuntimeSnapshot | undefined;
  isChecking: boolean;
  t?: (key: I18nKey) => string;
}): string {
  const fallback: Partial<Record<I18nKey, string>> = {
    'agent.status.available': 'Available',
    'agent.status.checking': 'Checking...',
    'agent.status.notChecked': 'Not checked',
    'agent.status.setup': 'Setup',
    'agent.status.comingSoon': 'Coming soon',
  };
  const translate = t ?? ((key: I18nKey) => fallback[key] ?? key);
  if (typeKey && isAgentTypeComingSoon(typeKey)) return translate('agent.status.comingSoon');
  const runtimeState = normalizeAgentRuntimeStatus(status, isChecking).state;
  if (runtimeState === 'not-installed' || runtimeState === 'not-ready') {
    return translate('agent.status.setup');
  }
  if (runtimeState === 'checking') return translate('agent.status.checking');
  if (runtimeState === 'unknown') return translate('agent.status.notChecked');
  return '';
}

function isRuntimeUnavailable(status: AgentRuntimeStatusView): boolean {
  return status.state === 'not-installed' || status.state === 'not-ready';
}

export function AgentRuntimeStatusList({
  statusByType,
  isChecking,
  displayOrder,
  onSetupClick,
  rowClassName,
  statusClassName,
  variant = 'menu',
  renderAfterRow,
  headerAction,
  highlightedKey,
  onCardClick,
  hiddenKeys,
}: AgentRuntimeStatusListProps) {
  const isVisible = (typeKey: AgentTypeKey) =>
    !hiddenKeys?.has(typeKey);
  const orderedAgentTypes = displayOrder
    ? [...AGENT_TYPES].sort((left, right) => {
        const leftPriority = displayOrder.indexOf(left.id);
        const rightPriority = displayOrder.indexOf(right.id);
        if (leftPriority < 0) return rightPriority < 0 ? 0 : 1;
        if (rightPriority < 0) return -1;
        return leftPriority - rightPriority;
      })
    : AGENT_TYPES;
  const visibleAgentTypes = orderedAgentTypes.filter((type) => isVisible(type.id));
  const { t } = useI18n();
  const { enabledByType: agentEnabledByType, setEnabled } = useAgentVisibilityPreferences();

  // 解析 i18n 文案 ── 卡片有 nameKey/descKey 就走 t(), 缺省回退到 type.name
  // / type.desc 的硬编码英文 (供编辑器节点等非 React 上下文用)。
  const displayName = (type: (typeof AGENT_TYPES)[number]): string =>
    type.nameKey ? t(type.nameKey as Parameters<typeof t>[0]) : type.name;
  const displayDesc = (type: (typeof AGENT_TYPES)[number]): string =>
    type.descKey ? t(type.descKey as Parameters<typeof t>[0]) : type.desc;

  const setAgentEnabled = (typeKey: AgentTypeKey, enabled: boolean) => {
    void setEnabled(typeKey, enabled);
  };

  if (variant === 'preferences') {
    return (
      <div>
        {visibleAgentTypes.map((type) => {
          const status = statusByType[type.id];
          const comingSoon = isAgentTypeComingSoon(type.id);
          const runtimeStatus = normalizeAgentRuntimeStatus(status, isChecking);
          const unavailable = comingSoon || isRuntimeUnavailable(runtimeStatus);
          const statusText = getAgentRuntimeStatusText({ typeKey: type.id, status, isChecking, t });
          const canSetup = !comingSoon && isRuntimeUnavailable(runtimeStatus) && Boolean(onSetupClick);
          const available = !comingSoon && runtimeStatus.state === 'ready';
          const agentEnabled = agentEnabledByType[type.id] ?? true;

          return (
            <div
              key={type.id}
              className={cn(
                'rounded-lg border border-[var(--border)] overflow-hidden px-3 [&+&]:mt-3',
                highlightedKey === type.id && 'bg-[var(--document-bg)]',
              )}
            >
              <div
                role={onCardClick ? 'button' : undefined}
                tabIndex={onCardClick ? 0 : undefined}
                title={comingSoon ? statusText : unavailable ? runtimeStatus.reason ?? `${displayName(type)} is unavailable` : displayDesc(type)}
                onClick={onCardClick ? () => {
                  // 行内已有的 stopPropagation 子节点 (switch / Setup 按钮 /
                  // headerAction) 不会冒泡到这里; 其它位置 (icon / name /
                  // desc / 空白) 落到这里触发展开。
                  onCardClick(type.id);
                } : undefined}
                onKeyDown={onCardClick ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onCardClick(type.id);
                  }
                } : undefined}
                className={cn(
                  'flex items-center justify-between gap-4 py-3 select-none',
                  onCardClick && 'cursor-pointer hover:bg-[var(--accent)]/40 transition-colors',
                  rowClassName
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--border)] p-1">
                    <AgentIcon
                      typeKey={type.id}
                      alt={displayName(type)}
                      className={cn(
                        'h-full w-full object-contain',
                        unavailable && 'grayscale opacity-60'
                      )}
                    />
                  </span>
                  <div className="min-w-0">
                    <div
                      className={cn(
                        'text-sm font-normal',
                        unavailable ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'
                      )}
                    >
                      {displayName(type)}
                    </div>
                    <div className="truncate text-sm text-[var(--muted-foreground)]">
                      {displayDesc(type)}
                    </div>
                  </div>
                </div>
                {available ? (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="flex shrink-0 items-center gap-3"
                  >
                    <span className="text-sm text-[var(--muted-foreground)]">
                      {statusText}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={agentEnabled}
                      aria-label={t('preferences.agents.enableAgent', { name: displayName(type) })}
                      onClick={() => setAgentEnabled(type.id, !agentEnabled)}
                      className={cn(
                        'relative h-5 w-9 rounded-full border transition-colors outline-none',
                        'focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2',
                        agentEnabled
                          ? 'border-[var(--primary)] bg-[var(--primary)]'
                          : 'border-[var(--border)] bg-[var(--muted)]'
                      )}
                    >
                      <span
                        className={cn(
                          'absolute left-0.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-[var(--card)] shadow-sm transition-transform',
                          agentEnabled ? 'translate-x-4' : 'translate-x-0'
                        )}
                      />
                    </button>
                    {headerAction?.(type.id)}
                  </div>
                ) : canSetup ? (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="flex shrink-0 items-center gap-3"
                  >
                    <Button
                      variant="outline"
                      className="px-3"
                      onClick={() => onSetupClick?.(type.id)}
                    >
                      {t('agent.status.setup')}
                    </Button>
                    {headerAction?.(type.id)}
                  </div>
                ) : (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="flex shrink-0 items-center gap-3"
                  >
                    <span
                      className={cn(
                        'shrink-0 text-sm text-[var(--muted-foreground)]',
                        statusClassName
                      )}
                    >
                      {statusText}
                    </span>
                    {headerAction?.(type.id)}
                  </div>
                )}
              </div>
              {renderAfterRow?.(type.id)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {visibleAgentTypes.map((type) => {
        const status = statusByType[type.id];
        const comingSoon = isAgentTypeComingSoon(type.id);
        const runtimeStatus = normalizeAgentRuntimeStatus(status, isChecking);
        const unavailable = comingSoon || isRuntimeUnavailable(runtimeStatus);
        const statusText = getAgentRuntimeStatusText({ typeKey: type.id, status, isChecking, t });
        const interactive = !comingSoon && isRuntimeUnavailable(runtimeStatus) && Boolean(onSetupClick);

        return (
          <button
            key={type.id}
            type="button"
            disabled={!interactive}
            onClick={() => onSetupClick?.(type.id)}
            title={comingSoon ? statusText : unavailable ? runtimeStatus.reason ?? `${displayName(type)} is unavailable` : displayDesc(type)}
            className={cn(
              'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors',
              interactive ? 'cursor-pointer hover:bg-[var(--accent)]' : 'cursor-default',
              !interactive && 'disabled:opacity-100',
              rowClassName
            )}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--border)] p-1">
              <AgentIcon
                typeKey={type.id}
                alt=""
                className={cn(
                  'h-full w-full object-contain',
                  unavailable && 'grayscale opacity-60'
                )}
              />
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm',
                unavailable ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'
              )}
            >
              {displayName(type)}
            </span>
            <span
              className={cn(
                'shrink-0 truncate text-[11px] text-[var(--muted-foreground)]',
                statusClassName
              )}
            >
              {statusText}
            </span>
          </button>
        );
      })}
    </div>
  );
}
