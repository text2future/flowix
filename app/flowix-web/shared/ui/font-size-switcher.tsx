'use client';

import { Type } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export const FONT_SIZE_MODES = ['small', 'medium', 'large'] as const;
export type FontSizeMode = (typeof FONT_SIZE_MODES)[number];

export function FontSizeSwitcher({
  sizeMode,
  onSelect,
}: {
  sizeMode: FontSizeMode | null;
  onSelect: (mode: FontSizeMode) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="group flex h-7 w-full items-center gap-2 rounded-lg px-2 text-sm text-[var(--foreground)]">
      <Type aria-hidden="true" className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">{t('agent.chat.messageFontSize')}</div>
      <div className="flex shrink-0 gap-0.5" role="group" aria-label={t('agent.chat.messageFontSize')}>
        {FONT_SIZE_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={sizeMode === mode}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(mode);
            }}
            className={`h-6 min-w-7 rounded-md px-1 text-xs transition-colors ${sizeMode === mode ? 'font-semibold text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'}`}
          >
            {t(`agent.chat.messageFontSize.${mode}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
