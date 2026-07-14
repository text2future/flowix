'use client';

import { useEffect, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { CheckSquareIcon, PushPin, StarFourIcon } from '@phosphor-icons/react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@shared/ui/select';
import { Textarea } from '@shared/ui/textarea';
import { Button } from '@shared/ui/button';
import { Tooltip } from '@shared/ui/tooltip';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { product, type ProductInfo, type ProductUpdateNotice } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  Field,
  FieldRow,
  SectionHeader,
  FIELD_INPUT_CLASS,
  FIELD_TITLE_CLASS,
} from '@features/preferences/sections/primitives';
import { LANGUAGE_OPTIONS, useI18n, type AppLanguage, type Region } from '@features/i18n';
import type { MemoCardVariant } from '@/lib/constants';

interface GeneralSectionProps {
  settings: {
    customInstruction: string;
    selectedTags: string[];
    responseLength: string;
    preferredLanguage: string;
  };
  language: AppLanguage;
  region: Region;
  memoCardVariant: MemoCardVariant;
  updateSettings: (updates: {
    personalize?: Partial<{
      customInstruction: string;
      selectedTags: string[];
      responseLength: string;
      preferredLanguage: string;
    }>;
    language?: AppLanguage;
    memoCardVariant?: MemoCardVariant;
    productUpdates?: Partial<{ lastCheckedAt: number }>;
  }) => Promise<void>;
}

function MemoCardVariantOption({
  variant,
  active,
  title,
  onSelect,
}: {
  variant: MemoCardVariant;
  active: boolean;
  title: string;
  onSelect: () => void;
}) {
  const isCompact = variant === 'compact';
  const previewTitle = 'Flowix release plan';
  const previewText = 'Review this week\'s scope, desktop app icon updates, and memo card display settings.';
  const previewTime = '2h ago';

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        'group relative min-w-0 rounded-xl border bg-[var(--card)] p-3 text-left transition-all',
        'hover:border-[color-mix(in_oklch,var(--primary)_60%,transparent)] hover:shadow-sm',
        active
          ? 'border-[var(--primary)] ring-2 ring-[color-mix(in_oklch,var(--primary)_28%,transparent)]'
          : 'border-[var(--border)]',
      )}
    >
      {active && (
        <span className="absolute right-2 top-2 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] ring-2 ring-[var(--card)]">
          <Check className="h-3 w-3" />
        </span>
      )}

      <div
        className={cn(
          'h-[128px] overflow-hidden rounded-lg border border-[var(--divider)] bg-[var(--background)]',
          isCompact ? 'p-2' : 'p-1',
        )}
      >
        {isCompact ? (
          <div className="space-y-1.5">
            {[
              {
                title: previewTitle,
                color: 'var(--memo-color-green)',
                selected: true,
                pinned: true,
                hasAgent: false,
                hasTodo: true,
              },
              {
                title: 'CLI setup notes',
                color: 'var(--memo-color-blue)',
                selected: false,
                pinned: false,
                hasAgent: true,
                hasTodo: false,
              },
              {
                title: 'Interface review',
                color: 'var(--memo-color-orange)',
                selected: false,
                pinned: false,
                hasAgent: false,
                hasTodo: true,
              },
            ].map(({ title: itemTitle, color, selected, pinned, hasAgent, hasTodo }) => (
              <div
                key={itemTitle}
                className={cn(
                  'flex h-8 min-w-0 items-center gap-1.5 rounded-xl px-3 py-2 transition-colors',
                  selected && 'bg-[var(--accent)]',
                )}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {hasAgent && (
                  <StarFourIcon className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" weight="regular" />
                )}
                {pinned && <PushPin weight="fill" className="h-3.5 w-3.5 shrink-0 text-[var(--foreground)]" />}
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--foreground)]">
                  {itemTitle}
                </span>
                {hasTodo && (
                  <CheckSquareIcon className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" weight="regular" />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="group relative rounded-lg px-1.5 py-1">
            <h3 className="mr-3 line-clamp-1 text-xs font-medium text-[var(--foreground)]">
              <span className="min-w-0">{previewTitle}</span>
            </h3>
            <div className="mt-1.5 h-8 w-[58px] overflow-hidden rounded-md bg-[var(--muted)]">
              <div className="h-full w-full bg-[color-mix(in_oklch,var(--muted-foreground)_16%,transparent)]" />
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-3.5 text-[var(--foreground)] opacity-50">
              {previewText}
            </p>
            <div className="flex w-full items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="inline-flex items-center rounded-[6px] border border-[var(--border)] px-1 py-0 text-xs text-[var(--muted-foreground)]">
                    #project
                  </span>
                  <span className="inline-flex items-center rounded-[6px] border border-[var(--border)] px-1 py-0 text-xs text-[var(--muted-foreground)]">
                    #design
                  </span>
                </div>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-[var(--muted-foreground)]">
                {previewTime}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="mt-2">
        <div className={FIELD_TITLE_CLASS}>{title}</div>
      </div>
    </button>
  );
}

export function GeneralSection({ settings, language, region, memoCardVariant, updateSettings }: GeneralSectionProps) {
  const { t } = useI18n();
  const customInstruction = useComposingValue(
    settings.customInstruction,
    (next) => updateSettings({ personalize: { customInstruction: next } }),
  );
  const [productInfo, setProductInfo] = useState<ProductInfo | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [manualNotice, setManualNotice] = useState<ProductUpdateNotice | null>(null);
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
    setCheckingUpdates(true);
    try {
      const notice = await product.checkUpdateNotice(language, region);
      setManualNotice(notice);
      await updateSettings({ productUpdates: { lastCheckedAt: Date.now() } });
      toast.info(
        notice
          ? t('preferences.general.productUpdates.found')
          : t('preferences.general.productUpdates.none'),
      );
    } catch {
      toast.error(t('preferences.general.productUpdates.failed'));
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleOpenNoticeLink = async () => {
    if (!manualNotice?.ctaUrl) return;
    try {
      await openUrl(manualNotice.ctaUrl);
    } catch {
      toast.error(t('productUpdates.openFailed'));
    }
  };

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
          <SelectContent>
            {LANGUAGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <Field
        title={t('preferences.general.memoCardVariant.title')}
        description={t('preferences.general.memoCardVariant.description')}
      >
        <div className="grid grid-cols-2 gap-3 pt-1">
          <MemoCardVariantOption
            variant="detailed"
            active={memoCardVariant === 'detailed'}
            title={t('preferences.general.memoCardVariant.detailed')}
            onSelect={() => updateSettings({ memoCardVariant: 'detailed' })}
          />
          <MemoCardVariantOption
            variant="compact"
            active={memoCardVariant === 'compact'}
            title={t('preferences.general.memoCardVariant.compact')}
            onSelect={() => updateSettings({ memoCardVariant: 'compact' })}
          />
        </div>
      </Field>

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
          <SelectContent>
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
          <SelectContent>
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
          disabled={checkingUpdates}
        >
          {checkingUpdates
            ? t('preferences.general.productUpdates.checking')
            : t('preferences.general.productUpdates.check')}
        </Button>
      </FieldRow>

      {manualNotice && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className={FIELD_TITLE_CLASS}>{manualNotice.title}</div>
              <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm leading-5 text-[var(--muted-foreground)]">
                {manualNotice.body}
              </p>
              {manualNotice.version && (
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {t('productUpdates.version', { version: manualNotice.version })}
                </p>
              )}
            </div>
            {manualNotice.ctaUrl && (
              <Button variant="outline" size="sm" onClick={handleOpenNoticeLink}>
                <ExternalLink className="w-3.5 h-3.5" />
                {t('status.upgrade')}
              </Button>
            )}
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
