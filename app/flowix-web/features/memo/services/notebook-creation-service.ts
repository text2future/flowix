import type { Notebook } from '@features/memo/store/note-store';
import { notebookRepository } from '@features/memo/services/note-repository';
import { listenToNotebookImportStatus, type NotebookImportStatus } from '@platform/tauri/client';
import { files } from '@platform/tauri/client/desktop';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { loadLanguage, translate } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { resolveNotebookIconId } from '@features/memo/components/notebook-icon';

const logger = createLogger('notebook-creation-service');

export interface NotebookRegistrationResult {
  notebook: Notebook;
  created: boolean;
  needsImport: boolean;
}

interface CreateNotebookRegistrationInput {
  name: string;
  path?: string;
  icon?: string | null;
  reuseExisting?: boolean;
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
 * Localized name for the auto-created default notes folder (zh-CN → 笔记,
 * en-US → Notes). Reuses the same i18n key as the tree's default-folder badge
 * so the copy lives in one place. en-US messages are lazily loaded, so make
 * sure they're ready before reading; fall back to 笔记 if the key is empty.
 */
async function resolveDefaultNoteFolderName(): Promise<string> {
  const language = getCurrentAppLanguage();
  await loadLanguage(language);
  return translate(language, 'memo.fileTree.defaultNoteFolderLabel').trim() || '笔记';
}

/**
 * Creates the localized default notes folder inside a freshly created notebook
 * and marks it as the notebook's `defaultCreateFolder`, so subsequent notes
 * land there instead of the notebook root.
 *
 * Best-effort by design: notebook creation has already succeeded at this point,
 * so any failure here is logged and swallowed rather than rolling back or
 * surfacing an error for an otherwise usable notebook.
 */
async function ensureDefaultNoteFolder(notebook: Notebook): Promise<void> {
  try {
    const folderName = await resolveDefaultNoteFolderName();
    // create_folder maps to fs::create_dir_all — idempotent when the folder
    // already exists (e.g. seeded by a template or pre-existing directory).
    await files.createFolder(notebook.path, folderName);
    // Read-modify-write to keep any other stored preference fields.
    const preferences = await files.getNotebookViewPreferences(notebook.path);
    if ((preferences.defaultCreateFolder ?? null) !== folderName) {
      await files.setNotebookViewPreferences(notebook.path, {
        ...preferences,
        defaultCreateFolder: folderName,
      });
    }
  } catch (error) {
    logger.warn('ensure default note folder failed', { error, notebookId: notebook.id });
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
  reuseExisting = false,
}: CreateNotebookRegistrationInput): Promise<NotebookRegistrationResult> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('INVALID_NAME');

  const requestedPath = path?.trim();
  // The create command already resolves and creates the default directory.
  // Keep the ordinary path to one IPC instead of a separate ensure call.
  const pathForCreate = requestedPath || undefined;

  try {
    const notebook = await notebookRepository.create(
      trimmedName,
      pathForCreate,
      resolveNotebookIconId(icon),
      false,
    );
    // Only default-location creation gets a starter notes folder. Explicit
    // paths connect existing directories and must preserve their layout.
    if (!requestedPath) await ensureDefaultNoteFolder(notebook);
    return {
      notebook,
      created: true,
      needsImport: true,
    };
  } catch (error) {
    // A second onboarding attempt can race with another registration. Resolve
    // the backend duplicate response to the already registered notebook.
    if (reuseExisting && String(error).includes('PATH_ALREADY_REGISTERED')) {
      const existingPath = pathForCreate ?? await notebookRepository.getDefaultPath(trimmedName);
      const registered = await findNotebookByPath(existingPath);
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
