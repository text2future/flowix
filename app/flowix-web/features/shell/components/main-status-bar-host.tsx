import type { DshDownloadProgress } from '@platform/tauri/client';
import { windows } from '@platform/tauri/client';
import type { Notebook } from '@features/memo/public/shell-api';
import type { AppUpdaterState } from '@features/shell/public/system-api';
import { StatusBar } from '@features/shell/components/status-bar/status-bar';

export interface MainStatusBarHostProps {
  onSelectNotebook(notebook: Notebook): void;
  onEditNotebook(notebook: Notebook): void;
  onDeleteNotebook(notebook: Notebook): void;
  onCreateNotebook(): void;
  todoCount: number;
  onOpenTodos(): void;
  onToggleNoteNavigation(): void;
  onOpenAgentConversationView(): void;
  dshDownload: DshDownloadProgress | null;
  updater: AppUpdaterState;
}

export function MainStatusBarHost(props: MainStatusBarHostProps) {
  return (
    <StatusBar
      {...props}
      onOpenPreferences={() => windows.openPreferences()}
      onOpenMcpPreferences={() => windows.openPreferences('mcp')}
      onOpenDshPreferences={() => windows.openPreferences('dsh')}
    />
  );
}

