'use client';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { PencilSimpleIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { piMcp, type PiMcpServerConfig } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { Field, FIELD_INPUT_CLASS, SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { FlowixCheckbox } from '@shared/ui/flowix-checkbox';

type Transport = 'stdio' | 'http';
type Draft = {
  name: string;
  transport: Transport;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  description: string;
  exposure: string;
  enabled: boolean;
  original: Record<string, unknown>;
};

function draftFrom(server?: PiMcpServerConfig): Draft {
  const config = server?.config ?? {};
  const transport: Transport = typeof config.url === 'string' ? 'http' : 'stdio';
  const env = config.env && typeof config.env === 'object' && !Array.isArray(config.env)
    ? config.env
    : {};
  return {
    name: server?.name ?? '', transport,
    command: typeof config.command === 'string' ? config.command : '',
    args: Array.isArray(config.args) ? config.args.join('\n') : '',
    env: Object.keys(env).length > 0 ? JSON.stringify(env, null, 2) : '',
    cwd: typeof config.cwd === 'string' ? config.cwd : '',
    url: typeof config.url === 'string' ? config.url : '',
    headers: JSON.stringify(config.headers ?? {}, null, 2),
    description: typeof config.description === 'string' ? config.description : '',
    exposure: typeof config.exposure === 'string' ? config.exposure : 'codemode',
    enabled: config.enabled !== false,
    original: { ...config },
  };
}

class McpInputError extends Error {}

function parseStringMap(source: string, message: string): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(source || '{}'); } catch { throw new McpInputError(message); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Object.entries(parsed).every(([key, value]) => Boolean(key) && typeof value === 'string')) {
    throw new McpInputError(message);
  }
  return parsed as Record<string, string>;
}

export function PiMcpSettings() {
  const { t } = useI18n();
  const [servers, setServers] = useState<PiMcpServerConfig[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try { setServers(await piMcp.list()); }
    catch (value) { setError(friendlyErrorMessage(value, t, 'errors.friendly.mcpLoad')); }
    finally { setLoading(false); }
  }, [t]);

  useEffect(() => { void reload(); }, [reload]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    const name = draft.name.trim();
    const config: Record<string, unknown> = { ...draft.original, enabled: draft.enabled, exposure: draft.exposure };
    try {
      config.description = draft.description.trim() || undefined;
      if (draft.transport === 'stdio') {
        if (!draft.command.trim()) throw new McpInputError(t('preferences.pi.mcp.commandRequired'));
        delete config.url; delete config.headers; delete config.oauth; delete config.type;
        config.command = draft.command.trim();
        config.args = draft.args.split('\n').map((arg) => arg.trim()).filter(Boolean);
        config.env = parseStringMap(draft.env, t('errors.friendly.mcpMap', { label: t('preferences.pi.mcp.env') }));
        if (draft.cwd.trim()) config.cwd = draft.cwd.trim(); else delete config.cwd;
      } else {
        if (!draft.url.trim()) throw new McpInputError(t('preferences.pi.mcp.urlRequired'));
        delete config.command; delete config.args; delete config.env; delete config.cwd;
        config.url = draft.url.trim();
        config.headers = parseStringMap(draft.headers, t('errors.friendly.mcpMap', { label: t('preferences.pi.mcp.headers') }));
        delete config.type;
      }
      if (!config.description) delete config.description;
      await piMcp.save(name, config);
      setDraft(null);
      await reload();
      toast.success(t('preferences.pi.mcp.saved'));
    } catch (value) {
      toast.error(value instanceof McpInputError ? value.message : friendlyErrorMessage(value, t, 'errors.friendly.mcpSave'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try { await piMcp.delete(name); await reload(); toast.success(t('preferences.pi.mcp.deleted')); }
    catch (value) { toast.error(friendlyErrorMessage(value, t, 'errors.friendly.mcpRemove')); }
    finally { setBusy(false); }
  };

  const fieldClass = `${FIELD_INPUT_CLASS} !bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]`;
  const form = draft && (
    <fieldset disabled={busy} className="m-0 min-w-0 space-y-3 rounded-xl border border-[var(--divider)] bg-[var(--card)] p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field title={t('preferences.pi.mcp.name')} controlId="pi-mcp-name">
          <Input id="pi-mcp-name" className={fieldClass} value={draft.name} disabled={Boolean(draft.original.command || draft.original.url)} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="filesystem" />
        </Field>
        <Field title={t('preferences.pi.mcp.transport')} controlId="pi-mcp-transport">
          <Select value={draft.transport} onValueChange={(transport) => setDraft({ ...draft, transport: transport as Transport })}>
            <SelectTrigger id="pi-mcp-transport" className={fieldClass}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="stdio">stdio</SelectItem><SelectItem value="http">Streamable HTTP</SelectItem></SelectContent>
          </Select>
        </Field>
      </div>
      {draft.transport === 'stdio' ? <>
        <Field title={t('preferences.pi.mcp.command')} controlId="pi-mcp-command"><Input id="pi-mcp-command" className={fieldClass} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></Field>
        <Field title={t('preferences.pi.mcp.args')} controlId="pi-mcp-args" description={t('preferences.pi.mcp.argsHint')}><textarea id="pi-mcp-args" className={`${fieldClass} min-h-20 w-full resize-y rounded-md p-2 font-mono text-xs`} value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'} /></Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field title={t('preferences.pi.mcp.env')} controlId="pi-mcp-env"><textarea id="pi-mcp-env" className={`${fieldClass} min-h-20 w-full resize-y rounded-md p-2 font-mono text-xs`} value={draft.env} onChange={(event) => setDraft({ ...draft, env: event.target.value })} placeholder={t('preferences.pi.mcp.envHint')} /></Field>
          <Field title={t('preferences.pi.mcp.cwd')} controlId="pi-mcp-cwd"><Input id="pi-mcp-cwd" className={fieldClass} value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="/path/to/project" /></Field>
        </div>
      </> : <>
        <Field title={t('preferences.pi.mcp.url')} controlId="pi-mcp-url"><Input id="pi-mcp-url" className={fieldClass} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></Field>
        <Field title={t('preferences.pi.mcp.headers')} controlId="pi-mcp-headers" description={t('preferences.pi.mcp.headersHint')}><textarea id="pi-mcp-headers" className={`${fieldClass} min-h-20 w-full resize-y rounded-md p-2 font-mono text-xs`} value={draft.headers} onChange={(event) => setDraft({ ...draft, headers: event.target.value })} /></Field>
      </>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field title={t('preferences.pi.mcp.exposure')} controlId="pi-mcp-exposure">
          <Select value={draft.exposure} onValueChange={(exposure) => setDraft({ ...draft, exposure })}>
            <SelectTrigger id="pi-mcp-exposure" className={fieldClass}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="codemode">codemode</SelectItem><SelectItem value="deferred">deferred</SelectItem><SelectItem value="direct">direct</SelectItem><SelectItem value="hidden">hidden</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field title={t('preferences.pi.mcp.serverDescription')} controlId="pi-mcp-server-description"><Input id="pi-mcp-server-description" className={fieldClass} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
      </div>
      <div className="flex items-center gap-2 text-sm text-[var(--foreground)]"><FlowixCheckbox checked={draft.enabled} disabled={busy} aria-label={t('preferences.pi.mcp.enabled')} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} /><span className={busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} onClick={() => { if (!busy) setDraft({ ...draft, enabled: !draft.enabled }); }}>{t('preferences.pi.mcp.enabled')}</span></div>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" className="h-8" onClick={() => setDraft(null)}>{t('preferences.pi.cancel')}</Button><Button type="button" className="h-8" disabled={busy} onClick={() => void save()}>{t('preferences.pi.save')}</Button></div>
    </fieldset>
  );

  return (
    <section className="space-y-3">
      <SectionHeader title={t('preferences.pi.mcp.title')} description={t('preferences.pi.mcp.description')} />
      <div className="flex justify-end">
        <Button type="button" variant="outline" className="h-8 shrink-0 gap-1" disabled={busy || Boolean(draft)} onClick={() => setDraft(draftFrom())}><Plus className="size-3.5" />{t('preferences.pi.mcp.add')}</Button>
      </div>
      {error && <p role="alert" className="text-sm text-[var(--destructive)]">{error}</p>}
      {loading && <div className="flex justify-center py-5"><Loader2 className="size-5 flowix-spin" /></div>}
      {!loading && !error && servers.length === 0 && !draft && <div className="py-3 text-center text-sm text-[var(--muted-foreground)]">{t('preferences.pi.mcp.empty')}</div>}
      <div className="space-y-2">
        {servers.map((server) => <article key={server.name} className="flex items-center gap-2 rounded-xl border border-[var(--divider)] bg-[var(--card)] p-3">
          <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[var(--foreground)]">{server.name}</div><div className="truncate text-xs text-[var(--muted-foreground)]">{typeof server.config.command === 'string' ? [server.config.command, ...(Array.isArray(server.config.args) ? server.config.args as string[] : [])].join(' ') : String(server.config.url ?? '')}</div></div>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('preferences.pi.mcp.edit')} title={t('preferences.pi.mcp.edit')} disabled={busy || Boolean(draft)} onClick={() => setDraft(draftFrom(server))}><PencilSimpleIcon className="size-4" /></Button>
          <Button type="button" variant="ghost" size="icon" className="size-7 hover:text-[var(--destructive)]" aria-label={t('preferences.pi.mcp.delete')} title={t('preferences.pi.mcp.delete')} disabled={busy || Boolean(draft)} onClick={() => void remove(server.name)}><TrashSimpleIcon className="size-4" /></Button>
        </article>)}
      </div>
      {draft && form}
    </section>
  );
}
