import { useEffect, useSyncExternalStore } from 'react';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';

type Request = { name: string; finish: (accepted: boolean) => void };
let pending: Request | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => pending;
function publish() { listeners.forEach(listener => listener()); }

/** A newer click cancels an older confirmation instead of sharing its approval. */
export function confirmCrossNotebookLink(
  sourceNotebookId: string | null | undefined,
  target: { id: string; name: string } | null | undefined,
): Promise<boolean> {
  pending?.finish(false);
  if (!target || target.id === sourceNotebookId) return Promise.resolve(true);
  return new Promise(resolve => {
    const request: Request = { name: target.name, finish(accepted) {
      if (pending !== request) return;
      pending = null;
      publish();
      resolve(accepted);
    } };
    pending = request;
    publish();
  });
}

/** Mounted once inside the application providers; unmount cancels pending work. */
export function CrossNotebookLinkConfirmHost() {
  const request = useSyncExternalStore(subscribe, snapshot, () => null);
  useEffect(() => () => { pending?.finish(false); }, []);
  if (!request) return null;
  const language = getCurrentAppLanguage();
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  return <Dialog open onOpenChange={open => { if (!open) request.finish(false); }}>
    <DialogContent trapFocus>
      <DialogHeader>
        <DialogTitle>{t('editor.link.crossNotebookTitle')}</DialogTitle>
        <DialogDescription>{translate(language, 'editor.link.crossNotebookDescription', { notebook: request.name })}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" autoFocus onClick={() => request.finish(false)}>{t('dialog.cancel')}</Button>
        <Button onClick={() => request.finish(true)}>{t('editor.link.goTo')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
