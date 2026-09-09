'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Hash, ListTodo, SlidersHorizontal } from 'lucide-react';
import { PlugIcon } from '@phosphor-icons/react';
import { Tooltip } from '@shared/ui/tooltip';
import type { Notebook } from '@features/memo';
import { NotebookSelectorPopup } from '@features/shell/components/status-bar/notebook-selector-popup';
import { AgentRuntimeStatusMenu } from '@features/shell/components/status-bar/agent-runtime-status-menu';
import { ProductUpdatePill } from '@features/shell/components/status-bar/product-update-pill';
import { useI18n } from '@/lib/i18n';
import { useDocumentMetricsStore } from '@features/document';
import { useMemoStore } from '@features/memo';
import { CloudStatusIcon } from '@shared/icons/cloud-status-icon';
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
  todoCount: number;
  onOpenTodos: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: () => void;
  onOpenMcpPreferences: () => void;
  onOpenDshPreferences: () => void;
  onOpenAgentConversationView: () => void;
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

/**
 * Bottom status bar for the main window.
 *
 * Layout (two columns):
 *   [NotebookSwitcher] | [Todos] [char count]   …flex spacer…   [Note Nav] [AI Chat] [⚙]
 *                       ↑ top border
 *
 * The left column is the notebook switcher (fixed width by its own button
 * content); the right column takes the remaining width and carries the top
 * border so the switcher's primary-colored block reads as a standalone first
 * column.
 *
 * Renders no chrome of its own — it assumes it lives in a `h-[26px]` flex strip.
 */
export function StatusBar({
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
  onCreateNotebook,
  todoCount,
  onOpenTodos,
  onToggleNoteNavigation,
  onOpenPreferences,
  onOpenMcpPreferences,
  onOpenDshPreferences,
  onOpenAgentConversationView,
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
  const notebooks = useMemoStore((state) => state.notebooks);
  const selectedNotebook = useMemoStore((state) => state.selectedNotebook);
  const setNotebooks = useMemoStore((state) => state.setNotebooks);
  const charCount = useDocumentMetricsStore((state) => state.charCount);

  const agentWorkspacePath = useMemo(() => {
    return selectedNotebook?.name ?? '';
  }, [selectedNotebook?.name]);

  useEffect(() => {
    const refreshCloudSyncedNotebookIds = () => {
      const requestId = ++cloudStateRequestRef.current;
      void Promise.all([cloud.getState(), cloud.listNotebookStates()])
        .then(([cloudState, links]) => {
          if (requestId !== cloudStateRequestRef.current) return;
          setCloudSyncAvailable(cloudState.authenticated && cloudState.enabled);
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
      setCloudSyncAvailable(cloudState.authenticated && cloudState.enabled);
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

  return (
    <div className="flex h-[26px] shrink-0 select-none items-stretch bg-[var(--statusbar-bg)] text-xs text-[var(--muted-foreground)]">
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
      {/* Right column: full-width content area; carries the top border. */}
      <div className="flex-1 min-w-0 flex items-center gap-1 pl-1.5 border-t border-[var(--divider)]">
        <button
          type="button"
          className="h-full inline-flex items-center gap-0.5 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          aria-label={`${t('status.todos')} ${todoCount}`}
          onClick={onOpenTodos}
        >
          <ListTodo className="w-3.5 h-3.5 shrink-0" />
          <span>{t('status.todos')}</span>
          <span>{todoCount}</span>
        </button>
        <AgentRuntimeStatusMenu
          onOpen={onOpenAgentConversationView}
          workspaceFolderName={agentWorkspacePath || undefined}
        />
        <Tooltip content={t('shell.statusBar.noteNavTooltip')} shortcut="panel.noteNavigation.toggle">
          <button
            type="button"
            onClick={onToggleNoteNavigation}
            className="h-full flex items-center gap-0.5 px-1.5 py-0 hover:bg-[var(--muted)]"
            aria-label={t('shell.statusBar.noteNav')}
          >
            <Hash className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
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
            className="inline-flex h-[22px] items-center gap-0.5 px-1.5 text-xs leading-none text-[var(--muted-foreground)]"
            role="status"
            aria-live="polite"
            aria-label={t('shell.statusBar.syncing')}
          >
            <CloudStatusIcon
              status="connecting"
              size={14}
              className="!opacity-100"
            />
          </div>
        )}
        {charCount > 0 && (
          <span className="h-full inline-flex items-center gap-0.5 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]">
            {t('status.characters')} {charCount}
          </span>
        )}
        <Tooltip content={t('preferences.tabs.mcp')} side="top">
          <button
            type="button"
            onClick={onOpenMcpPreferences}
            className="h-full flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            aria-label={t('preferences.tabs.mcp')}
          >
            <PlugIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t('status.preferences')} shortcut="menu.open" side="top">
          <button
            type="button"
            onClick={onOpenPreferences}
            className="mr-1.5 h-full flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            aria-label={t('status.preferences')}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
