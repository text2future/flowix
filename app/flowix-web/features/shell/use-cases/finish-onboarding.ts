import {
  startNotebookImportWithMonitoring,
  type Notebook,
} from '@features/memo/public/shell-api';
import { selectNotebook } from '@features/workspace/public/shell-api';
import { clearActionableNotice, upsertActionableNotice } from '@features/notifications/actionable-notice-store';

export async function finishOnboardingNotebook(
  notebook: Notebook,
  { startImport }: { startImport: boolean },
  {
    completeOnboarding,
    failureTitle,
    retryLabel,
  }: {
    completeOnboarding: () => Promise<void>;
    failureTitle: string;
    retryLabel: string;
  },
): Promise<void> {
  await selectNotebook(notebook);
  if (startImport) {
    const noticeId = `notebook-import:${notebook.id}`;
    let attempt = 0;
    let importing = false;
    const beginImport = async () => {
      if (importing) return;
      importing = true;
      const revision = ++attempt;
      try {
        await startNotebookImportWithMonitoring(notebook.id, (status) => {
          importing = false;
          if (status.status === 'failed') {
            upsertActionableNotice({
              id: noticeId,
              priority: 50,
              tone: 'error',
              title: `${notebook.name} · ${failureTitle}`,
              message: status.message ?? undefined,
              revision,
              dismissible: true,
              actions: [{ id: 'retry', label: retryLabel, run: beginImport }],
            });
          } else {
            clearActionableNotice(noticeId);
          }
        });
      } catch (error) {
        importing = false;
        throw error;
      }
    };
    await beginImport();
  }
  await completeOnboarding();
}
