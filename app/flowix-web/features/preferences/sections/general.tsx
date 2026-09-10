'use client';

import { useEffect, useState } from 'react';
import { useAppUpdater } from '@features/shell/hooks/use-app-updater';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@shared/ui/select';
import { Textarea } from '@shared/ui/textarea';
import { Button } from '@shared/ui/button';
import { UpdateProgress } from '@shared/ui/update-progress';
import { Tooltip } from '@shared/ui/tooltip';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { product, type ProductInfo } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  Field,
  FieldRow,
  SectionHeader,
  FIELD_INPUT_CLASS,
  FIELD_TITLE_CLASS,
} from '@features/preferences/sections/primitives';
import { LANGUAGE_OPTIONS, useI18n, type AppLanguage, type Region } from '@/lib/i18n';

interface GeneralSectionProps {
  settings: {
    customInstruction: string;
    selectedTags: string[];
    responseLength: string;
    preferredLanguage: string;
    showConversationEntry: boolean;
  };
  language: AppLanguage;
  region: Region;
  updateSettings: (updates: {
    personalize?: Partial<{
      customInstruction: string;
      selectedTags: string[];
      responseLength: string;
      preferredLanguage: string;
      showConversationEntry: boolean;
    }>;
    language?: AppLanguage;
    productUpdates?: Partial<{ lastCheckedAt: number }>;
  }) => Promise<void>;
}

export function GeneralSection({ settings, language, updateSettings }: GeneralSectionProps) {
  const { t } = useI18n();
  const customInstruction = useComposingValue(
    settings.customInstruction,
    (next) => updateSettings({ personalize: { customInstruction: next } }),
  );
  const [productInfo, setProductInfo] = useState<ProductInfo | null>(null);
  const updater = useAppUpdater();
  const currentLanguageLabel =
    LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ?? language;
  const responseLengthLabelByValue: Record<string, string> = {
    concise: t('preferences.general.responseLength.concise'),
    standard: t('preferences.general.responseLength.standard'),
    detailed: t('preferences.general.responseLength.detailed'),
  };
  const preferredLanguageLabelByValue: Record<string, string> = {
    'Simplified Chinese': t('language.zhCN'),
    English: t('language.enUS'),
  };
  const currentResponseLengthLabel =
    responseLengthLabelByValue[settings.responseLength] ?? settings.responseLength;
  const currentPreferredLanguageLabel =
    preferredLanguageLabelByValue[settings.preferredLanguage] ?? settings.preferredLanguage;

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
        description={t('preferences.general.language.description')}
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

      <FieldRow title={t('preferences.general.showConversationEntry.title')}>
        <button
          type="button"
          role="switch"
          aria-checked={settings.showConversationEntry}
          aria-label={t('preferences.general.showConversationEntry.title')}
          onClick={() => updateSettings({
            personalize: { showConversationEntry: !settings.showConversationEntry },
          })}
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors',
            settings.showConversationEntry ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
              settings.showConversationEntry ? 'translate-x-5' : 'translate-x-0',
            )}
          />
        </button>
      </FieldRow>

      <SectionHeader title={t('preferences.general.personalization')} />

      <Field
        title={t('preferences.general.customInstructions.title')}
        description={t('preferences.general.customInstructions.description')}
      >
        <Textarea
          value={customInstruction.value}
          onChange={customInstruction.onChange}
          onCompositionStart={customInstruction.onCompositionStart}
          onCompositionEnd={customInstruction.onCompositionEnd}
          placeholder={t('preferences.general.customInstructions.placeholder')}
          className={FIELD_INPUT_CLASS}
        />
      </Field>

      <FieldRow
        title={t('preferences.general.responseLength.title')}
        description={t('preferences.general.responseLength.description')}
      >
        <Select
          value={settings.responseLength}
          onValueChange={(value) => updateSettings({ personalize: { responseLength: value } })}
        >
          <SelectTrigger className="w-32">
            <span>{currentResponseLengthLabel}</span>
          </SelectTrigger>
          <SelectContent className="flowix-preferences-select-content">
            <SelectItem value="concise">{t('preferences.general.responseLength.concise')}</SelectItem>
            <SelectItem value="standard">{t('preferences.general.responseLength.standard')}</SelectItem>
            <SelectItem value="detailed">{t('preferences.general.responseLength.detailed')}</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow
        title={t('preferences.general.preferredLanguage.title')}
        description={t('preferences.general.preferredLanguage.description')}
      >
        <Select
          value={settings.preferredLanguage}
          onValueChange={(value) => updateSettings({ personalize: { preferredLanguage: value } })}
        >
          <SelectTrigger className="w-40">
            <span>{currentPreferredLanguageLabel}</span>
          </SelectTrigger>
          <SelectContent className="flowix-preferences-select-content">
            <SelectItem value="Simplified Chinese">{t('language.zhCN')}</SelectItem>
            <SelectItem value="English">{t('language.enUS')}</SelectItem>
          </SelectContent>
        </Select>
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
        description={t('preferences.general.productUpdates.description')}
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
