'use client';

import { AccountAuthFlow } from '@features/preferences/public/account-auth-flow';
import { Dialog, DialogContent } from '@shared/ui/dialog';

export function CloudLoginDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-32px)] w-[min(92vw,420px)] max-w-[420px] overflow-y-auto p-6">
        <AccountAuthFlow layout="dialog" onAuthenticated={onClose} />
      </DialogContent>
    </Dialog>
  );
}
