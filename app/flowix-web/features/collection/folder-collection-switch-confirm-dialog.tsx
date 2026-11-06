'use client';

import { DialogFooter } from '@shared/ui/dialog-footer';
import { Button } from '@shared/ui/button';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';

export function FolderCollectionSwitchConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  confirmDisabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;
}) {
  const { t } = useI18n();

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>是否确认切换？</DialogTitle>
        <DialogDescription>切换后，当前集合的展示规则会重置</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" onClick={() => onOpenChange(false)} variant="outline">
          {t('dialog.cancel')}
        </Button>
        <Button type="button" disabled={confirmDisabled} onClick={onConfirm}
          variant="destructive">
          确认切换
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
