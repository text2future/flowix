import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { registerNotebookTemplateInitializationCompletedHandler } from '@/lib/memo-dispatcher';

const temporarySuppressionDepthByNotebook = new Map<string, number>();

/** Shared policy for the Browser Column side effect of `created` memo events. */
export function shouldAutoOpenCreatedNoteInBrowser(notebookId: string): boolean {
  return (temporarySuppressionDepthByNotebook.get(notebookId) ?? 0) === 0
    && useUserSettingsStore.getState().settings.autoOpenCreatedNotesInBrowser;
}

/** Suppress only automatic Browser Column opening for the duration of an operation. */
export async function withCreatedNoteAutoOpenSuppressed<T>(
  notebookId: string,
  operation: (operationId: string) => Promise<T>,
): Promise<T> {
  const operationId = crypto.randomUUID();
  let completeOperation!: () => void;
  const operationCompleted = new Promise<void>((resolve) => {
    completeOperation = resolve;
  });
  const unsubscribeCompletion = registerNotebookTemplateInitializationCompletedHandler((event) => {
    if (event.notebookId === notebookId && event.operationId === operationId) {
      completeOperation();
    }
  });

  temporarySuppressionDepthByNotebook.set(
    notebookId,
    (temporarySuppressionDepthByNotebook.get(notebookId) ?? 0) + 1,
  );
  try {
    let result: T | undefined;
    let operationError: unknown;
    let operationFailed = false;
    try {
      result = await operation(operationId);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    await operationCompleted;
    if (operationFailed) throw operationError;
    return result as T;
  } finally {
    unsubscribeCompletion();
    const nextDepth = (temporarySuppressionDepthByNotebook.get(notebookId) ?? 1) - 1;
    if (nextDepth === 0) {
      temporarySuppressionDepthByNotebook.delete(notebookId);
    } else {
      temporarySuppressionDepthByNotebook.set(notebookId, nextDepth);
    }
  }
}
