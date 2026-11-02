import type { WorkspaceWebRuntime } from './surface-contract';

export function createWorkspaceWebRuntime(url: string): WorkspaceWebRuntime {
  return { currentUrl: url, history: [url], historyIndex: 0, reloadToken: 0, isLoading: true, error: null };
}

/** Address is already normalized by the navigation caller. */
export function navigateWorkspaceWebRuntime(current: WorkspaceWebRuntime, url: string): WorkspaceWebRuntime {
  const history = current.history.slice(0, current.historyIndex + 1);
  if (history[history.length - 1] !== url) history.push(url);
  return { ...current, currentUrl: url, history, historyIndex: history.length - 1,
    reloadToken: current.reloadToken + 1, isLoading: true, error: null };
}

/** Automatic redirects replace the current entry so Back can leave the page. */
export function replaceWorkspaceWebRuntimeUrl(current: WorkspaceWebRuntime, url: string): WorkspaceWebRuntime {
  const history = [...current.history];
  history[current.historyIndex] = url;
  return { ...current, currentUrl: url, history,
    reloadToken: current.reloadToken + 1, isLoading: true, error: null };
}

export function moveWorkspaceWebHistory(current: WorkspaceWebRuntime, direction: -1 | 1): WorkspaceWebRuntime | null {
  const historyIndex = current.historyIndex + direction;
  if (historyIndex < 0 || historyIndex >= current.history.length) return null;
  return { ...current, currentUrl: current.history[historyIndex], historyIndex,
    reloadToken: current.reloadToken + 1, isLoading: true, error: null };
}

export function reloadWorkspaceWebRuntime(current: WorkspaceWebRuntime): WorkspaceWebRuntime {
  return { ...current, reloadToken: current.reloadToken + 1, isLoading: true, error: null };
}

/** Restore serializable navigation state; live loading/error handles are recreated. */
export function restoreWorkspaceWebRuntime(value: unknown): WorkspaceWebRuntime | null {
  if (!value || typeof value !== 'object' || !('history' in value) || !Array.isArray(value.history)
    || !value.history.every((url) => typeof url === 'string')
    || !('historyIndex' in value) || typeof value.historyIndex !== 'number'
    || !Number.isInteger(value.historyIndex) || value.historyIndex < 0 || value.historyIndex >= value.history.length
    || !('currentUrl' in value) || typeof value.currentUrl !== 'string'
    || value.history[value.historyIndex] !== value.currentUrl) return null;
  // Keep the active location even if the retained history is capped.
  const start = Math.max(0, value.historyIndex - 99);
  const history = value.history.slice(start, start + 200);
  return { currentUrl: value.currentUrl, history, historyIndex: value.historyIndex - start,
    reloadToken: 0, isLoading: true, error: null };
}
