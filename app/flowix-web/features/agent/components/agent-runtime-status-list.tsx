'use client';

import type { ReactNode } from 'react';
import { AGENT_TYPES, isAgentTypeComingSoon } from '@/lib/agent-types';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@features/i18n';
import type { AgentTypeKey } from '@/types/agent';
import type { AgentRuntimeAvailability } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

type AgentRuntimeStatusByType = Partial<Record<AgentTypeKey, AgentRuntimeAvailability>>;

interface AgentRuntimeStatusListProps {
  statusByType: AgentRuntimeStatusByType;
  isChecking: boolean;
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
}

export function getAgentRuntimeStatusText({
  typeKey,
  status,
  isChecking,
  t,
}: {
  typeKey?: AgentTypeKey;
  status: AgentRuntimeAvailability | undefined;
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
  if (status?.available === false) return translate('agent.status.setup');
  if (status === undefined && isChecking) return translate('agent.status.checking');
  if (status === undefined) return translate('agent.status.notChecked');
  return '';
}

export function AgentRuntimeStatusList({
  statusByType,
  isChecking,
  onSetupClick,
  rowClassName,
  statusClassName,
  variant = 'menu',
  renderAfterRow,
  headerAction,
  highlightedKey,
  onCardClick,
}: AgentRuntimeStatusListProps) {
  const { t } = useI18n();
  const agentVisibility = useUserSettingsStore((s) => s.settings.agents.enabledByType);
  const updateSettings = useUserSettingsStore((s) => s.updateSettings);

  // 解析 i18n 文案 ── 卡片有 nameKey/descKey 就走 t(), 缺省回退到 type.name
  // / type.desc 的硬编码英文 (供编辑器节点等非 React 上下文用)。
  const displayName = (type: (typeof AGENT_TYPES)[number]): string =>
    type.nameKey ? t(type.nameKey as Parameters<typeof t>[0]) : type.name;
  const displayDesc = (type: (typeof AGENT_TYPES)[number]): string =>
    type.descKey ? t(type.descKey as Parameters<typeof t>[0]) : type.desc;

  const setAgentSlashEnabled = (typeKey: AgentTypeKey, enabled: boolean) => {
    void updateSettings({
      agents: {
        enabledByType: {
          ...agentVisibility,
          [typeKey]: enabled,
        },
      },
    });
  };

  if (variant === 'preferences') {
    return (
      <div>
        {AGENT_TYPES.map((type) => {
          const status = statusByType[type.key];
          const comingSoon = isAgentTypeComingSoon(type.key);
          const unavailable = comingSoon || status?.available === false;
          const statusText = getAgentRuntimeStatusText({ typeKey: type.key, status, isChecking, t });
          const canSetup = !comingSoon && status?.available === false && Boolean(onSetupClick);
          const available = !comingSoon && status?.available === true;
          const slashEnabled = agentVisibility[type.key] ?? true;

          return (
            <div
              key={type.key}
              className={cn(
                'rounded-lg border border-[var(--border)] overflow-hidden px-3 [&+&]:mt-3',
                highlightedKey === type.key && 'bg-[var(--document-bg)]',
              )}
            >
              <div
                role={onCardClick ? 'button' : undefined}
                tabIndex={onCardClick ? 0 : undefined}
                title={comingSoon ? statusText : unavailable ? status?.reason ?? `${displayName(type)} is unavailable` : displayDesc(type)}
                onClick={onCardClick ? () => {
                  // 行内已有的 stopPropagation 子节点 (switch / Setup 按钮 /
                  // headerAction) 不会冒泡到这里; 其它位置 (icon / name /
                  // desc / 空白) 落到这里触发展开。
                  onCardClick(type.key);
                } : undefined}
                onKeyDown={onCardClick ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onCardClick(type.key);
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
                    <img
                      src={type.icon}
                      alt={displayName(type)}
                      className={cn(
                        'h-full w-full object-contain',
                        unavailable && 'grayscale opacity-60'
                      )}
                      draggable={false}
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
                      aria-checked={slashEnabled}
                      aria-label={`${displayName(type)} slash menu visibility`}
                      onClick={() => setAgentSlashEnabled(type.key, !slashEnabled)}
                      className={cn(
                        'relative h-5 w-9 rounded-full border transition-colors outline-none',
                        'focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2',
                        slashEnabled
                          ? 'border-[var(--primary)] bg-[var(--primary)]'
                          : 'border-[var(--border)] bg-[var(--muted)]'
                      )}
                    >
                      <span
                        className={cn(
                          'absolute left-0.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-[var(--primary-foreground)] shadow-sm transition-transform',
                          slashEnabled ? 'translate-x-4' : 'translate-x-0'
                        )}
                      />
                    </button>
                    {headerAction?.(type.key)}
                  </div>
                ) : canSetup ? (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="flex shrink-0 items-center gap-3"
                  >
                    <Button
                      variant="outline"
                      className="px-3"
                      onClick={() => onSetupClick?.(type.key)}
                    >
                      {t('agent.status.setup')}
                    </Button>
                    {headerAction?.(type.key)}
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
                    {headerAction?.(type.key)}
                  </div>
                )}
              </div>
              {renderAfterRow?.(type.key)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {AGENT_TYPES.map((type) => {
        const status = statusByType[type.key];
        const comingSoon = isAgentTypeComingSoon(type.key);
        const unavailable = comingSoon || status?.available === false;
        const statusText = getAgentRuntimeStatusText({ typeKey: type.key, status, isChecking, t });
        const interactive = !comingSoon && status?.available === false && Boolean(onSetupClick);

        return (
          <button
            key={type.key}
            type="button"
            disabled={!interactive}
            onClick={() => onSetupClick?.(type.key)}
            title={comingSoon ? statusText : unavailable ? status?.reason ?? `${displayName(type)} is unavailable` : displayDesc(type)}
            className={cn(
              'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors',
              interactive ? 'cursor-pointer hover:bg-[var(--accent)]' : 'cursor-default',
              !interactive && 'disabled:opacity-100',
              rowClassName
            )}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--border)] p-1">
              <img
                src={type.icon}
                alt=""
                className={cn(
                  'h-full w-full object-contain',
                  unavailable && 'grayscale opacity-60'
                )}
                draggable={false}
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
