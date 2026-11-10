'use client';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RotateCw } from 'lucide-react';
import { cloud, windows } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { refreshAgentModelCatalog } from '@features/agent/services/agent-catalog-service';
import { Button } from '@shared/ui/button';

function formatResetDate(value: number, language: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat(language, {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(value));
  const time = new Intl.DateTimeFormat(language, {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
  return { date, time };
}

export function PiCloudModelsSection({ authenticated }: { authenticated: boolean }) {
  const { t, language } = useI18n();
  const [monthlyBalance, setMonthlyBalance] = useState<number | null>(null);
  const [permanentBalance, setPermanentBalance] = useState<number | null>(null);
  const [monthlyExpiresAt, setMonthlyExpiresAt] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const balanceRequest = useRef(0);

  const refreshBalance = useCallback(async (notifyError = false) => {
    const request = ++balanceRequest.current;
    if (!authenticated) {
      setMonthlyBalance(null);
      setPermanentBalance(null);
      setMonthlyExpiresAt(null);
      setBalanceError(null);
      setBalanceLoading(false);
      return;
    }
    setBalanceLoading(true);
    try {
      const result = await cloud.getAiCreditBalance();
      if (request !== balanceRequest.current) return;
      setMonthlyBalance(result.monthlyBalanceMicrocredits / 1_000_000);
      setPermanentBalance(result.permanentBalanceMicrocredits / 1_000_000);
      setMonthlyExpiresAt(result.monthlyExpiresAt);
      setBalanceError(null);
    } catch (value) {
      if (request !== balanceRequest.current) return;
      const message = friendlyErrorMessage(value, t, 'errors.friendly.balanceLoad');
      setBalanceError(message);
      if (notifyError) toast.error(message);
    } finally {
      if (request === balanceRequest.current) setBalanceLoading(false);
    }
  }, [authenticated, t]);

  useEffect(() => {
    void refreshBalance();
    return () => { balanceRequest.current += 1; };
  }, [refreshBalance, t]);

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
          <div className="text-[var(--muted-foreground)]">{t('preferences.pi.cloudCreditsBalance')}</div>
          <div className="flex min-w-0 items-center justify-between gap-2 text-[var(--foreground)]" title={balanceError ?? undefined}>
            <div className="inline-flex min-w-0 items-center gap-0.5">
              <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{t('preferences.pi.cloudCreditsMonthly')} <span className="font-mono font-semibold">
                  {monthlyBalance === null
                    ? balanceLoading ? t('preferences.pi.cloudCreditsLoading') : t('preferences.pi.cloudCreditsUnavailable')
                    : monthlyBalance.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span></span>
                <span>{t('preferences.pi.cloudCreditsPermanent')} <span className="font-mono font-semibold">
                  {permanentBalance === null
                    ? balanceLoading ? t('preferences.pi.cloudCreditsLoading') : t('preferences.pi.cloudCreditsUnavailable')
                    : permanentBalance.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span></span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-full text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                aria-label={t('preferences.pi.cloudCreditsRefresh')}
                title={t('preferences.pi.cloudCreditsRefresh')}
                disabled={balanceLoading || modelCatalogLoading}
                onClick={() => void refreshBalanceAndModels()}
              >
                {(balanceLoading || modelCatalogLoading)
                  ? <Loader2 className="size-3 flowix-spin" aria-hidden="true" />
                  : <RotateCw className="size-3" aria-hidden="true" />}
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 rounded-lg px-2 text-xs"
              onClick={() => void windows.openPaymentDialogInMain('credits')}
            >
              {t('preferences.pi.cloudCreditsPurchase')}
            </Button>
          </div>
          <div className="text-[var(--muted-foreground)]">{t('preferences.pi.cloudCreditsResetDay')}</div>
          <div className="text-sm text-[var(--foreground)]">
            {monthlyExpiresAt === null
              ? balanceLoading ? t('preferences.pi.cloudCreditsLoading') : t('preferences.pi.cloudCreditsNoResetDate')
              : t('preferences.pi.cloudCreditsResetAt', formatResetDate(monthlyExpiresAt, language))}
          </div>
        </div>}
      </section>
    </div>
  );
}
