'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Info, ListTodo } from 'lucide-react';
import type { CSSProperties } from 'react';
import mcpPluginIcon from '@/assets/mcp-plugin.svg';
import { Tooltip } from '@shared/ui/tooltip';
import type { Notebook } from '@features/memo/store/note-store';
import { NotebookSelectorPopup } from '@features/shell/components/status-bar/notebook-selector-popup';
import { ProductUpdatePill } from '@features/shell/components/status-bar/product-update-pill';
import { ProductIntroDialog } from '@features/product-intro';
import { MassDeletionDialog } from '@features/shell/components/status-bar/mass-deletion-dialog';
import { notebooksAwaitingDeletionDecision, selectedNotebookSyncStatuses, stabilizeTransferPhase } from '@features/shell/components/status-bar/sync-degradation';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { useDocumentMetricsStore } from '@features/document/store/document-metrics-store';
import { useNoteStore } from '@features/memo/store/note-store';
import {
  cloud,
  listenToCloudStateChanges,
  listenToCloudStorageAccessChanges,
  listenToCloudSyncStatusChanges,
  listenToCloudDeleteConflictRestored,
  type CloudSyncStatus,
} from '@platform/tauri/client';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';

// 会话片段要读 agent-session-store（约 220 文件 / 3.3 万行），状态栏是常驻 UI，
// 不能为它把整套会话数据图拉进启动 chunk。首帧没有运行中的会话，空占位即可。
const AgentConversationStatusBar = lazy(() =>
  import('@features/agent/public/status-bar-api').then((module) => ({
    default: module.AgentConversationStatusBar,
  })),
);

interface StatusBarProps {
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onCreateNotebook: () => void;
  onOpenTodos: () => void;
  productIntroOpen: boolean;
  onProductIntroOpenChange: (open: boolean) => void;
  onOpenMcpPreferences: () => void;
  updater: AppUpdaterState;
}

/**
 * Bottom status bar for the main window.
 *
 * Layout (two columns):
 *   [NotebookSwitcher] | [Note Nav] [Todos] [running conversations]   …flex spacer…
 *                       [update pill] [char count] [⚙ MCP] [ⓘ intro]
 *
 * Cloud sync indicators live beside the product icon in the list title bar.
 *
 * The left column is the notebook switcher (fixed width by its own button
 * content); the right column takes the remaining width for the status actions.
 *
 * The bar carries no persistent agent entry point: starting an agent
 * conversation lives in the memo list / agent conversation list, so the strip
 * only surfaces agent activity that is actually running or unread.
 *
 * Renders no chrome of its own — it assumes it lives in a `h-[26px]` flex strip.
 */
export function StatusBar({
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
  onCreateNotebook,
  onOpenTodos,
  productIntroOpen,
  onProductIntroOpenChange,
  onOpenMcpPreferences,
  updater,
}: StatusBarProps) {
  const { t } = useI18n();
  const statusBarRightEdgeRef = useRef<HTMLDivElement>(null);
  const [notebookPopupOpen, setNotebookPopupOpen] = useState(false);
  const [cloudSyncStatuses, setCloudSyncStatuses] = useState<Map<string, CloudSyncStatus>>(
    () => new Map(),
  );
  const cloudStateRequestRef = useRef(0);
  const [cloudSyncedNotebookIds, setCloudSyncedNotebookIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [cloudSyncAvailable, setCloudSyncAvailable] = useState(false);
  const notebooks = useNoteStore((state) => state.notebooks);
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const setNotebooks = useNoteStore((state) => state.setNotebooks);
  const charCount = useDocumentMetricsStore((state) => state.charCount);

  useEffect(() => {
    const refreshCloudSyncedNotebookIds = () => {
      const requestId = ++cloudStateRequestRef.current;
      void Promise.all([cloud.getStorageAccess(), cloud.listNotebookStates()])
        .then(([storageAccess, links]) => {
          if (requestId !== cloudStateRequestRef.current) return;
          setCloudSyncAvailable(storageAccess.canRead);
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
    const unlistenState = listenToCloudStateChanges(() => {
      refreshCloudSyncedNotebookIds();
    });
    const unlistenStorage = listenToCloudStorageAccessChanges(() => {
      refreshCloudSyncedNotebookIds();
    });
    return () => {
      unlistenState();
      unlistenStorage();
    };
  }, []);

  useEffect(() => {
    const handleToggle = () => setNotebookPopupOpen((open) => !open);
    window.addEventListener('flowix:toggle-notebook-switcher', handleToggle);
    return () => window.removeEventListener('flowix:toggle-notebook-switcher', handleToggle);
  }, []);

  useEffect(() => {
    return listenToCloudDeleteConflictRestored(({ paths }) => {
      toast.info(t('cloudSync.deleteConflictRestored'), { description: paths.slice(0, 3).join(', ') });
    });
  }, [t]);

  useEffect(() => {
    return listenToCloudSyncStatusChanges((status) => {
      setCloudSyncStatuses((previous) => {
        const current = previous.get(status.notebookId);
        if (current && status.startedAt < current.startedAt) return previous;
        const next = new Map(previous);
        next.set(status.notebookId, stabilizeTransferPhase(current, status));
        return next;
      });
    });
  }, []);

  const currentSyncStatuses = selectedNotebookSyncStatuses(cloudSyncStatuses, selectedNotebook?.id);
  // The prompt can only speak for the notebook on screen; a background notebook
  // sitting on a deferred batch has no other way of saying so.
  const pendingDeletionNotebookIds = notebooksAwaitingDeletionDecision(cloudSyncStatuses.values());

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
          pendingDeletionNotebookIds={pendingDeletionNotebookIds}
        />
      </div>
      {/* Right column: full-width content area. */}
      <div ref={statusBarRightEdgeRef} className="flex-1 min-w-0 flex items-center gap-0.5 pl-0.5 pr-2">
        <button
          type="button"
          className="h-full inline-flex items-center gap-0.5 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          aria-label={t('status.todos')}
          onClick={onOpenTodos}
        >
          <ListTodo className="w-3.5 h-3.5 shrink-0" />
        </button>
        <Suspense fallback={null}>
          <AgentConversationStatusBar />
        </Suspense>
        <div className="flex-1" />
        <ProductUpdatePill updater={updater} anchor={statusBarRightEdgeRef} />
        {charCount > 0 && (
          <span className="h-full inline-flex items-center gap-0.5 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]">
            {t('status.characters')}{' '}
            <span className="font-mono tabular-nums">{charCount}</span>
          </span>
        )}
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
      <MassDeletionDialog
        notebookId={selectedNotebook?.id}
        localCount={currentSyncStatuses[0]?.massDeletionLocal ?? 0}
        remoteCount={currentSyncStatuses[0]?.massDeletionRemote ?? 0}
      />
    </div>
  );
}
