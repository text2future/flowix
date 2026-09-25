import { useCallback, useEffect, useState } from 'react';
import { notebooks, type NotebookTemplateRecord } from '@platform/tauri/client';

export type NotebookTemplate = NotebookTemplateRecord;

type NotebookTemplateLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export function useNotebookTemplates(enabled = true) {
  const [templates, setTemplates] = useState<NotebookTemplate[]>([]);
  const [status, setStatus] = useState<NotebookTemplateLoadStatus>('idle');
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => setRetryCount((count) => count + 1), []);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }

    let active = true;
    setStatus('loading');
    void notebooks.listTemplates()
      .then((items) => {
        if (!active) return;
        setTemplates(items);
        setStatus('ready');
      })
      .catch((error) => {
        console.warn('[NotebookTemplates] Failed to read local templates:', error);
        if (active) setStatus('error');
      });

    return () => {
      active = false;
    };
  }, [enabled, retryCount]);

  return {
    templates,
    status,
    retry,
  } as const;
}

export async function initializeNotebookTemplate(
  notebookId: string,
  templateId: string,
  isNewNotebook: boolean,
): Promise<number> {
  return notebooks.initializeTemplate(notebookId, templateId, isNewNotebook);
}
