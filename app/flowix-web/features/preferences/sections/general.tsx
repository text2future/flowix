'use client';

import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { AppUpdatePromptDialog, useManualAppUpdateCheck } from '@features/shell/public/system-api';
import { recordProductUpdateCheck } from '@features/preferences/public/product-updates-api';
import { Select, SelectTrigger, SelectContent, SelectItem } from '@shared/ui/select';
import { Button } from '@shared/ui/button';
import { UpdateProgress } from '@shared/ui/update-progress';
import type { ProductInfo } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import {
  FieldRow,
  SectionHeader,
  FIELD_TITLE_CLASS,
} from '@features/preferences/sections/primitives';
import { LANGUAGE_OPTIONS, useI18n, type AppLanguage } from '@/lib/i18n';

interface GeneralSectionProps {
  language: AppLanguage;
  productInfo: ProductInfo | null;
  afterGeneral?: ReactNode;
  updateSettings: (updates: {
    language?: AppLanguage;
  }) => Promise<void>;
}

export function GeneralSection({ language, productInfo, afterGeneral, updateSettings }: GeneralSectionProps) {
  const { t } = useI18n();
  const [versionCopied, setVersionCopied] = useState(false);
  const manualUpdateCheck = useManualAppUpdateCheck({ afterCheck: recordProductUpdateCheck });
  const updater = manualUpdateCheck.updater;
  const currentLanguageLabel =
    LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ?? language;

  const handleInstallUpdate = async () => {
    try {
      if (updater.status === 'ready') await updater.installNow();
      else await updater.downloadNow();
    } catch {
      toast.error(t(updater.status === 'ready' ? 'appUpdates.installFailed' : 'appUpdates.downloadFailed'));
    }
  };

  const currentVersionText = productInfo
    ? `${productInfo.version}_${productInfo.os}_${productInfo.arch}`
    : t('preferences.general.loading');

  const handleCopyVersion = async () => {
    if (!productInfo) return;
    try {
      await navigator.clipboard.writeText(currentVersionText);
      setVersionCopied(true);
      toast.success(t('preferences.general.versionCopied'));
      window.setTimeout(() => setVersionCopied(false), 1600);
    } catch {
      toast.error(t('preferences.general.versionCopyFailed'));
    }
  };

  const checkingUpdates = updater.status === 'checking';
  const downloadingUpdate = updater.status === 'downloading';
  const installingUpdate = updater.status === 'installing';
  const updatingProduct = downloadingUpdate || installingUpdate;
  const downloadPercent = updater.progress?.phase === 'progress' && updater.progress.contentLength
    ? Math.min(100, Math.round((updater.progress.downloadedBytes / updater.progress.contentLength) * 100))
    : null;

  return (
    <div className="space-y-6">
      <SectionHeader title={t('preferences.general.title')} />

      <FieldRow
        title={t('preferences.general.language.title')}
        controlId="preferences-language"
      >
        <Select
          value={language}
          onValueChange={(value) => updateSettings({ language: value as AppLanguage })}
        >
          <SelectTrigger id="preferences-language" className="w-40">
            <span>{currentLanguageLabel}</span>
          </SelectTrigger>
          <SelectContent className="flowix-preferences-select-content">
            {LANGUAGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      {afterGeneral}

      <SectionHeader title={t('preferences.general.about')} />

      <FieldRow title={t('preferences.general.currentVersion')}>
        <div className="flex min-w-0 items-center gap-1">
          <span
            className="max-w-[420px] truncate text-right text-sm text-[var(--muted-foreground)]"
            title={currentVersionText}
          >
            {currentVersionText}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0"
            aria-label={versionCopied ? t('preferences.general.versionCopied') : t('preferences.general.copyVersion')}
            title={versionCopied ? t('preferences.general.versionCopied') : t('preferences.general.copyVersion')}
            disabled={!productInfo}
            onClick={() => void handleCopyVersion()}
          >
            {versionCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
      </FieldRow>

      <FieldRow
        title={t('preferences.general.productUpdates.title')}
      >
        <Button
          variant="outline"
          className="px-3"
          onClick={() => void manualUpdateCheck.checkNow()}
          disabled={checkingUpdates || updatingProduct}
        >
          {checkingUpdates
            ? t('preferences.general.productUpdates.checking')
            : t('preferences.general.productUpdates.check')}
        </Button>
      </FieldRow>

      {updater.update && (updatingProduct || updater.status === 'ready' || updater.error != null) && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className={FIELD_TITLE_CLASS}>
                {t('appUpdates.available', { version: updater.update.version.replace(/^v/i, '') })}
              </div>
              {updater.update.body && (
                <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm leading-5 text-[var(--muted-foreground)]">
                  {updater.update.body}
                </p>
              )}
              {updater.error != null && !updatingProduct && (
                <p role="alert" className="mt-2 text-sm text-[var(--destructive)]">
                  {t(updater.status === 'ready' ? 'appUpdates.installFailed' : 'appUpdates.downloadFailed')}
                </p>
              )}
              {updatingProduct && updater.progress && (
                <UpdateProgress
                  className="mt-3"
                  value={{
                    percent: downloadPercent,
                    downloadedBytes: updater.progress.phase === 'progress' ? updater.progress.downloadedBytes : undefined,
                    totalBytes: updater.progress.phase === 'progress' ? updater.progress.contentLength : undefined,
                  }}
                  label={t(downloadingUpdate ? 'appUpdates.downloading' : 'appUpdates.installing')}
                />
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={handleInstallUpdate}
              disabled={checkingUpdates || updatingProduct}
            >
              {downloadingUpdate ? t('appUpdates.downloading') : installingUpdate ? t('appUpdates.installing') : t(updater.status === 'ready' ? 'appUpdates.install' : 'appUpdates.download')}
            </Button>
          </div>
        </div>
      )}

      <AppUpdatePromptDialog
        open={manualUpdateCheck.promptOpen}
        update={updater.update}
        onOpenChange={manualUpdateCheck.setPromptOpen}
        onDownload={() => void manualUpdateCheck.downloadNow()}
      />

    </div>
  );
}
