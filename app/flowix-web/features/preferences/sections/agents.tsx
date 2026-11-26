'use client';

import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { openUrl } from '@platform/tauri/opener';
import { AgentRuntimeStatusList } from '@features/agent/components/agent-runtime-status-list';
import { openAgentSetup } from '@features/agent/agent-setup';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { useI18n } from '@/lib/i18n';
import { FieldRow, SectionHeader } from '@features/preferences/sections/primitives';
import { ExternalPathRow } from '@features/preferences/sections/external-path-row';
import {
  agent,
  type AgentExternalEntry,
} from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { AGENT_TYPES } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useAgentDataStore } from '@features/agent/store/agent-data-store';
import { AgentIcon, useNewConversationAgentSelection } from '@features/agent/public/shell-api';
import { setCollectionAgentType, useCollectionAgentType } from '@features/collection/public/agent-api';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';

type CollapsibleAgentKey =
  | 'codex'
  | 'claudecode'
  | 'hermes'
  | 'opencode';

/// "使用自定义模型" 文档链接, codex/claude 的"查看"按钮跳转此处。
const CUSTOM_MODEL_DOCS_URL = 'https://flowix-memo.com/docs/ai-access/';

/// 偏好设置不展示内置 Agent 的路径配置卡片。
const HIDDEN_PREFERENCE_AGENT_KEYS: ReadonlySet<AgentTypeKey> = new Set(['pi']);

const DshInstallDialogContent = lazy(() =>
  import('@features/preferences/sections/dsh').then((module) => ({ default: module.DshInstallDialogContent })),
);

export function AgentsSection() {
  const { t } = useI18n();
  const agentSelection = useNewConversationAgentSelection();
  const selectedAgentType = useCollectionAgentType();
  const selectedAvailableAgent = agentSelection.options.find((type) => type.id === selectedAgentType)
    ?? agentSelection.options[0];
  const persistenceError = useAgentDataStore((state) => state.persistenceError);
  const statusByType = useAgentRuntimeStore((s) => s.statusByType);
  const isChecking = useAgentRuntimeStore((s) => s.isChecking);
  const refreshIfStale = useAgentRuntimeStore((s) => s.refreshIfStale);
  const refreshStatus = useAgentRuntimeStore((s) => s.refresh);

  // 单展开态：初始全部折叠；切走再回来时恢复默认折叠状态。
  const [expandedKey, setExpandedKey] = useState<CollapsibleAgentKey | null>(null);
  const [dshDialogOpen, setDshDialogOpen] = useState(false);
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
  }, []);

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
      typeKey === 'codex' ||
      typeKey === 'claudecode' ||
      typeKey === 'hermes' ||
      typeKey === 'opencode';
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
      {persistenceError && (
        <div
          role="alert"
          className="rounded-md border border-[var(--destructive)]/35 bg-[var(--destructive)]/5 px-3 py-2 text-sm text-[var(--destructive)]"
        >
          {t('preferences.agents.cacheWriteFailed')}
        </div>
      )}
      <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-[var(--foreground)]">
            {t('preferences.agents.defaultAgent.title')}
          </h3>
        </div>
        <Select
          value={selectedAvailableAgent?.id ?? ''}
          disabled={agentSelection.options.length === 0}
          onValueChange={(value) => {
            const nextAgent = agentSelection.options.find((type) => type.id === value);
            if (nextAgent) setCollectionAgentType(nextAgent.id);
          }}
        >
          <SelectTrigger
            aria-label={t('preferences.agents.defaultAgent.title')}
            className="w-full sm:w-[220px]"
          >
            {selectedAvailableAgent ? (
              <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <AgentIcon typeKey={selectedAvailableAgent.id} alt="" className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {selectedAvailableAgent.id === 'pi' ? t('preferences.tabs.pi') : selectedAvailableAgent.name}
                </span>
              </span>
            ) : (
              <span className="text-[var(--muted-foreground)]">
                {t('preferences.agents.defaultAgent.noneAvailable')}
              </span>
            )}
          </SelectTrigger>
          <SelectContent className="w-[220px]" fitViewport maxHeight="50vh">
            {agentSelection.options.map((type) => (
              <SelectItem key={type.id} value={type.id}>
                <span className="flex items-center gap-2">
                  <AgentIcon typeKey={type.id} alt="" className="h-4 w-4 shrink-0" />
                  <span>{type.id === 'pi' ? t('preferences.tabs.pi') : type.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <AgentRuntimeStatusList
        statusByType={statusByType}
        isChecking={isChecking}
        displayOrder={['codex', 'dsh']}
        variant="preferences"
        onSetupClick={(typeKey) => {
          if (typeKey === 'dsh') {
            setDshDialogOpen(true);
            return;
          }
          void openAgentSetup(typeKey);
        }}
        headerAction={renderHeaderAction}
        highlightedKey={expandedKey}
        hiddenKeys={HIDDEN_PREFERENCE_AGENT_KEYS}
        // 整张卡片可点击：外部 Agent 展开/折叠，DSH 打开安装弹窗。
        // 父容器内部对 switch / Setup / headerAction 都做了 stopPropagation。
        onCardClick={(key) => {
          if (key === 'dsh') {
            setDshDialogOpen(true);
            return;
          }
          toggleExpanded(key as CollapsibleAgentKey);
        }}
        renderAfterRow={(typeKey) => {
          const renderExternalPath = () => {
            const def = AGENT_TYPES.find((a) => a.id === typeKey);
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
                onChanged={() => {
                  void refreshExternal();
                  void refreshStatus({ force: true });
                }}
              />
            );
          };
          if (typeKey === 'claudecode') {
            return renderCollapsible(
              'claudecode',
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
          // Hermes / OpenCode: 只展示状态 + 执行路径。
          if (
            typeKey === 'hermes' ||
            typeKey === 'opencode'
          ) {
            return renderCollapsible(typeKey as CollapsibleAgentKey, renderExternalPath());
          }
          return null;
        }}
      />
      <Dialog open={dshDialogOpen} onOpenChange={setDshDialogOpen}>
        <DialogContent className="max-h-[85vh] w-[min(92vw,600px)] max-w-[600px] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('preferences.dsh.title')}</DialogTitle>
            <DialogDescription>{t('preferences.dsh.description')}</DialogDescription>
          </DialogHeader>
          <Suspense fallback={(
            <div className="flex min-h-[280px] items-center justify-center" role="status" aria-busy="true">
              <Loader2 className="size-6 flowix-spin text-[var(--muted-foreground)]" />
              <span className="sr-only">{t('preferences.general.loading')}</span>
            </div>
          )}>
            <DshInstallDialogContent />
          </Suspense>
        </DialogContent>
      </Dialog>
    </div>
  );
}
