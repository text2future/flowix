'use client';

import { useEffect, useRef, useState } from 'react';
import { Info, ListTodo } from 'lucide-react';
import type { CSSProperties } from 'react';
import mcpPluginIcon from '@/assets/mcp-plugin.svg';
import { Tooltip } from '@shared/ui/tooltip';
import type { Notebook } from '@features/memo/store/note-store';
import { NotebookSelectorPopup } from '@features/shell/components/status-bar/notebook-selector-popup';
import { ProductUpdatePill } from '@features/shell/components/status-bar/product-update-pill';
import { ProductIntroDialog } from '@features/shell/components/status-bar/product-intro-dialog';
import {
  AgentConversationStatusBar,
  AgentIcon,
  createAndOpenPiConversation,
} from '@features/agent/public/shell-api';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { normalizeAgentRuntimeStatus } from '@features/agent/runtime/agent-runtime-status';
import { useI18n } from '@/lib/i18n';
import { useDocumentMetricsStore } from '@features/document/store/document-metrics-store';
import { useNoteStore } from '@features/memo/store/note-store';
import { CloudStatusIcon } from '@shared/icons/cloud-status-icon';
import { TagSvgIcon } from '@shared/ui/tag-icon';
import {
  cloud,
  listenToCloudStateChanges,
  listenToCloudSyncStatusChanges,
  type CloudSyncStatus,
  type DshDownloadProgress,
} from '@platform/tauri/client';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';

interface StatusBarProps {
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onCreateNotebook: () => void;
  onOpenTodos: () => void;
  onToggleNoteNavigation: () => void;
  productIntroOpen: boolean;
  onProductIntroOpenChange: (open: boolean) => void;
  onOpenMcpPreferences: () => void;
  onOpenDshPreferences: () => void;
  dshDownload: DshDownloadProgress | null;
  updater: AppUpdaterState;
}

function DshDownloadProgressIcon({ percent }: { percent: number | null | undefined }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const progress = percent == null ? 0.25 : Math.min(100, Math.max(0, percent)) / 100;

  return (
    <svg
      aria-hidden="true"
      className={`h-3.5 w-3.5 shrink-0${percent == null ? ' animate-spin' : ''}`}
      viewBox="0 0 12 12"
    >
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.5"
      />
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
        transform="rotate(-90 6 6)"
      />
    </svg>
  );
}

function PiRuntimeStatusIndicator() {
  const { t } = useI18n();
  const piStatus = useAgentRuntimeStore((state) => state.statusByType.pi);
  const isChecking = useAgentRuntimeStore((state) => state.isChecking);
  const refreshIfStale = useAgentRuntimeStore((state) => state.refreshIfStale);

  useEffect(() => {
    void refreshIfStale();
  }, [refreshIfStale]);

  const runtimeStatus = normalizeAgentRuntimeStatus(piStatus, isChecking);
  const statusText = runtimeStatus.state === 'ready'
    ? t('agent.status.available')
    : runtimeStatus.state === 'checking'
      ? t('agent.status.checking')
      : runtimeStatus.state === 'unknown'
        ? t('agent.status.notChecked')
        : t('agent.status.setup');
  const label = `${t('agent.types.pi.name')} · ${statusText}`;

  return (
    <Tooltip content={label} side="top">
      <button
        type="button"
        onClick={createAndOpenPiConversation}
        className="h-full flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)]"
        aria-label={label}
      >
        <AgentIcon
          typeKey="pi"
          alt=""
          className="h-3.5 w-3.5"
        />
      </button>
    </Tooltip>
  );
}

/**
 * Bottom status bar for the main window.
 *
 * Layout (two columns):
 *   [NotebookSwitcher] | [Todos] [char count]   …flex spacer…   [Note Nav] [AI Chat] [⚙]
 *
 * The left column is the notebook switcher (fixed width by its own button
 * content); the right column takes the remaining width for the status actions.
 *
 * Renders no chrome of its own — it assumes it lives in a `h-[26px]` flex strip.
 */
export function StatusBar({
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
  onCreateNotebook,
  onOpenTodos,
  onToggleNoteNavigation,
  productIntroOpen,
  onProductIntroOpenChange,
  onOpenMcpPreferences,
  onOpenDshPreferences,
  dshDownload,
  updater,
}: StatusBarProps) {
  const { t } = useI18n();
  const [notebookPopupOpen, setNotebookPopupOpen] = useState(false);
  const [cloudSyncStatuses, setCloudSyncStatuses] = useState<Map<string, CloudSyncStatus>>(
    () => new Map(),
  );
  const cloudStateRequestRef = useRef(0);
  const [cloudSyncedNotebookIds, setCloudSyncedNotebookIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [cloudSyncAvailable, setCloudSyncAvailable] = useState(false);
  const [cloudPendingOperationCount, setCloudPendingOperationCount] = useState(0);
  const notebooks = useNoteStore((state) => state.notebooks);
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const setNotebooks = useNoteStore((state) => state.setNotebooks);
  const charCount = useDocumentMetricsStore((state) => state.charCount);

  useEffect(() => {
    const refreshCloudSyncedNotebookIds = () => {
      const requestId = ++cloudStateRequestRef.current;
      void Promise.all([cloud.getState(), cloud.listNotebookStates()])
        .then(([cloudState, links]) => {
          if (requestId !== cloudStateRequestRef.current) return;
          setCloudSyncAvailable(cloudState.authenticated);
          setCloudSyncedNotebookIds(
            new Set(links.filter((link) => link.enabled).map((link) => link.notebookId)),
          );
        })
        .catch(() => {
          if (requestId !== cloudStateRequestRef.current) return;
          setCloudSyncAvailable(false);
          setCloudSyncedNotebookIds(new Set());
        });
    };
    refreshCloudSyncedNotebookIds();
    return listenToCloudStateChanges((cloudState) => {
      setCloudSyncAvailable(cloudState.authenticated);
      refreshCloudSyncedNotebookIds();
    });
  }, []);

  useEffect(() => {
    const handleToggle = () => setNotebookPopupOpen((open) => !open);
    window.addEventListener('flowix:toggle-notebook-switcher', handleToggle);
    return () => window.removeEventListener('flowix:toggle-notebook-switcher', handleToggle);
  }, []);

  useEffect(() => {
    return listenToCloudSyncStatusChanges((status) => {
      setCloudSyncStatuses((previous) => {
        const current = previous.get(status.notebookId);
        if (current && status.startedAt < current.startedAt) return previous;
        const next = new Map(previous);
        next.set(status.notebookId, status);
        return next;
      });
    });
  }, []);

  const cloudSyncInProgress = Array.from(cloudSyncStatuses.values()).some((status) =>
    status.state === 'queued'
    || status.state === 'checking'
    || status.state === 'syncing'
    || status.state === 'finalizing',
  );

  useEffect(() => {
    if (!cloudSyncInProgress) {
      setCloudPendingOperationCount(0);
      return;
    }

    let cancelled = false;
    let requestInFlight = false;
    const refreshPendingOperationCount = () => {
      if (requestInFlight) return;
      requestInFlight = true;
      void cloud.listPendingFileOperationCounts()
        .then((counts) => {
          if (cancelled) return;
          setCloudPendingOperationCount(
            Object.values(counts).reduce((total, count) => total + count, 0),
          );
        })
        .catch(() => {
          // Keep the last known count through a transient IPC/database error.
        })
        .finally(() => {
          requestInFlight = false;
        });
    };

    refreshPendingOperationCount();
    const interval = window.setInterval(refreshPendingOperationCount, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [cloudSyncInProgress]);

  return (
    <div className="flex h-[26px] shrink-0 select-none items-stretch text-xs text-[var(--muted-foreground)]">
      {/* Left column: notebook switcher (fixed width by its own button content). */}
      <div className="shrink-0 flex items-center">
        <NotebookSelectorPopup
          open={notebookPopupOpen}
          onOpenChange={setNotebookPopupOpen}
          notebooks={notebooks}
          selectedNotebook={selectedNotebook}
          onSelect={onSelectNotebook}
          onEdit={onEditNotebook}
          onDelete={onDeleteNotebook}
          onCreateNotebook={onCreateNotebook}
          onRefresh={setNotebooks}
          cloudSyncedNotebookIds={cloudSyncedNotebookIds}
          cloudSyncAvailable={cloudSyncAvailable}
        />
      </div>
      {/* Right column: full-width content area. */}
      <div className="flex-1 min-w-0 flex items-center gap-0.5 pl-0.5 pr-2">
        <Tooltip content={t('shell.statusBar.noteNavTooltip')} shortcut="panel.noteNavigation.toggle">
          <button
            type="button"
            onClick={onToggleNoteNavigation}
            className="h-full flex items-center gap-0.5 px-1.5 py-0 hover:bg-[var(--muted)]"
            aria-label={t('shell.statusBar.noteNav')}
          >
            <TagSvgIcon className="w-4 h-4" />
          </button>
        </Tooltip>
        <button
          type="button"
          className="h-full inline-flex items-center gap-0.5 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          aria-label={t('status.todos')}
          onClick={onOpenTodos}
        >
          <ListTodo className="w-3.5 h-3.5 shrink-0" />
        </button>
        <AgentConversationStatusBar />
        <div className="flex-1" />
        {dshDownload && (
          <button
            type="button"
            onClick={onOpenDshPreferences}
            className="inline-flex h-[22px] items-center gap-0.5 rounded-md px-2 text-xs leading-none text-[var(--primary)] hover:bg-[var(--muted)]"
            title={t('preferences.dsh.runtime.downloadProgress')}
          >
            <DshDownloadProgressIcon percent={dshDownload.percent} />
            <span>{t('preferences.dsh.runtime.downloading')}</span>
          </button>
        )}
        <ProductUpdatePill updater={updater} />
        {cloudSyncInProgress && (
          <div
            className="inline-flex h-[22px] items-center gap-1 px-1.5 text-xs leading-none text-[var(--muted-foreground)]"
            role="status"
            aria-live="polite"
            aria-label={
              cloudPendingOperationCount > 0
                ? `${t('shell.statusBar.syncing')} ${cloudPendingOperationCount}`
                : t('shell.statusBar.syncing')
            }
          >
            <CloudStatusIcon
              status="connecting"
              size={14}
              className="!opacity-100"
            />
            {cloudPendingOperationCount > 0 && (
              <span className="font-mono tabular-nums">
                {cloudPendingOperationCount}
              </span>
            )}
          </div>
        )}
        {charCount > 0 && (
          <span className="h-full inline-flex items-center gap-0.5 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]">
            {t('status.characters')}{' '}
            <span className="font-mono tabular-nums">{charCount}</span>
          </span>
        )}
        <PiRuntimeStatusIndicator />
        <Tooltip content={t('preferences.tabs.mcp')} side="top">
          <button
            type="button"
            onClick={onOpenMcpPreferences}
            className="h-full flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            aria-label={t('preferences.tabs.mcp')}
          >
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 bg-current"
              style={{
                mask: `url("${mcpPluginIcon}") center / contain no-repeat`,
                WebkitMask: `url("${mcpPluginIcon}") center / contain no-repeat`,
              } as CSSProperties}
            />
          </button>
        </Tooltip>
        <Tooltip content={t('shell.productIntro.button')} side="top">
          <button
            type="button"
            onClick={() => onProductIntroOpenChange(true)}
            className="h-full flex items-center justify-center px-1.5 py-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label={t('shell.productIntro.button')}
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <ProductIntroDialog open={productIntroOpen} onOpenChange={onProductIntroOpenChange} />
    </div>
  );
}
