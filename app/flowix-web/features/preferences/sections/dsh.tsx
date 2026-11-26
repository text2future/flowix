'use client';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  Check,
  Database,
  Loader2,
  PanelsTopLeft,
  Puzzle,
  Settings2,
  ShieldCheck,
  Tag,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { AgentIcon } from '@features/agent/public/icon-api';
import { DEEPSEEK_HARNESS_MODE_OPTIONS } from '@features/agent/runtime/agent-runtime-spec';
import { deepseekHarness } from '@platform/tauri/client';
import type { DeepSeekHarnessPlugin, DeepSeekHarnessPluginCatalog } from '@platform/tauri/client';
import { dshIntegration, type DshIntegrationStatus } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { Button } from '@shared/ui/button';
import { SettingsTabGroup } from '@features/preferences/components/settings-tab-group';
import { openUrl } from '@platform/tauri/opener';

type DshTab = 'models' | 'general' | 'plugins' | 'presets';

const AgentSection = lazy(() =>
  import('@features/preferences/sections/agent').then((module) => ({ default: module.AgentSection })),
);

const DSH_TABS: readonly {
  id: DshTab;
  labelKey: I18nKey;
  icon: LucideIcon;
}[] = [
  { id: 'general', labelKey: 'preferences.dsh.tabs.general', icon: Settings2 },
  { id: 'models', labelKey: 'preferences.dsh.tabs.models', icon: Database },
  { id: 'plugins', labelKey: 'preferences.dsh.tabs.plugins', icon: Puzzle },
  { id: 'presets', labelKey: 'preferences.dsh.tabs.presets', icon: PanelsTopLeft },
];

const DSH_PRESETS = DEEPSEEK_HARNESS_MODE_OPTIONS.map(({ id, labelKey, descriptionKey }) => ({
  id,
  titleKey: labelKey,
  descriptionKey,
}));

const PRESET_TITLE_KEYS: Record<string, I18nKey> = {
  standard: 'preferences.dsh.plugins.presetStandard',
  code: 'preferences.dsh.plugins.presetPtc',
  minimal: 'preferences.dsh.plugins.presetMinimal',
  cordis: 'preferences.dsh.plugins.presetCreative',
};

export function DshSettingsSection() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DshTab>('general');
  const [status, setStatus] = useState<DshIntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatusError(null);
    try {
      setStatus(await dshIntegration.status());
    } catch (value) {
      setStatusError(friendlyErrorMessage(value, t, 'errors.friendly.dshLoad'));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    return subscribe('dsh-runtime-status-changed', () => {
      void refreshStatus();
    });
  }, [refreshStatus]);

  if (status === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <SectionHeader
          title={t('preferences.dsh.title')}
          description={t('preferences.dsh.description')}
        />
        <div className="flex flex-1 items-center justify-center px-8 py-12 text-center">
          <div className="space-y-3">
            {!statusError && (
              <Loader2 className="mx-auto h-7 w-7 flowix-spin text-[var(--primary)]" />
            )}
            <p className="text-sm text-[var(--muted-foreground)]">
              {statusError ?? t('preferences.dsh.setup.loading')}
            </p>
            {statusError && (
              <Button type="button" size="sm" variant="outline" onClick={() => void refreshStatus()}>
                {t('preferences.dsh.setup.retry')}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!status.installed || !status.appServerProfileInstalled) {
    return (
      <div className="flex min-h-[min(560px,calc(100vh-220px))] flex-col">
        <DshSetupPage status={status} onStatusChanged={setStatus} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-5">
      <SectionHeader
        title={t('preferences.dsh.title')}
        description={t('preferences.dsh.description')}
      />

      <SettingsTabGroup
        tabs={DSH_TABS.map(({ id, labelKey, icon: Icon }) => ({
          id,
          label: t(labelKey),
          icon: <Icon className="h-3.5 w-3.5 shrink-0" />,
        }))}
        activeTab={activeTab}
        onActiveTabChange={(id) => setActiveTab(id as DshTab)}
        ariaLabel={t('preferences.dsh.title')}
        listClassName="grid grid-cols-4 gap-1 rounded-lg border border-[var(--divider)] bg-[var(--muted)]/40 p-1"
        tabClassName="flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        activeTabClassName="bg-[var(--card)] font-medium text-[var(--primary)] shadow-sm"
        inactiveTabClassName="text-[var(--muted-foreground)] hover:bg-[var(--card)]/70 hover:text-[var(--foreground)]"
      >
        {activeTab === 'models' && (
          <Suspense fallback={(
            <div className="flex flex-1 items-center justify-center" role="status" aria-busy="true">
              <Loader2 className="size-6 flowix-spin text-[var(--muted-foreground)]" />
              <span className="sr-only">{t('preferences.general.loading')}</span>
            </div>
          )}>
            <AgentSection
              configStore={deepseekHarness}
              configChangeKind="dsh_config"
              testConnection={deepseekHarness.testConnection}
              modelDirectory={deepseekHarness}
              hideSectionDivider
            />
          </Suspense>
        )}
        {activeTab === 'general' && <GeneralTab status={status} />}
        {activeTab === 'plugins' && <PluginsTab />}
        {activeTab === 'presets' && <PresetsTab />}
      </SettingsTabGroup>
    </div>
  );
}

function DshSetupPage({
  status,
  onStatusChanged,
}: {
  status: DshIntegrationStatus;
  onStatusChanged: (status: DshIntegrationStatus) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectingPath, setSelectingPath] = useState(false);
  const [checkingPath, setCheckingPath] = useState(false);

  const installAppServer = async () => {
    setBusy(true);
    setError(null);
    try {
      onStatusChanged(await dshIntegration.installAppServerProfile());
      toast.success(t('preferences.dsh.appServer.installSuccess'));
    } catch (value) {
      setError(friendlyErrorMessage(value, t, 'errors.friendly.dshInstall'));
    } finally {
      setBusy(false);
    }
  };

  const openOfficialInstall = async () => {
    setError(null);
    try {
      await openUrl('https://github.com/deepseek-ai/deepseek-harness');
    } catch (value) {
      setError(friendlyErrorMessage(value, t, 'errors.friendly.linkOpen'));
    }
  };

  const selectCliPath = async () => {
    setSelectingPath(true);
    setError(null);
    try {
      const path = await dshIntegration.selectCliPath();
      if (!path) return;
      onStatusChanged(await dshIntegration.setCliPath(path));
      toast.success(t('preferences.agents.external.pathSaved'));
    } catch (value) {
      setError(friendlyErrorMessage(value, t, 'errors.friendly.pathSave'));
    } finally {
      setSelectingPath(false);
    }
  };

  const checkCliPath = async () => {
    setCheckingPath(true);
    setError(null);
    try {
      const next = await dshIntegration.status();
      onStatusChanged(next);
      if (next.installed && next.executablePath) {
        toast.success(t('preferences.agents.external.checkSuccess'));
      } else {
        toast.error(t('preferences.agents.external.checkNotFound'));
      }
    } catch (value) {
      setError(friendlyErrorMessage(value, t, 'errors.friendly.dshLoad'));
    } finally {
      setCheckingPath(false);
    }
  };

  return (
    <div className="flex flex-1 items-start justify-center px-1 py-2">
      <div className="flex min-h-[360px] w-full max-w-xl flex-col p-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
          <AgentIcon typeKey="dsh" alt="" className="h-8 w-8" />
        </div>
        <h3 className="mt-5 text-lg font-semibold text-[var(--foreground)]">
          {t('preferences.dsh.setup.title')}
        </h3>
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
          {status.installed
            ? status.appServerProfileUpdateAvailable
              ? t('preferences.dsh.appServer.updateDescription')
              : status.appServerProfileInstalled
                ? t('preferences.dsh.appServer.missingDescription')
                : status.source === 'local-cli'
                  ? t('preferences.dsh.appServer.localDetected', { version: status.version ?? '—' })
                  : t('preferences.dsh.appServer.managedRuntime', { version: status.harnessVersion ?? status.version ?? '—' })
            : t('preferences.dsh.appServer.runtimeMissingDescription')}
        </p>
        <div className="mt-4 w-full space-y-2 text-left">
          <div className="flex min-w-0 items-center gap-2">
            <Input
              value={status.executablePath ?? ''}
              placeholder={t('preferences.agents.external.notConfigured')}
              spellCheck={false}
              readOnly
              disabled
              title={status.executablePath ?? ''}
              className="min-w-0 flex-1 text-ellipsis"
            />
            <Button
              type="button"
              variant="outline"
              title={t('preferences.agents.external.selectHint')}
              disabled={selectingPath}
              onClick={() => void selectCliPath()}
            >
              {selectingPath ? <Loader2 className="h-4 w-4 flowix-spin" /> : t('preferences.agents.external.select')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={checkingPath}
              onClick={() => void checkCliPath()}
            >
              {checkingPath ? <Loader2 className="h-4 w-4 flowix-spin" /> : t('preferences.agents.external.check')}
            </Button>
          </div>
        </div>
        <div className="mt-auto flex flex-wrap justify-center gap-2 pt-8">
          {!status.installed ? (
            <Button type="button" onClick={() => void openOfficialInstall()}>
              {t('preferences.dsh.appServer.openOfficialInstall')}
            </Button>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Button type="button" onClick={() => void installAppServer()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 flowix-spin" />}
                {busy
                  ? t('preferences.dsh.appServer.installing')
                  : status.appServerProfileUpdateAvailable
                    ? t('preferences.dsh.appServer.update')
                    : t('preferences.dsh.appServer.install')}
              </Button>
              <p className="text-xs text-[var(--muted-foreground)]">
                {t('preferences.dsh.appServer.installNote')}
              </p>
            </div>
          )}
        </div>
        {error && <p className="mt-4 text-xs text-[var(--destructive)]">{error}</p>}
      </div>
    </div>
  );
}

export function DshInstallDialogContent() {
  const { t } = useI18n();
  const [status, setStatus] = useState<DshIntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatusError(null);
    try {
      setStatus(await dshIntegration.status());
    } catch (value) {
      setStatusError(friendlyErrorMessage(value, t, 'errors.friendly.dshLoad'));
    }
  }, [t]);

  useEffect(() => {
    void refreshStatus();
    return subscribe('dsh-runtime-status-changed', () => {
      void refreshStatus();
    });
  }, [refreshStatus]);

  if (status === null) {
    return (
      <div className="flex min-h-[280px] items-center justify-center px-8 py-12 text-center">
        <div className="space-y-3">
          {!statusError && <Loader2 className="mx-auto h-7 w-7 flowix-spin text-[var(--primary)]" />}
          <p role={statusError ? 'alert' : 'status'} className="text-sm text-[var(--muted-foreground)]">
            {statusError ?? t('preferences.dsh.setup.loading')}
          </p>
          {statusError && (
            <Button type="button" size="sm" variant="outline" onClick={() => void refreshStatus()}>
              {t('preferences.dsh.setup.retry')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (status.installed && status.appServerProfileInstalled && !status.appServerProfileUpdateAvailable) {
    return (
      <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 px-8 py-12 text-center">
        <Check className="size-8 text-[var(--success)]" aria-hidden="true" />
        <p role="status" className="text-sm text-[var(--foreground)]">
          {t('preferences.dsh.appServer.installSuccess')}
        </p>
      </div>
    );
  }

  return <DshSetupPage status={status} onStatusChanged={setStatus} />;
}


function GeneralTab({ status }: { status: DshIntegrationStatus }) {
  const { t } = useI18n();
  const rows = [
    {
      icon: Tag,
      title: t('preferences.dsh.general.harnessVersion'),
      value: status.harnessVersion ?? status.version ?? 'unknown',
    },
    {
      icon: Database,
      title: t('preferences.dsh.general.provider'),
      value: t('preferences.dsh.general.providerValue'),
    },
    {
      icon: ShieldCheck,
      title: t('preferences.dsh.general.permission'),
      value: t('preferences.dsh.general.permissionValue'),
    },
    {
      icon: PanelsTopLeft,
      title: t('preferences.dsh.general.sessions'),
      value: t('preferences.dsh.general.sessionsValue'),
    },
  ] as const;

  return (
    <div className="space-y-2 pb-[30px]">
      <SectionHeader
        title={t('preferences.dsh.general.title')}
        className="flex h-8 items-center border-b-0 pb-0"
      />
      <div className="rounded-lg border border-[var(--divider)] bg-[var(--card)] py-2">
        {rows.map(({ icon: Icon, title, value }) => (
          <div key={title} className="flex items-center gap-3 px-3.5 py-2">
            <Icon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            <span className="min-w-0 flex-1 text-sm text-[var(--foreground)]">{title}</span>
            <span className="text-right text-sm text-[var(--muted-foreground)]">{value}</span>
          </div>
        ))}
      </div>
      <div className="space-y-2 rounded-lg border border-[var(--divider)] bg-[var(--card)] px-3.5 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-[var(--foreground)]">{t('preferences.dsh.runtime.version')}</p>
            {status.source === 'local-cli' && (
              <p className="mt-1 truncate text-sm text-[var(--muted-foreground)]">
                {t('preferences.dsh.appServer.localRuntime', { path: status.executablePath ?? '' })}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function PluginsTab() {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<DeepSeekHarnessPluginCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [managingPlugin, setManagingPlugin] = useState<string | null>(null);
  const [pluginFilter, setPluginFilter] = useState<'configurable' | 'all'>('configurable');
  const normalizedQuery = query.trim().toLowerCase();

  const loadCatalog = useCallback(() => {
    let cancelled = false;
    void deepseekHarness.pluginCatalog().then((nextCatalog) => {
      if (!cancelled) {
        setCatalog(nextCatalog);
        setLoadError(null);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(friendlyErrorMessage(error, t, 'errors.friendly.pluginLoad'));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return loadCatalog();
  }, [loadCatalog]);

  const manageProfilePlugin = useCallback(async (action: 'remove', target?: string) => {
    const spec = target ?? '';
    if (!spec) return;
    setManagingPlugin(`${action}:${spec}`);
    try {
      await deepseekHarness.manageProfilePlugin(action, spec || undefined);
      loadCatalog();
      toast.success(t('preferences.dsh.plugins.manageSuccess'));
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.pluginInstall'));
    } finally {
      setManagingPlugin(null);
    }
  }, [loadCatalog, t]);

  const togglePlugin = async (plugin: DeepSeekHarnessPlugin) => {
    if (!plugin.toggleable || togglingKey !== null) return;
    setTogglingKey(plugin.key);
    try {
      setCatalog(await deepseekHarness.setPluginEnabled(plugin.key, !plugin.enabled));
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.pluginRemove'));
    } finally {
      setTogglingKey(null);
    }
  };

  const groups: readonly { key: string; title: string; plugins: DeepSeekHarnessPlugin[] }[] = catalog === null
    ? []
    : [
        { key: 'profile', title: t('preferences.dsh.plugins.profile'), plugins: catalog.profile ?? [] },
        { key: 'host', title: t('preferences.dsh.plugins.host'), plugins: catalog.host ?? [] },
        ...Object.entries(catalog.presets ?? {}).map(([preset, plugins]) => ({
          key: `preset:${preset}`,
          title: t(PRESET_TITLE_KEYS[preset] ?? 'preferences.dsh.plugins.preset'),
          plugins,
        })),
      ];

  return (
    <div className="space-y-2">
      {/* 标题与搜索框同行并水平对齐 */}
      <div className="flex h-8 items-center gap-3">
        <SectionHeader
          title={t('preferences.dsh.plugins.title')}
          className="flex min-w-0 flex-1 items-center border-b-0 pb-0"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('preferences.dsh.plugins.searchPlaceholder')}
          className="h-8 min-w-0 flex-1"
        />
        <Select value={pluginFilter} onValueChange={(value) => {
          if (value === 'configurable' || value === 'all') setPluginFilter(value);
        }}>
          <SelectTrigger className="h-8 w-32 shrink-0 bg-transparent">
            <SelectValue>
              {t(pluginFilter === 'configurable'
                ? 'preferences.dsh.plugins.filterConfigurable'
                : 'preferences.dsh.plugins.filterAll')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="flowix-preferences-select-content">
            <SelectItem value="configurable">{t('preferences.dsh.plugins.filterConfigurable')}</SelectItem>
            <SelectItem value="all">{t('preferences.dsh.plugins.filterAll')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {/* WKWebView 下外层滚动容器吃不到底部间距, 在列表自身留 pb-10 兜底 */}
      <div className="space-y-2 pb-10">
        {loadError && <p className="rounded-lg border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[color-mix(in_oklch,var(--destructive)_5%,transparent)] px-3.5 py-3 text-xs text-[var(--destructive)]">{loadError}</p>}
        {catalog === null && loadError === null && (
          <div className="flex h-[100px] items-center justify-center text-center text-xs text-[var(--muted-foreground)]">
            {t('preferences.dsh.plugins.loading')}
          </div>
        )}
        {groups.map(({ key, title, plugins }) => {
          const visiblePlugins = plugins.filter(({ id, name, toggleable }) =>
            id !== '@deepseek-ai/dsh-base'
            && (pluginFilter === 'all' || toggleable)
            && `${id} ${name}`.toLowerCase().includes(normalizedQuery),
          );
          if (visiblePlugins.length === 0) return null;
          return (
            <div key={key} className="space-y-2">
              <h4 className="pt-2 text-xs font-medium text-[var(--muted-foreground)]">{title}</h4>
              {visiblePlugins.map((plugin) => (
                <div
                  key={`${key}:${plugin.key}`}
                  className="flex items-start gap-3 rounded-lg border border-[var(--divider)] bg-[var(--card)] px-3.5 py-3"
                >
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
                    <Puzzle className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="truncate text-sm font-medium text-[var(--foreground)]">{plugin.id}</h4>
                      <div className="inline-flex shrink-0 items-center gap-2">
                        <Check className={cn('h-3 w-3', plugin.enabled ? 'text-[var(--success)]' : 'text-[var(--muted-foreground)]')} />
                        <span className="text-[11px] text-[var(--muted-foreground)]">
                          {t(plugin.enabled ? 'preferences.dsh.plugins.enabled' : 'preferences.dsh.plugins.disabled')}
                        </span>
                        {plugin.scope === 'profile'
                          && plugin.removable !== false
                          && plugin.id !== '@deepseek-ai/dsh-base'
                          && plugin.id !== 'dsh-flowix-memory' && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={managingPlugin !== null}
                            onClick={() => void manageProfilePlugin('remove', plugin.id)}
                          >
                            {t('preferences.dsh.plugins.remove')}
                          </Button>
                        )}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={plugin.enabled}
                          aria-label={`${t('preferences.dsh.plugins.toggle')}: ${plugin.id}`}
                          title={plugin.toggleable ? t('preferences.dsh.plugins.toggle') : t('preferences.dsh.plugins.protected')}
                          disabled={!plugin.toggleable || togglingKey !== null || plugin.scope === 'profile'}
                          onClick={() => void togglePlugin(plugin)}
                          className={cn(
                            'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                            plugin.enabled ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]',
                          )}
                        >
                          <span
                            className={cn(
                              'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--card)] shadow-sm transition-transform',
                              plugin.enabled ? 'translate-x-4' : 'translate-x-0',
                            )}
                          />
                        </button>
                      </div>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">{plugin.name}</p>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PresetsTab() {
  const { t } = useI18n();

  return (
    <div className="space-y-2">
      <SectionHeader
        title={t('preferences.dsh.presets.title')}
        className="flex h-8 items-center border-b-0 pb-0"
      />
      <div className="space-y-2">
        {DSH_PRESETS.map(({ id, titleKey, descriptionKey }) => (
          <div
            key={id}
            className="rounded-lg border border-[var(--divider)] bg-[var(--card)] px-3.5 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
                <PanelsTopLeft className="h-3 w-3" />
              </span>
              <h4 className="text-sm font-medium text-[var(--foreground)]">{t(titleKey)}</h4>
              <span className="ml-auto rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                {id}
              </span>
            </div>
            <p className="mt-1.5 pl-7 text-xs leading-5 text-[var(--muted-foreground)]">
              {t(descriptionKey)}
            </p>
          </div>
        ))}
      </div>
      <p className="pb-10 text-xs text-[var(--muted-foreground)]">
        {t('preferences.dsh.presets.hint')}
      </p>
    </div>
  );
}
