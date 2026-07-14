'use client';

import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ArrowUp } from 'lucide-react';
import { useUserSettings } from '@features/preferences/hooks/use-user-settings';
import { useI18n } from '@features/i18n';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { product, type ProductUpdateNotice } from '@platform/tauri/client';

const STARTUP_DELAY_MS = 7_000;

/**
 * Status-bar update notice.
 *
 * Supabase owns targeting: enabled flag, published_at, platform and version
 * comparison. The client only renders a compact CTA when the backend returns
 * an actionable notice.
 */
export function ProductUpdatePill() {
  const { t } = useI18n();
  const { settings, isLoading } = useUserSettings();
  const [notice, setNotice] = useState<ProductUpdateNotice | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  useEffect(() => {
    if (isLoading || !settings.productUpdates.enabled) return;
    if (window.location.hash.startsWith('#preferences') || window.location.hash.startsWith('#note-window')) {
      return;
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          setNotice(await product.checkUpdateNotice(settings.language, settings.region));
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn('[ProductUpdatePill] update check failed', error);
          }
        }
      })();
    }, STARTUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    isLoading,
    settings.productUpdates.enabled,
    settings.language,
    settings.region,
  ]);

  async function handleClick() {
    if (!notice || isOpening) return;
    if (!notice.ctaUrl) {
      toast.info(notice.version ? t('productUpdates.version', { version: notice.version }) : notice.title);
      return;
    }
    setIsOpening(true);
    try {
      await openUrl(notice.ctaUrl);
    } catch {
      toast.error(t('productUpdates.openFailed'));
    } finally {
      setIsOpening(false);
    }
  }

  if (!notice) return null;

  const label = t('status.upgrade');

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isOpening}
      title={notice.version ? `${label} ${notice.version}` : label}
      className={cn(
        'inline-flex h-[22px] items-center gap-0.5 rounded-md px-2',
        'bg-[var(--info)] text-[var(--info-foreground)]',
        'hover:opacity-90 active:opacity-80',
        'disabled:cursor-wait disabled:opacity-80',
        'text-xs leading-none font-medium',
      )}
      aria-label={label}
    >
      <ArrowUp className="h-3 w-3 shrink-0" />
      <span>{label}</span>
    </button>
  );
}
