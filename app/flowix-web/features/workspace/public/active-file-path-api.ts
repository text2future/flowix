import { useWorkspaceSessionStore } from './session-api';
/**
 * Path-based content currently on screen, across both workspace hosts.
 *
 * The file tree defaults documents to the Browser column, so "which file is
 * open" can no longer be read from the Work column alone. Kept as a narrow
 * public entry (not a barrel) so tree components never touch the stores.
 */
import { useBrowserColumnStore, type BrowserColumnTarget } from '../store/browser-column-store';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceFocusStore } from '../store/workspace-focus-store';
import type { WorkspaceSurfaceHost } from '../model/surface-contract';
import type { WorkColumnTarget } from '../store/work-column-target';
import { pickFocusedHostValue } from '../model/focused-host-value';

function workColumnFilePath(target: WorkColumnTarget): string | null {
  if (target.kind === 'external') return target.path;
  if (target.kind === 'media') return target.filePath;
  return null;
}

function browserColumnFilePath(target: BrowserColumnTarget | null): string | null {
  if (!target) return null;
  if (target.kind === 'file-browser') return target.activeFilePath;
  if (target.kind === 'media') return target.filePath;
  return null;
}

/** The focused host wins when both columns show a different file. */
export function resolveActiveFilePath(input: {
  focusedHostId: WorkspaceSurfaceHost;
  workPath: string | null;
  browserPath: string | null;
}): string | null {
  return pickFocusedHostValue({
    focusedHostId: input.focusedHostId,
    work: input.workPath,
    browser: input.browserPath,
  });
}

export function useActiveFilePath(): string | null {
  const primaryAtWork = useWorkspaceSessionStore((state) => state.hosts['main-third'] === 'primary-session');
  const visible = useBrowserColumnStore((state) => state.visible);
  const workPath = useWorkColumnStore((state) => workColumnFilePath(state.navigation.target));
  // A hidden Browser column keeps its last entry; it is not on screen then.
  const browserPath = useBrowserColumnStore((state) => (
    browserColumnFilePath(state.current?.target ?? null)
  ));
  const focusedHostId = useWorkspaceFocusStore((state) => state.focusedHostId);
  return resolveActiveFilePath({ focusedHostId, workPath: primaryAtWork || visible ? workPath : null, browserPath: !primaryAtWork || visible ? browserPath : null });
}
