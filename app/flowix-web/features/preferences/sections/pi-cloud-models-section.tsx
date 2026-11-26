'use client';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Crown, Loader2, RotateCw } from 'lucide-react';
import { cloud, windows, type CloudAiCreditState } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { refreshAgentModelCatalog } from '@features/agent/services/agent-catalog-service';
import { Button } from '@shared/ui/button';

function formatResetDate(value: number, language: string): { date: string; time: string } {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const date = ['year', 'month', 'day']
    .map((type) => dateParts.find((part) => part.type === type)?.value ?? '')
    .join('-');
  const time = new Intl.DateTimeFormat(language, {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
  return { date, time };
}

type AiMembershipStatus = 'active' | 'inactive' | 'unknown';

export function PiCloudModelsSection({
  authenticated,
  aiCredits,
  membershipStatus = 'unknown',
  membershipLoading = false,
  membershipRefreshing = false,
}: {
  authenticated: boolean;
  aiCredits?: CloudAiCreditState;
  membershipStatus?: AiMembershipStatus;
  membershipLoading?: boolean;
  membershipRefreshing?: boolean;
}) {
  const { t, language } = useI18n();
  const balance = aiCredits?.data;
  const balanceLoaded = Boolean(balance || aiCredits?.status === 'error');
  const totalBalance = balance ? balance.balanceMicrocredits / 1_000_000 : null;
  const monthlyBalance = balance ? balance.monthlyBalanceMicrocredits / 1_000_000 : null;
  const permanentBalance = balance ? balance.permanentBalanceMicrocredits / 1_000_000 : null;
  const monthlyExpiresAt = balance?.monthlyExpiresAt ?? null;
  const balanceError = aiCredits?.error ?? null;
  const balanceLoading = aiCredits?.status === 'refreshing';
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const lastBalanceRefreshAt = useRef(0);

  const refreshBalance = useCallback(async (notifyError = false) => {
    if (!authenticated) return;
    lastBalanceRefreshAt.current = Date.now();
    try {
      await cloud.getAiCreditBalance();
    } catch (value) {
      const message = friendlyErrorMessage(value, t, 'errors.friendly.balanceLoad');
      if (notifyError) toast.error(message);
    }
  }, [authenticated, t]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  useEffect(() => {
    if (!authenticated) return;
    const refreshIfStale = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastBalanceRefreshAt.current < 60_000) return;
      void refreshBalance();
    };
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => {
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', refreshIfStale);
    };
  }, [authenticated, refreshBalance]);

  const refreshBalanceAndModels = useCallback(async () => {
    setModelCatalogLoading(true);
    try {
      const refreshModels = async () => {
        await cloud.refreshPiModelProvider();
        await refreshAgentModelCatalog('pi');
      };
      const [, modelCatalogResult] = await Promise.allSettled([
        refreshBalance(true),
        refreshModels(),
      ]);
      if (modelCatalogResult.status === 'rejected') {
        toast.error(friendlyErrorMessage(modelCatalogResult.reason, t, 'errors.friendly.modelsRefresh'));
      }
    } finally {
      setModelCatalogLoading(false);
    }
  }, [refreshBalance, t]);

  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium text-[var(--foreground)]">{t('preferences.pi.cloudTitle')}</div>
      <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        {authenticated && <div className="grid grid-cols-[5em_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
          <div className="text-[var(--muted-foreground)]">{t('preferences.pi.cloudMembershipType')}</div>
          <div className="flex min-w-0 items-center gap-2">
            {membershipLoading ? (
              <span aria-hidden="true" className="h-[18px] w-16 animate-pulse rounded-md bg-[var(--muted)]" />
            ) : <span className={cn(
              'inline-flex items-center gap-0.5 rounded-md px-1 py-px text-xs',
              membershipStatus === 'active'
                ? 'border border-amber-500/40 bg-amber-100 text-amber-900 dark:border-amber-300/30 dark:bg-amber-950 dark:text-amber-200'
                : membershipStatus === 'inactive'
                  ? 'bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[var(--warning)]'
                  : 'bg-[var(--muted)] text-[var(--muted-foreground)]',
            )}>
              {membershipStatus === 'active' && <Crown className="size-3" aria-hidden="true" />}
              {t(membershipStatus === 'active'
                ? 'preferences.cloud.section.ai'
                : membershipStatus === 'inactive'
                  ? 'preferences.pi.cloudMembershipNotActive'
                  : 'preferences.pi.cloudMembershipUnknown')}
            </span>}
            {(membershipRefreshing || balanceLoading || modelCatalogLoading) && !membershipLoading && (
              <span className="flex items-center gap-1 whitespace-nowrap text-xs text-[var(--muted-foreground)]">
                <Loader2 className="size-3.5 flowix-spin" aria-hidden="true" />
                {t('preferences.cloud.membershipLoading')}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto h-7 shrink-0 rounded-lg px-2 text-xs"
              onClick={() => void windows.openPaymentDialogInMain('credits')}
            >
              {t('preferences.cloud.member.upgrade')}
            </Button>
          </div>
          <div className="self-start pt-0.5 text-[var(--muted-foreground)]">{t('preferences.pi.cloudCreditsBalance')}</div>
          <div className="min-w-0 text-[var(--foreground)]" title={balanceError ?? undefined}>
            <div className="flex min-w-0 flex-col items-start gap-0.5">
              <div className="flex min-w-0 items-center gap-1">
                <span className="font-mono text-sm leading-5 font-semibold">
                  {!balanceLoaded
                      ? <span aria-hidden="true" className="inline-block h-4 w-16 animate-pulse rounded bg-[var(--muted)] align-middle" />
                      : totalBalance === null
                        ? t('preferences.pi.cloudCreditsUnavailable')
                        : totalBalance.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)]',
                    'transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                  )}
                  aria-label={t('preferences.pi.cloudCreditsRefresh')}
                  title={t('preferences.pi.cloudCreditsRefresh')}
                  disabled={balanceLoading || modelCatalogLoading}
                  onClick={() => void refreshBalanceAndModels()}
                >
                  {(balanceLoading || modelCatalogLoading)
                    ? <Loader2 className="size-3 flowix-spin" aria-hidden="true" />
                    : <RotateCw className="size-3" aria-hidden="true" />}
                </button>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
                <span>{t('preferences.pi.cloudCreditsMonthly')} <span className="font-mono">
                  {!balanceLoaded
                      ? <span aria-hidden="true" className="inline-block h-3 w-12 animate-pulse rounded bg-[var(--muted)] align-middle" />
                      : monthlyBalance === null
                        ? t('preferences.pi.cloudCreditsUnavailable')
                        : monthlyBalance.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span></span>
                <span>{t('preferences.pi.cloudCreditsPermanent')} <span className="font-mono">
                  {!balanceLoaded
                      ? <span aria-hidden="true" className="inline-block h-3 w-12 animate-pulse rounded bg-[var(--muted)] align-middle" />
                      : permanentBalance === null
                        ? t('preferences.pi.cloudCreditsUnavailable')
                        : permanentBalance.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span></span>
              </div>
            </div>
          </div>
          <div className="text-[var(--muted-foreground)]">{t('preferences.pi.cloudCreditsResetDay')}</div>
          <div className="text-sm text-[var(--foreground)]">
            {!balanceLoaded
              ? <span aria-hidden="true" className="inline-block h-4 w-36 animate-pulse rounded bg-[var(--muted)] align-middle" />
              : balanceError && totalBalance === null
                ? t('preferences.pi.cloudCreditsUnavailable')
              : monthlyExpiresAt === null
                ? t('preferences.pi.cloudCreditsNoResetDate')
                : t('preferences.pi.cloudCreditsResetAt', formatResetDate(monthlyExpiresAt, language))}
          </div>
        </div>}
      </section>
    </div>
  );
}
