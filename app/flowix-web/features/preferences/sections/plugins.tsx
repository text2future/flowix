'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, FolderOpen, Power, RefreshCw, ShieldCheck, ShieldQuestion, Trash2 } from 'lucide-react';
import { dialogs, plugins, type PluginDescriptor, type PluginDiagnostic } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { SectionHeader } from './primitives';

export function PluginsSection() {
  const [items, setItems] = useState<PluginDescriptor[]>([]);
  const [diagnostics, setDiagnostics] = useState<PluginDiagnostic[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const snapshot = await plugins.catalog();
      setItems(snapshot.plugins);
      setDiagnostics(snapshot.diagnostics);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const install = async () => {
    const source = await dialogs.selectDirectory();
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const candidate = await plugins.validate(source);
      const capabilitySummary = candidate.permissions.length > 0
        ? `\n\n宿主能力：${candidate.permissions.join('、')}`
        : '';
      if (!window.confirm(`安装或升级插件“${candidate.manifest.name}”吗？${capabilitySummary}`)) return;
      await plugins.install(source);
      await load();
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (plugin: PluginDescriptor) => {
    setBusy(true);
    setError(null);
    try {
      await plugins.setEnabled(plugin.manifest.id, !plugin.enabled);
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (plugin: PluginDescriptor) => {
    if (plugin.isSystem || !window.confirm(`确定卸载插件“${plugin.manifest.name}”吗？`)) return;
    setBusy(true);
    setError(null);
    try {
      await plugins.uninstall(plugin.manifest.id);
      await load();
    } catch (uninstallError) {
      setError(uninstallError instanceof Error ? uninstallError.message : String(uninstallError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="插件"
        description="插件安装在 ~/.flowix/plugin/，安装后对全部笔记本可用。"
      />
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void install()}>
          <FolderOpen className="mr-1.5 h-4 w-4" />安装或升级插件
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-4 w-4" />刷新
        </Button>
      </div>
      {error && <p className="rounded-md bg-red-500/10 p-3 text-xs text-red-600">{error}</p>}
      <div className="space-y-2">
        {items.map((plugin) => (
          <div key={plugin.manifest.id} className="flex items-center justify-between rounded-lg border border-[var(--divider)] bg-[var(--card)] p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
                <span className="truncate">{plugin.manifest.name}</span>
                {plugin.isSystem && <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">内置</span>}
                {!plugin.enabled && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700">已停用</span>}
                {plugin.integrityStatus === 'verified'
                  ? <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700" title="安装包文件与插件声明的 SHA-256 完整性清单一致"><ShieldCheck className="h-3 w-3" />完整性通过</span>
                  : <span className="flex items-center gap-1 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]" title="插件未提供完整性清单"><ShieldQuestion className="h-3 w-3" />未校验</span>}
              </div>
              <p className="mt-1 truncate text-xs text-[var(--muted-foreground)]">{plugin.manifest.id} · v{plugin.manifest.version}</p>
              <p className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]">能力：{plugin.permissions.join('、')}</p>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" disabled={busy || (plugin.isSystem && plugin.enabled)} onClick={() => void setEnabled(plugin)} title={plugin.enabled ? '停用插件' : '启用插件'}>
                <Power className={`h-4 w-4 ${plugin.enabled ? 'text-emerald-500' : 'text-[var(--muted-foreground)]'}`} />
              </Button>
              {!plugin.isSystem && <Button variant="ghost" size="icon" disabled={busy} onClick={() => void uninstall(plugin)} title="卸载插件"><Trash2 className="h-4 w-4 text-red-500" /></Button>}
            </div>
          </div>
        ))}
      </div>
      {diagnostics.some((item) => item.status === 'invalid') && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium text-amber-600"><AlertTriangle className="h-4 w-4" />加载失败</h3>
          {diagnostics.filter((item) => item.status === 'invalid').map((item) => (
            <div key={item.path} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="truncate text-xs text-[var(--foreground)]">{item.path}</p>
              <p className="mt-1 text-xs text-amber-700">{item.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
