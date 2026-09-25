import type { Notebook } from '@features/memo/store/memo-store';
import { notebookRepository } from '@features/memo/services/memo-repository';
import {
  listenToNotebookImportStatus,
  type NotebookImportStatus,
} from '@platform/tauri/client';

export interface NotebookRegistrationResult {
  notebook: Notebook;
  created: boolean;
  needsImport: boolean;
}

interface CreateNotebookRegistrationInput {
  name: string;
  path?: string;
  icon?: string | null;
}

function comparablePath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').toLowerCase();
}

async function findNotebookByPath(path: string): Promise<Notebook | null> {
  const notebooks = await notebookRepository.list();
  return notebooks.find((notebook) => comparablePath(notebook.path) === comparablePath(path)) ?? null;
}

async function notebookNeedsImport(notebookId: string): Promise<boolean> {
  try {
    const status = await notebookRepository.getImportStatus(notebookId);
    return notebookNeedsImportFromStatus(status);
  } catch {
    // Import status is best-effort and may be unavailable after an app restart.
    // Re-running the idempotent reconcile is safer than leaving the notebook
    // registered but uninitialized.
    return true;
  }
}

export function notebookNeedsImportFromStatus(status: NotebookImportStatus | null): boolean {
  return status?.status !== 'completed';
}

export async function startNotebookImportWithMonitoring(
  notebookId: string,
  onTerminalStatus?: (status: NotebookImportStatus) => void,
): Promise<() => void> {
  let stopped = false;
  let unlisten: (() => void) | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    unlisten?.();
    unlisten = null;
  };

  const handleStatus = (status: NotebookImportStatus) => {
    if (stopped || status.notebookId !== notebookId) return;
    if (status.status === 'completed' || status.status === 'failed' || status.status === 'skipped') {
      stop();
      onTerminalStatus?.(status);
    }
  };

  unlisten = listenToNotebookImportStatus(handleStatus);
  try {
    await notebookRepository.startImport(notebookId);
    try {
      const status = await notebookRepository.getImportStatus(notebookId);
      if (status) handleStatus(status);
    } catch {
      // The status query is only a race-closing check. The event listener
      // remains authoritative when the in-memory status is unavailable.
    }
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

/**
 * Registers a local notebook through the same IPC sequence used by the
 * notebook dialog. Reusing an existing path makes onboarding retry-safe.
 */
export async function createNotebookRegistration({
  name,
  path,
  icon,
}: CreateNotebookRegistrationInput): Promise<NotebookRegistrationResult> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('INVALID_NAME');

  const requestedPath = path?.trim();
  const pathForCreate = requestedPath || await notebookRepository.ensureDefaultPath(trimmedName);

  try {
    const notebook = await notebookRepository.create(trimmedName, pathForCreate, icon, false);
    return { notebook, created: true, needsImport: true };
  } catch (error) {
    // A second onboarding attempt can race with another registration. Resolve
    // the backend duplicate response to the already registered notebook.
    if (String(error).includes('PATH_ALREADY_REGISTERED')) {
      const registered = await findNotebookByPath(pathForCreate);
      if (registered) {
        return {
          notebook: registered,
          created: false,
          needsImport: await notebookNeedsImport(registered.id),
        };
      }
    }
    throw error;
  }
}
