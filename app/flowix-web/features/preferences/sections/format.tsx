'use client';

import { useEffect, useState } from 'react';
import { Button } from '@shared/ui/button';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@shared/ui/select';
import {
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_STEP,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_STEP,
  DOCUMENT_WIDTH_MIN,
  DOCUMENT_WIDTH_MAX,
  DOCUMENT_WIDTH_STEP,
  DEFAULT_USER_SETTINGS,
} from '@/lib/constants';
import { FieldRow, SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n } from '@features/i18n';
import { toast } from '@/lib/toast';
import {
  ensureDownloadedFontRegistered,
  getDownloadedFontStatus,
  getFontOptionById,
  getFontOptionByValue,
  isDownloadableFont,
} from '@features/preferences/font-cache';

interface FormatSectionProps {
  settings: {
    fontFamily: string;
    fontId?: string;
    fontSize: number;
    lineHeight: number;
    documentWidth: number;
  };
  updateSettings: (updates: {
    format?: Partial<{
      fontFamily: string;
      fontId?: string;
      fontSize: number;
      lineHeight: number;
      documentWidth: number;
    }>;
  }) => Promise<void>;
}

/**
 * Native range slider styled to match the rest of the Preferences UI.
 *
 * Track is a single linear-gradient: filled (--primary) up to the
 * current value, then a darker neutral (#cbd5e1) for the unfilled
 * remainder. Bound to a numeric setting; updates fire on every change
 * for live preview. Used inside a FieldRow; container is fixed-width
 * so the slider doesn't stretch across the full preferences content area.
 */
function SliderRow({
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  formatValue?: (v: number) => string;
}) {
  const display = formatValue ? formatValue(value) : String(value);
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="flex w-64 items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--primary)]"
        style={{
          background: `linear-gradient(to right, var(--primary) 0%, var(--primary) ${percent}%, #cbd5e1 ${percent}%, #cbd5e1 100%)`,
        }}
      />
      <span className="w-12 text-right text-sm tabular-nums text-[var(--muted-foreground)]">
        {display}
      </span>
    </div>
  );
}

export function FormatSection({ settings, updateSettings }: FormatSectionProps) {
  const { t } = useI18n();
  const [fontCacheStatus, setFontCacheStatus] = useState<Record<string, boolean>>({});
  const [loadingFontId, setLoadingFontId] = useState<string | null>(null);
  // Find the label for the currently active font; fall back to its raw stack
  // so a previously-saved unknown font still surfaces in the trigger.
  const currentFont = getFontOptionById(settings.fontId) ?? getFontOptionByValue(settings.fontFamily);
  const fontLabel = currentFont?.label ?? settings.fontFamily;
  const selectValue = currentFont?.id ?? settings.fontFamily;

  useEffect(() => {
    getDownloadedFontStatus().then(setFontCacheStatus);
  }, []);

  async function handleFontChange(fontId: string) {
    const font = getFontOptionById(fontId);
    if (!font) {
      await updateSettings({ format: { fontFamily: fontId, fontId: undefined } });
      return;
    }
    if (isDownloadableFont(font) && !fontCacheStatus[font.id]) {
      setLoadingFontId(font.id);
      try {
        await ensureDownloadedFontRegistered(font.id);
        setFontCacheStatus((status) => ({ ...status, [font.id]: true }));
        toast.success(t('preferences.format.fontDownloaded'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(t('preferences.format.fontDownloadFailed', { message }));
        return;
      } finally {
        setLoadingFontId(null);
      }
    } else if (isDownloadableFont(font)) {
      await ensureDownloadedFontRegistered(font.id).catch((error) => {
        console.warn('Failed to register cached font:', error);
      });
    }
    await updateSettings({ format: { fontFamily: font.value, fontId: font.id } });
  }

  return (
    <div className="space-y-6 pb-16">
      <SectionHeader
        title={t('preferences.format.title')}
      />

      {/* Live preview — label sits as a chip at the top-left inside
          the frame. The font styles are scoped to an inner wrapper so
          the chip itself doesn't resize with the preview controls. */}
      <div className="relative rounded-lg border border-[var(--border)] bg-[var(--document-bg)]">
        <span className="absolute top-2 left-2 px-1.5 py-0.5 text-[10px] font-medium leading-none bg-[var(--muted)] text-[var(--muted-foreground)] rounded select-none">
          {t('preferences.format.preview')}
        </span>
        <div
          className="p-4 pt-7 text-[var(--foreground)]"
          style={{
            fontFamily: settings.fontFamily,
            fontSize: `${settings.fontSize}px`,
            lineHeight: settings.lineHeight,
          }}
        >
          <p className="m-0">
            The quick brown fox jumps over the lazy dog.
          </p>
          <p className="m-0 mt-2">
            {t('preferences.format.previewText')}
          </p>
        </div>
      </div>

      {/* Font Family */}
      <FieldRow
        title={t('preferences.format.font.title')}
        description={t('preferences.format.font.description')}
      >
        <Select
          value={selectValue}
          onValueChange={(value) => { void handleFontChange(value); }}
        >
          <SelectTrigger className="w-72">
            <span
              className="flex-1 text-left"
              style={{ fontFamily: settings.fontFamily }}
            >
              {loadingFontId === currentFont?.id ? t('preferences.format.downloading') : fontLabel}
            </span>
          </SelectTrigger>
          <SelectContent align="end" className="w-72">
            {FONT_FAMILY_OPTIONS.map((font) => (
              <SelectItem key={font.id} value={font.id}>
                <span className="flex w-full items-center justify-between gap-3" style={{ fontFamily: font.value }}>
                  <span>{font.label}</span>
                  {font.source === 'downloadable' && (
                    <span className="text-[10px] text-[var(--muted-foreground)]">
                      {loadingFontId === font.id
                        ? t('preferences.format.fontStatus.downloading')
                        : fontCacheStatus[font.id]
                          ? t('preferences.format.fontStatus.downloaded')
                          : t('preferences.format.fontStatus.needsDownload')}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      {/* Document Width — 放在字号上方, 让用户先决定"页面多宽"再决定"字多大" */}
      <FieldRow
        title={t('preferences.format.documentWidth.title')}
        description={t('preferences.format.documentWidth.description')}
      >
        <SliderRow
          value={settings.documentWidth}
          min={DOCUMENT_WIDTH_MIN}
          max={DOCUMENT_WIDTH_MAX}
          step={DOCUMENT_WIDTH_STEP}
          onChange={(v) => updateSettings({ format: { documentWidth: v } })}
          formatValue={(v) => `${v}px`}
        />
      </FieldRow>

      {/* Font Size */}
      <FieldRow
        title={t('preferences.format.fontSize.title')}
        description={t('preferences.format.fontSize.description')}
      >
        <SliderRow
          value={settings.fontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={FONT_SIZE_STEP}
          onChange={(v) => updateSettings({ format: { fontSize: v } })}
          formatValue={(v) => `${v}px`}
        />
      </FieldRow>

      {/* Line Height */}
      <FieldRow
        title={t('preferences.format.lineHeight.title')}
        description={t('preferences.format.lineHeight.description')}
      >
        <SliderRow
          value={settings.lineHeight}
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={LINE_HEIGHT_STEP}
          onChange={(v) => updateSettings({ format: { lineHeight: v } })}
          formatValue={(v) => v.toFixed(2)}
        />
      </FieldRow>

      {/* Reset */}
      <div className="flex justify-start">
        <Button
          variant="outline"
          className="px-3"
          onClick={() =>
            updateSettings({
              format: {
                fontFamily: DEFAULT_USER_SETTINGS.format.fontFamily,
                fontId: DEFAULT_USER_SETTINGS.format.fontId,
                fontSize: DEFAULT_USER_SETTINGS.format.fontSize,
                lineHeight: DEFAULT_USER_SETTINGS.format.lineHeight,
                documentWidth: DEFAULT_USER_SETTINGS.format.documentWidth,
              },
            })
          }
        >
          {t('preferences.resetDefaults')}
        </Button>
      </div>
    </div>
  );
}
