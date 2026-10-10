'use client';

import type { CSSProperties } from 'react';
import { Check, Monitor } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { DEFAULT_THEME_ID, THEME_OPTIONS, sanitizeTheme, type ThemeId } from '@features/theme';
import { cn } from '@/lib/utils';
import { SectionHeader, FIELD_TITLE_CLASS, FIELD_DESC_CLASS } from '@features/preferences/sections/primitives';
import { useI18n } from '@/lib/i18n';

interface ThemeSectionProps {
  settings: { theme: ThemeId };
  updateSettings: (updates: Partial<{ theme: ThemeId }>) => Promise<void>;
}

const THEME_DISPLAY_ORDER: readonly ThemeId[] = ['system', 'rock', 'light', 'dark', 'ember'];

/**
 * 主题预览卡片。点击即应用; 当前激活卡片有强边框 + 右上角对勾。
 * 预览区根据主题画一个迷你窗口 (标题栏 + 内容区 + 主色按钮),
 * 让用户在不切换的情况下也能直观感受主题氛围。
 */
function ThemeCard({
  option,
  active,
  isDefault,
  onSelect,
}: {
  option: typeof THEME_OPTIONS[number];
  active: boolean;
  isDefault: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const { preview, id, labelKey, descriptionKey } = option;
  const previewStyle: CSSProperties & {
    '--theme-preview-surface': string;
    '--theme-preview-accent': string;
    '--theme-preview-primary': string;
  } = {
    '--theme-preview-surface': preview.surface,
    '--theme-preview-accent': preview.accent,
    '--theme-preview-primary': preview.primary,
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full rounded-[var(--radius)] border border-transparent bg-[var(--background)] p-1.5 text-left transition-colors',
        'hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]',
        active
          ? 'border-[var(--primary)]'
          : ''
      )}
    >
      {/* Selected check */}
      {active && (
        <span className="absolute top-2 right-2 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] ring ring-[var(--background)]">
          <Check className="h-3 w-3" />
        </span>
      )}

      {/* Preview mock window */}
      <div
        className="relative h-24 w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)]"
        style={previewStyle}
      >
        {id === 'system' ? (
          // 「跟随系统」用左浅右深的对角分割图直观示意
          <>
            <div
              className="theme-card__preview-system-split absolute inset-0"
            />
            <Monitor
              className="theme-card__preview-system-icon absolute top-1/2 left-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2"
            />
          </>
        ) : (
          <>
            {/* 标题栏 */}
            <div className="theme-card__preview-surface h-4 w-full border-b" />
            {/* 文本行 */}
            <div className="space-y-1.5 px-2 pt-2">
              <div className="theme-card__preview-accent h-1.5 w-3/4 rounded-full" />
              <div className="theme-card__preview-accent h-1.5 w-1/2 rounded-full" />
            </div>
            {/* 主色按钮 */}
            <div className="theme-card__preview-primary absolute bottom-2 left-2 h-3 w-8 rounded-md" />
          </>
        )}
      </div>

      <div className="mt-1 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <span className={cn(FIELD_TITLE_CLASS, 'text-xs pl-[0.5em]')}>{t(labelKey)}</span>
          {isDefault && (
            <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--muted-foreground)]">
              {t('preferences.theme.default')}
            </span>
          )}
        </div>
        <div className={cn(FIELD_DESC_CLASS, 'line-clamp-1 text-xs pl-[0.5em] pb-1')}>
          {t(descriptionKey)}
        </div>
      </div>
    </button>
  );
}

export function ThemeSection({ settings, updateSettings }: ThemeSectionProps) {
  const { t } = useI18n();
  const active = sanitizeTheme(settings.theme ?? DEFAULT_THEME_ID);
  const options = [...THEME_OPTIONS].sort(
    (left, right) => THEME_DISPLAY_ORDER.indexOf(left.id) - THEME_DISPLAY_ORDER.indexOf(right.id),
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-1">
        <SectionHeader
          title={t('preferences.theme.title')}
          size="field"
        />
        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {options.map((opt) => (
              <ThemeCard
                key={opt.id}
                option={opt}
                active={active === opt.id}
                isDefault={opt.id === DEFAULT_THEME_ID}
                onSelect={() => updateSettings({ theme: opt.id })}
              />
            ))}
          </div>

          <div className="flex justify-start">
            <Button
              variant="outline"
              className="px-3"
              onClick={() => updateSettings({ theme: DEFAULT_THEME_ID })}
            >
              {t('preferences.resetDefaults')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
