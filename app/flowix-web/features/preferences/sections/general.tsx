'use client';

import { useEffect, useState } from 'react';
import { useAppUpdater } from '@features/shell/hooks/use-app-updater';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@shared/ui/select';
import { Button } from '@shared/ui/button';
import { UpdateProgress } from '@shared/ui/update-progress';
import { Tooltip } from '@shared/ui/tooltip';
import { product, type ProductInfo } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import {
  FieldRow,
  SectionHeader,
  FIELD_TITLE_CLASS,
} from '@features/preferences/sections/primitives';
import { LANGUAGE_OPTIONS, useI18n, type AppLanguage } from '@/lib/i18n';

interface GeneralSectionProps {
  language: AppLanguage;
  showHiddenNotebookFiles: boolean;
  showNotebookAgentsFile: boolean;
  updateSettings: (updates: {
    language?: AppLanguage;
    showHiddenNotebookFiles?: boolean;
    showNotebookAgentsFile?: boolean;
    productUpdates?: Partial<{ lastCheckedAt: number }>;
  }) => Promise<void>;
}

export function GeneralSection({ language, showHiddenNotebookFiles, showNotebookAgentsFile, updateSettings }: GeneralSectionProps) {
  const { t } = useI18n();
  const [productInfo, setProductInfo] = useState<ProductInfo | null>(null);
  const updater = useAppUpdater();
  const currentLanguageLabel =
    LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ?? language;

  useEffect(() => {
    product.getInfo()
      .then(setProductInfo)
      .catch(() => setProductInfo(null));
  }, []);

  const handleOpenLogDir = async () => {
    try {
      await product.openLogDir();
    } catch {
      toast.error(t('preferences.general.runtimeLogs.openFailed'));
    }
  };

  const handleCheckProductUpdates = async () => {
    try {
      const update = await updater.checkNow();
      await updateSettings({ productUpdates: { lastCheckedAt: Date.now() } });
      toast.info(
        update
          ? t('preferences.general.productUpdates.found')
          : t('preferences.general.productUpdates.none'),
      );
    } catch {
      toast.error(t('preferences.general.productUpdates.failed'));
    }
  };

  const handleInstallUpdate = async () => {
    try {
      await updater.installNow();
    } catch {
      toast.error(t('appUpdates.installFailed'));
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
    <div className="space-y-6 pb-16">
      <SectionHeader title={t('preferences.general.title')} />

      <FieldRow
        title={t('preferences.general.language.title')}
      >
        <Select
          value={language}
          onValueChange={(value) => updateSettings({ language: value as AppLanguage })}
        >
          <SelectTrigger className="w-40">
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

      <FieldRow
        title={t('preferences.general.showNotebookAgentsFile.title')}
        description={t('preferences.general.showNotebookAgentsFile.description')}
      >
        <button
          type="button"
          role="switch"
          aria-checked={showNotebookAgentsFile}
          aria-label={t('preferences.general.showNotebookAgentsFile.title')}
          onClick={() => updateSettings({ showNotebookAgentsFile: !showNotebookAgentsFile })}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${showNotebookAgentsFile ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]'}`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${showNotebookAgentsFile ? 'translate-x-5' : 'translate-x-0'}`}
          />
        </button>
      </FieldRow>

      <FieldRow
        title={t('preferences.general.showHiddenNotebookFiles.title')}
        description={t('preferences.general.showHiddenNotebookFiles.description')}
      >
        <button
          type="button"
          role="switch"
          aria-checked={showHiddenNotebookFiles}
          aria-label={t('preferences.general.showHiddenNotebookFiles.title')}
          onClick={() => updateSettings({ showHiddenNotebookFiles: !showHiddenNotebookFiles })}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${showHiddenNotebookFiles ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]'}`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${showHiddenNotebookFiles ? 'translate-x-5' : 'translate-x-0'}`}
          />
        </button>
      </FieldRow>

      <SectionHeader title={t('preferences.general.about')} />

      <FieldRow title={t('preferences.general.currentVersion')}>
        <span
          className="max-w-[420px] truncate text-right text-sm text-[var(--muted-foreground)]"
          title={productInfo
            ? `${productInfo.productName} ${productInfo.version} / ${productInfo.os} ${productInfo.arch}`
            : t('preferences.general.loading')}
        >
          {productInfo
            ? `${productInfo.productName} ${productInfo.version} / ${productInfo.os} ${productInfo.arch}`
            : t('preferences.general.loading')}
        </span>
      </FieldRow>

      <FieldRow
        title={t('preferences.general.productUpdates.title')}
      >
        <Button
          variant="outline"
          className="px-3"
          onClick={handleCheckProductUpdates}
          disabled={checkingUpdates || updatingProduct}
        >
          {checkingUpdates
            ? t('preferences.general.productUpdates.checking')
            : t('preferences.general.productUpdates.check')}
        </Button>
      </FieldRow>

      {updater.update && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className={FIELD_TITLE_CLASS}>{t('appUpdates.available')}</div>
              {updater.update.body && (
                <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm leading-5 text-[var(--muted-foreground)]">
                  {updater.update.body}
                </p>
              )}
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                {t('productUpdates.version', { version: updater.update.version })}
              </p>
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
            <Button variant="outline" size="sm" onClick={handleInstallUpdate} disabled={updatingProduct}>
              {downloadingUpdate ? t('appUpdates.downloading') : installingUpdate ? t('appUpdates.installing') : t('appUpdates.install')}
            </Button>
          </div>
        </div>
      )}

      {import.meta.env.DEV && (
        <FieldRow
          title={t('preferences.general.runtimeLogs.title')}
          description={productInfo?.logDir ?? t('preferences.general.runtimeLogs.description')}
        >
          <Tooltip content={t('preferences.general.runtimeLogs.openFolder')}>
            <Button
              variant="outline"
              className="px-3"
              onClick={handleOpenLogDir}
            >
              {t('preferences.general.runtimeLogs.open')}
            </Button>
          </Tooltip>
        </FieldRow>
      )}
    </div>
  );
}
