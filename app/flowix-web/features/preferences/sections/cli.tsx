'use client';

import { useEffect, useState } from 'react';
import { Check, Download, Loader2 } from 'lucide-react';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n, type I18nKey } from '@features/i18n';
import { cli, type CliLinkStatus } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';

interface CliCommandItem {
  command: string;
  alias?: string;
  usage: string;
  descriptionKey: I18nKey;
}

const CLI_COMMANDS: CliCommandItem[] = [
  {
    command: 'notebooks',
    alias: 'nb',
    usage: 'flowix notebooks',
    descriptionKey: 'preferences.cli.commands.notebooks',
  },
  {
    command: 'list',
    alias: 'ls',
    usage: 'flowix list <notebook>',
    descriptionKey: 'preferences.cli.commands.list',
  },
  {
    command: 'show',
    alias: 's',
    usage: 'flowix show <id>',
    descriptionKey: 'preferences.cli.commands.show',
  },
  {
    command: 'create',
    alias: 'new, c',
    usage: 'echo "# title" | flowix create <notebook>',
    descriptionKey: 'preferences.cli.commands.create',
  },
  {
    command: 'delete',
    alias: 'rm',
    usage: 'flowix delete <id>',
    descriptionKey: 'preferences.cli.commands.delete',
  },
  {
    command: 'edit',
    alias: 'e',
    usage: 'flowix edit <id> --old <text> --new <text>',
    descriptionKey: 'preferences.cli.commands.edit',
  },
  {
    command: 'write',
    alias: 'w',
    usage: 'printf "# title\\nbody\\n" | flowix write <id>',
    descriptionKey: 'preferences.cli.commands.write',
  },
  {
    command: 'search',
    alias: 'q',
    usage: 'flowix search <query> --limit 20',
    descriptionKey: 'preferences.cli.commands.search',
  },
  {
    command: 'completion',
    usage: 'flowix completion <bash|zsh|fish>',
    descriptionKey: 'preferences.cli.commands.completion',
  },
];

export function CliSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<CliLinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await cli.linkStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  const handleInstall = async () => {
    setInstalling(true);
    setError(null);
    try {
      setStatus(await cli.installPath());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const statusText = loading
    ? t('preferences.cli.status.checking')
    : status?.needsInstall
      ? t('preferences.cli.status.needsInstall')
      : t('preferences.cli.status.ready');

  return (
    <div className="space-y-4 pb-6">
      <SectionHeader title={t('preferences.cli.title')} />
      <div className="space-y-2">
        <div className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-[var(--muted-foreground)]">
                {t('preferences.cli.binary')}
              </div>
              <code className="mt-1 block text-sm text-[var(--foreground)]">
                flowix
              </code>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
                {!loading && !status?.needsInstall && (
                  <Check className="size-3.5 text-[var(--success)]" />
                )}
                <span>{statusText}</span>
                {status?.binDir && (
                  <code className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[var(--foreground)]">
                    {status.binDir}
                  </code>
                )}
              </div>
              {error && (
                <p className="mt-1 text-xs text-[var(--destructive)]">
                  {error}
                </p>
              )}
              {status?.needsInstall && !error && (
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {t('preferences.cli.installHint')}
                </p>
              )}
            </div>
            {status?.needsInstall && (
              <Button
                className="px-3"
                onClick={handleInstall}
                disabled={installing}
              >
                {installing ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Download data-icon="inline-start" />
                )}
                {t('preferences.cli.install')}
              </Button>
            )}
          </div>
        </div>

        <div className="divide-y divide-[var(--divider)]">
          {CLI_COMMANDS.map((item) => (
            <div key={item.command} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm font-medium text-[var(--foreground)]">
                      {item.command}
                    </code>
                    {item.alias && (
                      <span className="text-xs text-[var(--muted-foreground)]">
                        {t('preferences.cli.alias')}: {item.alias}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                    {t(item.descriptionKey)}
                  </p>
                </div>
              </div>
              <code className="mt-2 block overflow-x-auto rounded-md bg-[var(--muted)] px-2.5 py-2 text-xs text-[var(--foreground)]">
                {item.usage}
              </code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
