'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { AgentRuntimeStatusList } from '@features/agent/components/agent-runtime-status-list';
import { openAgentSetup } from '@features/agent/agent-setup';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { useI18n } from '@features/i18n';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { AgentSection } from '@features/preferences/sections/agent';
import { agent, dialogs } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type { AgentTypeKey } from '@/types/agent';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

type CollapsibleAgentKey = 'flowix' | 'claude' | 'codex';

export function AgentsSection() {
  const { t } = useI18n();
  const statusByType = useAgentRuntimeStore((s) => s.statusByType);
  const isChecking = useAgentRuntimeStore((s) => s.isChecking);
  const refreshIfStale = useAgentRuntimeStore((s) => s.refreshIfStale);
  const refreshStatus = useAgentRuntimeStore((s) => s.refresh);
  const agentsSettings = useUserSettingsStore((s) => s.settings.agents);
  const updateSettings = useUserSettingsStore((s) => s.updateSettings);
  const flushPending = useUserSettingsStore((s) => s.flushPending);

  // 单展开态: 任何时刻最多一张 agent 卡片展开, 默认展开 codex。
  // 状态在组件生命周期内维持 ── 切走/回来会回到默认; 需要跨会话保留可下沉到
  // user-settings-store。
  const [expandedKey, setExpandedKey] = useState<CollapsibleAgentKey | null>('codex');

  useEffect(() => {
    void refreshIfStale();
  }, [refreshIfStale]);

  const toggleExpanded = (key: CollapsibleAgentKey) => {
    // 同一张再点一次 → 折叠; 不同张 → 切到新的那张。
    setExpandedKey((prev) => (prev === key ? null : key));
  };

  const renderCollapsible = (
    key: CollapsibleAgentKey,
    children: ReactNode,
  ) => {
    if (expandedKey !== key) return null;
    return <>{children}</>;
  };

  const renderHeaderAction = (typeKey: string) => {
    if (typeKey !== 'flowix' && typeKey !== 'claude' && typeKey !== 'codex') {
      return null;
    }
    const key = typeKey as CollapsibleAgentKey;
    const isOpen = expandedKey === key;
    return (
      <button
        type="button"
        onClick={() => toggleExpanded(key)}
        aria-expanded={isOpen}
        aria-label={
          isOpen
            ? t('preferences.agents.collapse')
            : t('preferences.agents.expand')
        }
        className="flex h-7 w-7 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 transition-transform',
            !isOpen && 'rotate-180',
          )}
        />
      </button>
    );
  };

  const openCodexInstallTerminal = async () => {
    try {
      await agent.openCodexCliInstallTerminal();
      toast.info(t('preferences.agents.codex.installTerminalOpened'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t('preferences.agents.codex.installOpenFailed', { message }));
    }
  };

  const openCodexConfig = async () => {
    try {
      await agent.openCodexConfig();
      toast.info(t('preferences.agents.codex.configOpened'));
      void refreshStatus({ force: true, type: 'codex' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t('preferences.agents.codex.configOpenFailed', { message }));
    }
  };

  const persistCustomLocation = async (
    typeKey: AgentTypeKey,
    enabled: boolean,
    location?: string,
  ) => {
    await updateSettings({
      agents: {
        customLocationEnabledByType: {
          ...agentsSettings.customLocationEnabledByType,
          [typeKey]: enabled,
        },
        customLocations: location === undefined
          ? agentsSettings.customLocations
          : {
              ...agentsSettings.customLocations,
              [typeKey]: location,
            },
      },
    });
    await flushPending();
    await refreshStatus({ force: true, type: typeKey });
  };

  const chooseCustomLocation = async (typeKey: AgentTypeKey) => {
    const location = await dialogs.selectAgentRuntimeDirectory();
    if (!location) return;
    await persistCustomLocation(typeKey, true, location);
  };

  const renderCustomLocation = (typeKey: AgentTypeKey) => {
    if (typeKey === 'flowix') return null;
    const enabled = agentsSettings.customLocationEnabledByType[typeKey] === true;
    const configuredPath = agentsSettings.customLocations[typeKey] ?? '';
    const status = statusByType[typeKey];
    return (
      <div className="border-t border-[var(--divider)] py-2.5">
        <div className="flex items-center justify-between gap-4">
          <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--foreground)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => void persistCustomLocation(typeKey, event.target.checked)}
              className="h-4 w-4 rounded border-[var(--border)] accent-[var(--primary)]"
            />
            {t('preferences.agents.customLocation.enabled')}
          </label>
          {enabled && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full text-xs"
              onClick={() => void chooseCustomLocation(typeKey)}
            >
              {configuredPath
                ? t('preferences.agents.customLocation.change')
                : t('preferences.agents.customLocation.choose')}
            </Button>
          )}
        </div>
        {enabled && (
          <div className="mt-2 min-w-0 rounded-md bg-[var(--muted)] px-2.5 py-2 text-[11px] text-[var(--muted-foreground)]">
            <div className="truncate" title={configuredPath || undefined}>
              {configuredPath || t('preferences.agents.customLocation.notSelected')}
            </div>
            {status?.binaryPath && (
              <div className="mt-1 truncate" title={status.binaryPath}>
                {t('preferences.agents.customLocation.resolved')}: {status.binaryPath}
              </div>
            )}
            {status?.reason && <div className="mt-1 text-[var(--destructive)]">{status.reason}</div>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 pb-6">
      <SectionHeader
        title={t('preferences.agents.title')}
        description={t('preferences.agents.subtitle')}
      />
      <AgentRuntimeStatusList
        statusByType={statusByType}
        isChecking={isChecking}
        variant="preferences"
        onSetupClick={(typeKey) => {
          void openAgentSetup(typeKey);
        }}
        headerAction={renderHeaderAction}
        highlightedKey={expandedKey}
        // 整张卡片可点击展开/折叠 ── 不再局限于 chevron 按钮。
        // 父容器内部对 switch / Setup / headerAction 都做了 stopPropagation,
        // 互不串味。
        onCardClick={(key) => toggleExpanded(key as CollapsibleAgentKey)}
        renderAfterRow={(typeKey) => {
          if (typeKey === 'flowix') {
            // 模型配置整段塞到 Flowix 卡片里 ── 用户展开 Flowix 时直接看到
            // 供应商/模型/key 的表单, 不用跳到独立 tab。原先那个"配置"
            // 跳转按钮一并去掉 (openAgentSetup('flowix') 的引导意义被这
            // 个内嵌表单完全覆盖)。
            return renderCollapsible(
              'flowix',
              <div className="border-t border-[var(--divider)] py-3">
                <AgentSection />
              </div>,
            );
          }
          if (typeKey === 'claude') {
            const claudeInstalled = statusByType.claude?.available === true;
            return renderCollapsible(
              'claude',
              <>
                <div className="flex items-center justify-between gap-4 border-t border-[var(--divider)] py-2.5">
                  <span className="min-w-0 text-xs text-[var(--foreground)]">
                    {claudeInstalled
                      ? t('preferences.agents.claude.installedPrompt')
                      : t('preferences.agents.claude.installPrompt')}
                  </span>
                  {claudeInstalled ? (
                    <span className="shrink-0 px-1 text-xs font-medium text-[var(--muted-foreground)]">
                      {t('preferences.agents.claude.installed')}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() => void openAgentSetup('claude')}
                    >
                      {t('preferences.agents.claude.install')}
                    </Button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-[var(--divider)] py-2.5">
                  <span className="min-w-0 text-xs text-[var(--foreground)]">
                    {t('preferences.agents.claude.authPrompt')}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => void openAgentSetup('claude')}
                  >
                    {t('preferences.agents.claude.auth')}
                  </Button>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-[var(--divider)] py-2.5">
                  <span className="min-w-0 text-xs text-[var(--foreground)]">
                    {t('preferences.agents.claude.customModelPrompt')}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full text-xs"
                    onClick={() => void openAgentSetup('claude')}
                  >
                    {t('preferences.agents.claude.configure')}
                  </Button>
                </div>
                {renderCustomLocation(typeKey)}
              </>,
            );
          }
          if (typeKey === 'codex') {
            const codexInstalled = statusByType.codex?.available === true;
            return renderCollapsible(
              'codex',
              <>
                <div className="flex items-center justify-between gap-4 border-t border-[var(--divider)] py-2.5">
                  <span className="min-w-0 text-xs text-[var(--foreground)]">
                    {codexInstalled
                      ? t('preferences.agents.codex.installedPrompt')
                      : t('preferences.agents.codex.downloadPrompt')}
                  </span>
                  {codexInstalled ? (
                    <span className="shrink-0 px-1 text-xs font-medium text-[var(--muted-foreground)]">
                      {t('preferences.agents.codex.installed')}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() => void openCodexInstallTerminal()}
                    >
                      {t('preferences.agents.codex.download')}
                    </Button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-[var(--divider)] py-2.5">
                  <span className="min-w-0 text-xs text-[var(--foreground)]">
                    {t('preferences.agents.codex.customModelPrompt')}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full text-xs"
                    onClick={() => void openCodexConfig()}
                  >
                    {t('preferences.agents.codex.configure')}
                  </Button>
                </div>
                {renderCustomLocation(typeKey)}
              </>,
            );
          }
          return renderCustomLocation(typeKey);
        }}
      />
    </div>
  );
}
