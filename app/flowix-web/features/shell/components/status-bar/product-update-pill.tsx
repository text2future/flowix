'use client';

import { useEffect, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { AlertTriangle, ArrowUp, CheckCircle2, Loader2 } from 'lucide-react';
import { useUserSettings } from '@features/preferences/hooks/use-user-settings';
import { useI18n } from '@features/i18n';
import { cn } from '@/lib/utils';
import { product, type ProductUpdateNotice } from '@platform/tauri/client';
import { toast } from '@/lib/toast';

const STARTUP_DELAY_MS = 7_000;

type Phase = 'hidden' | 'idle' | 'downloading' | 'ready' | 'error';

interface Progress {
  transferred: number;
  total: number;
}

/**
 * Status-bar indicator + 1-click in-app upgradability.
 *
 * Discovery: on startup, fetch the Supabase product_update_notices row to
 * decide whether the button should render. If yes, click → check the Tauri
 * updater for the actual binary, download it (with progress), install it,
 * then a second click restarts the app.
 *
 * Phase machine:
 *   hidden       — no remote notice targets this client (initial state)
 *   idle         — fetched notice says "you're behind" — pill is clickable
 *   downloading  — clicked → updater downloading; pill shows % progress
 *   ready        — staged successfully; click again to relaunch
 *   error        — fetch failed / signature invalid / network blip
 *
 * The fetched notice's `title`/`body` are intentionally ignored — the pill
 * is binary: "is there an updater-served release?". ctaUrl is preserved
 * in DB but unused by this pill; updater endpoints live in tauri.conf.
 */
export function ProductUpdatePill() {
  const { t } = useI18n();
  const { settings, isLoading } = useUserSettings();
  const [phase, setPhase] = useState<Phase>('hidden');
  const [progress, setProgress] = useState<Progress>({ transferred: 0, total: 0 });

  // Visibility: only show when there's a remote notice targeting this client.
  useEffect(() => {
    if (isLoading || !settings.productUpdates.enabled) return;
    if (window.location.hash.startsWith('#preferences') || window.location.hash.startsWith('#note-window')) {
      return;
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const notice: ProductUpdateNotice | null = await product.checkUpdateNotice(
            settings.language,
            settings.region,
          );
          if (notice) setPhase('idle');
          // else stay hidden
        } catch {
          // leave hidden; retry on next launch
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
    if (phase === 'downloading') return;
    if (phase === 'ready') {
      await relaunch();
      return;
    }
    try {
      const update: Update | null = await check();
      if (!update) {
        toast.info(t('status.upgradeNoUpdate'));
        return;
      }
      setPhase('downloading');
      let transferred = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        // plugin-updater 的 DownloadEvent 是分类型判别联合:
        //   Started   → data.contentLength (可选)
        //   Progress  → data.chunkLength   (当前这一块的字节数, 不是累计)
        //   Finished  → 无 data
        // 累计得自己加; 不能直接用 event.data.transferred。
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
          setProgress({ transferred, total });
        } else if (event.event === 'Progress') {
          transferred += event.data.chunkLength;
          setProgress({ transferred, total });
        }
      });
      setPhase('ready');
    } catch (err) {
      console.error('update failed', err);
      setPhase('error');
    }
  }

  if (phase === 'hidden') return null;

  const disabled = phase === 'downloading';
  const label =
    phase === 'downloading'
      ? progress.total > 0
        ? `${Math.round((progress.transferred / progress.total) * 100)}%`
        : t('status.upgradeDownloading')
      : phase === 'ready'
        ? t('status.upgradeReady')
        : phase === 'error'
          ? t('status.upgradeRetry')
          : t('status.upgrade');

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={label}
      className={cn(
        'inline-flex h-[22px] items-center gap-0.5 rounded-md px-2',
        'bg-[var(--info)] text-[var(--info-foreground)]',
        'hover:opacity-90 active:opacity-80',
        'disabled:cursor-wait disabled:opacity-80',
        'text-xs leading-none font-medium',
      )}
      aria-label={label}
    >
      {phase === 'downloading' ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : phase === 'ready' ? (
        <CheckCircle2 className="h-3 w-3 shrink-0" />
      ) : phase === 'error' ? (
        <AlertTriangle className="h-3 w-3 shrink-0" />
      ) : (
        <ArrowUp className="h-3 w-3 shrink-0" />
      )}
      <span>{label}</span>
    </button>
  );
}
