'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { useCliLinkStatusStore } from '@features/preferences/store';
import { useI18n } from '@/lib/i18n';
import { Button } from '@shared/ui/button';
import { toast } from '@/lib/toast';
import workbuddyIcon from '@/assets/agent-icons/workbuddy.svg';
import chatgptIcon from '@/assets/agent-icons/chatgpt.svg';
import claudeIcon from '@/assets/agent-icons/claude.svg';
import deepseekIcon from '@/assets/agent-icons/deepseek.svg';
import piIcon from '@/assets/agent-icons/pi.svg';
import hermesIcon from '@/assets/agent-icons/hermes.svg';
import openclawIcon from '@/assets/agent-icons/openclaw.svg';

const SUPPORTED_AGENTS = [
  { name: 'WorkBuddy', icon: workbuddyIcon },
  { name: 'ChatGPT', icon: chatgptIcon },
  { name: 'Claude', icon: claudeIcon },
  { name: 'DeepSeek', icon: deepseekIcon },
  { name: 'Pi', icon: piIcon },
  { name: 'Hermes', icon: hermesIcon },
  { name: 'OpenClaw', icon: openclawIcon },
] as const;

interface McpSnippet {
  id: string;
  title: string;
  content: string;
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
      content: JSON.stringify({ mcpServers: { flowix: sharedServer } }, null, 2),
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
    <div className="space-y-5">
      <SectionHeader title={t('preferences.mcp.title')} />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--muted-foreground)]">
          <span>{t('preferences.mcp.supportedAgents')}</span>
          <div className="flex items-center gap-2" aria-label={t('preferences.mcp.supportedAgents')}>
            {SUPPORTED_AGENTS.map((agent) => (
              <span
                key={agent.name}
                role="img"
                aria-label={agent.name}
                title={agent.name}
                data-agent-icon={agent.name === 'ChatGPT' || agent.name === 'Hermes' ? agent.name.toLowerCase() : undefined}
                className="mcp-supported-agent-icon"
              >
                <img src={agent.icon} alt="" className="mcp-supported-agent-icon__image" />
                {(agent.name === 'ChatGPT' || agent.name === 'Hermes') && (
                  <span
                    aria-hidden="true"
                    className="mcp-supported-agent-icon__mask"
                    style={{ maskImage: `url("${agent.icon}")`, WebkitMaskImage: `url("${agent.icon}")` }}
                  />
                )}
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-3">
          <div className="text-sm font-medium text-[var(--foreground)]">
            {t('preferences.mcp.setupTitle')}
          </div>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-5 text-[var(--muted-foreground)]">
            <li>{t('preferences.mcp.setupStep1')}</li>
            <li>{t('preferences.mcp.setupStep2')}</li>
          </ol>
        </div>

        {snippets.map((snippet) => (
          <div key={snippet.id} className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card)]">
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
