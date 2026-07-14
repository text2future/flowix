'use client';

import { SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n } from '@features/i18n';

export function HistorySection() {
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t('preferences.history.title')}
      />
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.history.empty')}</p>
      </div>
    </div>
  );
}
