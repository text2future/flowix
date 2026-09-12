'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowBendDownRightIcon } from '@phosphor-icons/react';
import { useI18n } from '@/lib/i18n';
import { agentClient } from '@features/agent/store/agent-client';
import {
  agent,
  listenToCodexApprovalRequests,
  type CodexApprovalRequest,
} from '@platform/tauri/client';

interface BackgroundTerminal {
  id: string;
  command: string;
  cwd?: string;
  status?: string;
}

function readTerminals(value: unknown): BackgroundTerminal[] {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const raw = Array.isArray(value) ? value : root.data ?? root.jobs ?? root.terminals ?? root.backgroundTerminals;
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      id: String(row.id ?? row.terminalId ?? index),
      command: String(row.command ?? row.cmd ?? row.process ?? row.label ?? '后台进程'),
      cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
      status: typeof row.status === 'string' ? row.status : undefined,
    };
  });
}

export function AgentBackgroundTerminals({ threadId, agentType, enabled, queuedMessages = [] }: { threadId: string | null; agentType: 'codex' | 'deepseek-harness'; enabled: boolean; queuedMessages?: string[] }) {
  const { t } = useI18n();
  const [terminals, setTerminals] = useState<BackgroundTerminal[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [approval, setApproval] = useState<CodexApprovalRequest | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  useEffect(() => {
    if (agentType !== 'codex') return;
    return listenToCodexApprovalRequests((request) => {
      setApproval((current) => current ?? request);
    });
  }, [agentType]);

  const respondToApproval = async (decision: 'accept' | 'decline') => {
    if (!approval) return;
    const request = approval;
    setApproval(null);
    setApprovalError(null);
    try {
      await agent.codexApprovalRespond(request.requestId, approvalResult(request, decision));
    } catch (error) {
      setApproval((current) => current ?? request);
      setApprovalError(error instanceof Error ? error.message : String(error));
      console.warn('[AgentBackgroundTerminals] Codex approval response failed:', error);
    }
  };

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      if (!threadId || !enabled) {
        setTerminals([]);
        return;
      }
      try {
        const result = agentType === 'codex'
          ? await agentClient.backgroundTerminals(threadId)
          : await agentClient.backgroundJobs(threadId);
        if (!disposed) {
          setTerminals(readTerminals(result));
          setFailed(false);
        }
      } catch {
        // An older Codex app-server may not implement this experimental API.
        if (!disposed) setFailed(true);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [agentType, enabled, threadId]);

  const countLabel = useMemo(() => t('agent.backgroundTerminals.count', { count: terminals.length }), [t, terminals.length]);
  if (!enabled || failed || (terminals.length === 0 && !approval && queuedMessages.length === 0)) return null;

  if (approval) {
    return (
      <div className="agent-background-terminals agent-background-terminals--approval" role="status" aria-live="assertive">
        <div className="agent-background-terminals__approval">
          <span className="agent-background-terminals__approval-dot" aria-hidden="true" />
          <div className="agent-background-terminals__approval-copy">
            <strong>Codex 请求确认</strong>
            <span>
              {approval.method === 'item/fileChange/requestApproval'
                ? 'Codex 请求应用文件变更。'
                : 'Codex 请求执行需要确认的操作。'}
            </span>
            <code>{formatApprovalParams(approval.params)}</code>
            {approvalError && <span className="agent-background-terminals__approval-error">确认失败：{approvalError}</span>}
          </div>
          <div className="agent-background-terminals__approval-actions">
            <button type="button" onClick={() => void respondToApproval('decline')}>取消</button>
            <button type="button" onClick={() => void respondToApproval('accept')}>确认执行</button>
          </div>
        </div>
        {queuedMessages.length > 0 && <QueuedMessages messages={queuedMessages} label={t('agent.backgroundTerminals.queued')} />}
      </div>
    );
  }

  return (
    <div className="agent-background-terminals" data-expanded={expanded}>
      {terminals.length > 0 && <button
        type="button"
        className="agent-background-terminals__summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="agent-background-terminals__dot" aria-hidden="true" />
        <span className="agent-background-terminals__label">{countLabel}</span>
        <span className="agent-background-terminals__command">{terminals[0].command}</span>
        <svg className="agent-background-terminals__chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
        </svg>
      </button>}
      {expanded && terminals.length > 0 && (
        <div className="agent-background-terminals__details">
          {terminals.map((terminal) => (
            <div className="agent-background-terminals__row" key={terminal.id}>
              <span className="agent-background-terminals__status" />
              <code>{terminal.command}</code>
              {terminal.cwd && <span className="agent-background-terminals__cwd">{terminal.cwd}</span>}
              {terminal.status && <span className="agent-background-terminals__state">{terminal.status}</span>}
            </div>
          ))}
        </div>
      )}
      {queuedMessages.length > 0 && <QueuedMessages messages={queuedMessages} label={t('agent.backgroundTerminals.queued')} />}
    </div>
  );
}

function QueuedMessages({ messages, label }: { messages: string[]; label: string }) {
  return (
    <div className="agent-background-terminals__queue" aria-label={label}>
      <div className="agent-background-terminals__queue-heading">
        <span className="agent-background-terminals__queue-heading-label">{label}</span>
        <span className="agent-background-terminals__queue-count">{messages.length}</span>
      </div>
      {messages.map((message, index) => (
        <div className="agent-background-terminals__queue-row" key={`${index}-${message}`}>
          <span className="agent-background-terminals__queue-mark">
            <ArrowBendDownRightIcon aria-hidden="true" />
          </span>
          <span>{message}</span>
        </div>
      ))}
    </div>
  );
}

function formatApprovalParams(params: Record<string, unknown>): string {
  const command = params.command;
  const cwd = params.cwd;
  if (Array.isArray(command) || typeof command === 'string') {
    return [Array.isArray(command) ? command.join(' ') : command, cwd ? `cwd: ${String(cwd)}` : '']
      .filter(Boolean)
      .join(' · ');
  }
  return JSON.stringify(params, null, 2);
}

function approvalResult(
  request: CodexApprovalRequest,
  decision: 'accept' | 'decline',
): Record<string, unknown> {
  if (request.method === 'item/permissions/requestApproval') {
    return {
      permissions: decision === 'accept' ? request.params.permissions ?? {} : {},
      scope: 'turn',
      strictAutoReview: null,
    };
  }
  // item/commandExecution/requestApproval and item/fileChange/requestApproval
  // use the current app-server approval wire format, which is different from
  // the legacy ExecCommandApproval response.
  return { decision: decision === 'accept' ? 'accept' : 'decline' };
}
