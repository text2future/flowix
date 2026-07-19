'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AgentRuntimeStatusList } from '@features/agent/components/agent-runtime-status-list';
import { openAgentSetup } from '@features/agent/agent-setup';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { useI18n } from '@features/i18n';
import { FieldRow, SectionHeader } from '@features/preferences/sections/primitives';
import { AgentSection } from '@features/preferences/sections/agent';
import { ExternalPathRow } from '@features/preferences/sections/external-path-row';
import { agent, type AgentExternalEntry } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { AGENT_TYPES } from '@/lib/agent-types';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

type CollapsibleAgentKey = 'flowix' | 'codex' | 'claude' | 'gemini' | 'hermes' | 'openclaw';

/// "使用自定义模型" 文档链接, codex/claude 的"查看"按钮跳转此处。
const CUSTOM_MODEL_DOCS_URL = 'https://flowix-memo.com/docs/ai-access/';

export function AgentsSection() {
  const { t } = useI18n();
  const statusByType = useAgentRuntimeStore((s) => s.statusByType);
  const isChecking = useAgentRuntimeStore((s) => s.isChecking);
  const refreshIfStale = useAgentRuntimeStore((s) => s.refreshIfStale);
  const refreshStatus = useAgentRuntimeStore((s) => s.refresh);

  // 单展开态: 任何时刻最多一张 agent 卡片展开, 默认展开 codex。
  // 状态在组件生命周期内维持 ── 切走/回来会回到默认; 需要跨会话保留可下沉到
  // user-settings-store。
  const [expandedKey, setExpandedKey] = useState<CollapsibleAgentKey | null>('codex');
  // External CLI 路径配置 (~/.flowix/agent-external-config.json) ──
  // 唯一参照, 偏好设置可改 path / 重新探测。改 path 后同步刷 runtime status。
  const [externalConfig, setExternalConfig] =
    useState<Record<string, AgentExternalEntry> | null>(null);

  const refreshExternal = useCallback(async () => {
    try {
      setExternalConfig(await agent.getExternalConfig());
    } catch (err) {
      console.warn('[agents] failed to load external config:', err);
    }
    void refreshStatus({ force: true });
  }, [refreshStatus]);

  useEffect(() => {
    void refreshIfStale();
    void refreshExternal();
  }, [refreshIfStale, refreshExternal]);

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
    const isCollapsible =
      typeKey === 'flowix' ||
      typeKey === 'codex' ||
      typeKey === 'claude' ||
      typeKey === 'gemini' ||
      typeKey === 'hermes' ||
      typeKey === 'openclaw';
    if (!isCollapsible) {
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
          const renderExternalPath = () => {
            const def = AGENT_TYPES.find((a) => a.key === typeKey);
            const displayName = def?.name ?? typeKey;
            // codex 走终端 npm install; 其余走 openAgentSetup 引导页。
            const onInstall =
              typeKey === 'codex'
                ? () => void openCodexInstallTerminal()
                : () => void openAgentSetup(typeKey);
            return (
              <ExternalPathRow
                agentType={typeKey}
                displayName={displayName}
                entry={externalConfig?.[typeKey]}
                onInstall={onInstall}
                onChanged={() => void refreshExternal()}
              />
            );
          };
          if (typeKey === 'flowix') {
            // 模型配置整段塞到 Flowix 卡片里 ── 用户展开 Flowix 时直接看到
            // 供应商/模型/key 的表单, 不用跳到独立 tab。
            return renderCollapsible(
              'flowix',
              <div className="border-t border-[var(--divider)] py-3">
                <AgentSection />
              </div>,
            );
          }
          if (typeKey === 'claude') {
            return renderCollapsible(
              'claude',
              <>
                {renderExternalPath()}
                <FieldRow
                  title={t('preferences.agents.claude.customModelPrompt')}
                  className="border-t border-[var(--divider)] py-4"
                >
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void openUrl(CUSTOM_MODEL_DOCS_URL)}
                  >
                    {t('preferences.agents.claude.configure')}
                  </Button>
                </FieldRow>
              </>,
            );
          }
          if (typeKey === 'codex') {
            return renderCollapsible(
              'codex',
              <>
                {renderExternalPath()}
                <FieldRow
                  title={t('preferences.agents.codex.customModelPrompt')}
                  className="border-t border-[var(--divider)] py-4"
                >
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void openUrl(CUSTOM_MODEL_DOCS_URL)}
                  >
                    {t('preferences.agents.codex.configure')}
                  </Button>
                </FieldRow>
              </>,
            );
          }
          // gemini / hermes / openclaw: 只展示状态 + 执行路径。
          if (typeKey === 'gemini' || typeKey === 'hermes' || typeKey === 'openclaw') {
            return renderCollapsible(typeKey as CollapsibleAgentKey, renderExternalPath());
          }
          return null;
        }}
      />
    </div>
  );
}
