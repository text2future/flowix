'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { useCliLinkStatusStore } from '@features/preferences/store';
import { useI18n } from '@features/i18n';
import { Button } from '@shared/ui/button';
import { toast } from '@/lib/toast';

interface McpSnippet {
  id: string;
  title: string;
  content: string;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildMcpConfigSnippets(command: string, genericTitle: string): McpSnippet[] {
  const sharedServer = {
    command,
    args: ['mcp'],
  };

  return [
    {
      id: 'generic',
      title: genericTitle,
      content: JSON.stringify({ transport: 'stdio', ...sharedServer }, null, 2),
    },
    {
      id: 'json',
      title: 'Claude Desktop / Cursor',
      content: JSON.stringify({ mcpServers: { flowix: sharedServer } }, null, 2),
    },
    {
      id: 'codex',
      title: 'Codex',
      content: `[mcp_servers.flowix]\ncommand = "${escapeTomlString(command)}"\nargs = ["mcp"]`,
    },
    {
      id: 'claude-code',
      title: 'Claude Code',
      content: JSON.stringify(
        { mcpServers: { flowix: { type: 'stdio', ...sharedServer } } },
        null,
        2,
      ),
    },
  ];
}

function CopyButton({ value, label, copiedLabel, failedLabel }: {
  value: string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(copiedLabel);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error(failedLabel);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 w-6 p-0"
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      onClick={() => void copy()}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

export function McpSection() {
  const { t } = useI18n();
  const status = useCliLinkStatusStore((s) => s.status);
  const refreshIfStale = useCliLinkStatusStore((s) => s.refreshIfStale);

  useEffect(() => {
    void refreshIfStale();
  }, [refreshIfStale]);

  const command = status?.commandPath || 'flowix';
  const snippets = useMemo(
    () => buildMcpConfigSnippets(command, t('preferences.mcp.generic')),
    [command, t],
  );

  return (
    <div className="space-y-5 pb-6">
      <SectionHeader title={t('preferences.mcp.title')} />

      <div className="space-y-6">
        {snippets.map((snippet) => (
          <div key={snippet.id} className="overflow-hidden rounded-md border border-[var(--border)]">
            <div className="flex h-10 items-center justify-between gap-3 border-b border-[var(--divider)] px-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--foreground)]">{snippet.title}</div>
              </div>
              <CopyButton
                value={snippet.content}
                label={t('preferences.mcp.copy')}
                copiedLabel={t('preferences.mcp.copied')}
                failedLabel={t('preferences.mcp.copyFailed')}
              />
            </div>
            <pre className="whitespace-pre-wrap break-words px-3 py-2.5 text-xs leading-5 text-[var(--foreground)] select-text [overflow-wrap:anywhere]">
              <code>{snippet.content}</code>
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
