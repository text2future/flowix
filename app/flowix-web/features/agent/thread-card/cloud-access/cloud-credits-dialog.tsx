import type { Root } from 'react-dom/client';
import { useI18n } from '@/lib/i18n';
import { openPaymentDialog } from '@features/cloud-billing/public/payment-dialog';
import { Dialog, DialogContent, DialogTitle } from '@shared/ui/dialog';

let mounted: { root: Root; container: HTMLElement } | null = null;

function CloudCreditsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[min(92vw,420px)] max-w-[420px] p-6">
        <DialogTitle>{t('agent.cloudAccess.noCredits.title')}</DialogTitle>
        <p className="mt-3 text-sm text-muted-foreground">{t('agent.cloudAccess.noCredits.description')}</p>
        <div className="mt-5 flex justify-end">
          <button type="button" className="agent-cloud-access__action" onClick={() => {
            onClose();
            void openPaymentDialog('membership');
          }}>{t('agent.cloudAccess.noCredits.action')}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export async function openCloudCreditsDialog(): Promise<void> {
  if (typeof document === 'undefined' || mounted) return;
  const [{ createRoot }, React] = await Promise.all([import('react-dom/client'), import('react')]);
  if (mounted) return;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const close = () => {
    if (!mounted) return;
    mounted = null;
    root.unmount();
    container.remove();
  };
  mounted = { root, container };
  root.render(React.createElement(CloudCreditsDialog, { onClose: close }));
}
