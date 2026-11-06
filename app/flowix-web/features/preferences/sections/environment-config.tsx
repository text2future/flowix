'use client';

import { DialogFooter } from '@shared/ui/dialog-footer';
import { useEffect, useState } from 'react';
import { boot, product, relaunch, type CloudEnvironment, type ProductInfo } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Tooltip } from '@shared/ui/tooltip';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { FieldRow, SectionHeader } from '@features/preferences/sections/primitives';

interface EnvironmentConfigSectionProps {
  productInfo: ProductInfo | null;
}

export function EnvironmentConfigSection({ productInfo }: EnvironmentConfigSectionProps) {
  const { t } = useI18n();
  const [switchingCloudEnvironment, setSwitchingCloudEnvironment] = useState(false);
  const [confirmingProdSwitch, setConfirmingProdSwitch] = useState(false);
  const [versionInitializationCompleted, setVersionInitializationCompleted] = useState<boolean | null>(null);
  const [savingVersionInitialization, setSavingVersionInitialization] = useState(false);
  const cloudEnvironmentLabel = productInfo?.cloudEnvironment === 'prod'
    ? t('preferences.environmentConfig.cloudEnvironment.prod')
    : t('preferences.environmentConfig.cloudEnvironment.staging');

  useEffect(() => {
    let active = true;
    if (!productInfo?.isDevBuild) {
      setVersionInitializationCompleted(null);
      return () => { active = false; };
    }
    void boot.getVersionInitializationCompleted().then((completed) => {
      if (active) setVersionInitializationCompleted(completed);
    }).catch(() => {
      if (active) toast.error(t('preferences.environmentConfig.versionInitialization.loadFailed'));
    });
    return () => { active = false; };
  }, [productInfo?.isDevBuild, t]);

  const handleVersionInitializationChange = async () => {
    if (versionInitializationCompleted === null || savingVersionInitialization) return;
    const completed = !versionInitializationCompleted;
    setSavingVersionInitialization(true);
    try {
      await boot.setVersionInitializationCompleted(completed);
      setVersionInitializationCompleted(completed);
      toast.success(t(completed
        ? 'preferences.environmentConfig.versionInitialization.markedComplete'
        : 'preferences.environmentConfig.versionInitialization.rerunNextLaunch'));
    } catch {
      toast.error(t('preferences.environmentConfig.versionInitialization.saveFailed'));
    } finally {
      setSavingVersionInitialization(false);
    }
  };

  const applyCloudEnvironment = async (environment: CloudEnvironment) => {
    if (!productInfo?.isDevBuild) return;
    setSwitchingCloudEnvironment(true);
    let preferenceSaved = false;
    try {
      await product.setCloudEnvironment(environment);
      preferenceSaved = true;
      await relaunch();
    } catch {
      setSwitchingCloudEnvironment(false);
      setConfirmingProdSwitch(false);
      toast.error(t(preferenceSaved
        ? 'preferences.environmentConfig.cloudEnvironment.restartFailed'
        : 'preferences.environmentConfig.cloudEnvironment.failed'));
    }
  };

  const handleCloudEnvironmentChange = (value: string) => {
    if (!productInfo?.isDevBuild) return;
    const environment = value === 'staging' || value === 'prod' ? value : null;
    if (!environment || environment === productInfo.cloudEnvironment) return;
    if (environment === 'prod') {
      setConfirmingProdSwitch(true);
      return;
    }
    void applyCloudEnvironment(environment);
  };

  const handleOpenLogDir = async () => {
    try {
      await product.openLogDir();
    } catch {
      toast.error(t('preferences.environmentConfig.runtimeLogs.openFailed'));
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader title={t('preferences.environmentConfig.title')} />

      {productInfo?.isDevBuild && (
        <FieldRow
          title={t('preferences.environmentConfig.cloudEnvironment.title')}
          description={t('preferences.environmentConfig.cloudEnvironment.description')}
          controlId="preferences-cloud-environment"
        >
          <Select
            value={productInfo.cloudEnvironment}
            disabled={switchingCloudEnvironment}
            onValueChange={handleCloudEnvironmentChange}
          >
            <SelectTrigger id="preferences-cloud-environment" className="w-64">
              <span>{cloudEnvironmentLabel}</span>
            </SelectTrigger>
            <SelectContent className="flowix-preferences-select-content">
              <SelectItem value="staging">
                {t('preferences.environmentConfig.cloudEnvironment.staging')}
              </SelectItem>
              <SelectItem value="prod">
                {t('preferences.environmentConfig.cloudEnvironment.prod')}
              </SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      )}

      {productInfo?.isDevBuild && (
        <FieldRow
          title={t('preferences.environmentConfig.versionInitialization.title')}
          description={t('preferences.environmentConfig.versionInitialization.description')}
        >
          <button
            type="button"
            role="switch"
            aria-checked={versionInitializationCompleted === true}
            aria-label={t('preferences.environmentConfig.versionInitialization.title')}
            disabled={versionInitializationCompleted === null || savingVersionInitialization}
            onClick={() => void handleVersionInitializationChange()}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              versionInitializationCompleted ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]'
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--card)] shadow-sm transition-transform ${
                versionInitializationCompleted ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </FieldRow>
      )}

      <FieldRow
        title={t('preferences.environmentConfig.runtimeLogs.title')}
        description={productInfo?.logDir ?? t('preferences.environmentConfig.runtimeLogs.description')}
      >
        <Tooltip content={t('preferences.environmentConfig.runtimeLogs.openFolder')}>
          <Button variant="outline" className="px-3" onClick={() => void handleOpenLogDir()}>
            {t('preferences.environmentConfig.runtimeLogs.open')}
          </Button>
        </Tooltip>
      </FieldRow>

      <Dialog open={confirmingProdSwitch} onOpenChange={(open) => {
        if (!switchingCloudEnvironment) setConfirmingProdSwitch(open);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('preferences.environmentConfig.cloudEnvironment.prodConfirm.title')}</DialogTitle>
            <DialogDescription>
              {t('preferences.environmentConfig.cloudEnvironment.prodConfirm.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={switchingCloudEnvironment}
              onClick={() => setConfirmingProdSwitch(false)}
            >
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={switchingCloudEnvironment}
              onClick={() => void applyCloudEnvironment('prod')}
            >
              {t('preferences.environmentConfig.cloudEnvironment.prodConfirm.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
