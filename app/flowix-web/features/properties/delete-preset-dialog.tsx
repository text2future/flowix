'use client';

import { DialogFooter } from '@shared/ui/dialog-footer';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';
import type { PropertyFieldConfig } from './types';

interface DeletePresetDialogProps {
  /** When non-null, the dialog is open and confirming will delete this preset. */
  preset: PropertyFieldConfig | null;
  /** Number of tables that reference the field; shown in the description. */
  tableCount: number;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * A preset deletion removes its note property from every note and table.
 */
export function DeletePresetDialog({ preset, tableCount, busy = false, onCancel, onConfirm }: DeletePresetDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog open={!!preset} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>{t('preferences.documentProperties.deleteChoiceTitle').replace('{key}', preset?.key ?? '')}</DialogTitle>
          <DialogDescription>{t('preferences.documentProperties.deleteDescription').replace('{count}', String(tableCount))}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col">
          <Button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            variant="destructive"
          >
            <span className="text-sm text-white">{t('preferences.documentProperties.deleteConfirmAction')}</span>
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={onCancel}
            variant="outline"
          >
            {t('preferences.documentProperties.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
