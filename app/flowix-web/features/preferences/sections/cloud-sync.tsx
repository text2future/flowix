'use client';

import { useCallback, useEffect, useState } from 'react';
import { Cloud } from 'lucide-react';

import googleLogo from '@/assets/google.svg';
import { errorMessage } from '@/lib/error-message';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { openUrl } from '@platform/tauri/opener';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import { subscribe } from '@platform/tauri/event-bus';
import {
  cloud,
  listenToCloudStateChanges,
  type CloudProduct,
  type CloudState,
} from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { cn } from '@/lib/utils';

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function CloudSyncSection() {
  const { t } = useI18n();
  const [state, setState] = useState<CloudState | null>(null);
  const [products, setProducts] = useState<CloudProduct[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [stateLoadError, setStateLoadError] = useState<string | null>(null);
  const [productsLoadError, setProductsLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStateLoadError(null);
    setProductsLoadError(null);
    const [stateResult, productsResult] = await Promise.allSettled([
      cloud.getState(),
      cloud.listProducts(),
    ]);

    if (stateResult.status === 'fulfilled') {
      setState(stateResult.value);
    } else {
      setStateLoadError(errorMessage(stateResult.reason));
    }

    if (productsResult.status === 'fulfilled') {
      setProducts(productsResult.value);
    } else {
      setProductsLoadError(errorMessage(productsResult.reason));
    }
  }, []);

  useEffect(() => {
    void load();
    const unlisten = listenToCloudStateChanges(setState);
    const onFocus = () => {
      if (!state?.authenticated) return;
      void cloud.refreshMembership()
        .then((membership) => setState((current) => current
          ? { ...current, membership }
          : current))
        .catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      unlisten();
      window.removeEventListener('focus', onFocus);
    };
  }, [load, state?.authenticated]);

  const run = async (task: () => Promise<CloudState>) => {
    setBusy(true);
    try {
      const next = await task();
      setState(next);
      setPassword('');
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const submitLegacyLogin = () => {
    if (!email.trim() || !password) return;
    void run(() => cloud.login(email.trim(), password));
  };

  const startGoogleSignIn = async () => {
    setBusy(true);
    try {
      await cloud.startGoogleSignIn();
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => subscribe<string>('cloud-google-auth-error', (message) => {
    toast.error(cloudSyncErrorMessage(message, t));
  }), [t]);

  if (!state) {
    return (
      <div className="space-y-4">
        <SectionHeader title={t('preferences.cloud.title')} />
        {stateLoadError ? (
          <p className="break-words text-sm text-[var(--destructive)]">
            {stateLoadError}
          </p>
        ) : (
          <div className="flex h-[100px] items-center justify-center text-center text-sm text-[var(--muted-foreground)]">
            {t('preferences.cloud.loading')}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8">
      <SectionHeader title={t('preferences.cloud.title')} />
      <p className="text-sm text-[var(--muted-foreground)]">
        {t('preferences.cloud.description')}
      </p>

      {!state.authenticated ? (
        <div className="space-y-4">
          <div id="cloud-email-login" className="space-y-3">
            <Input
              type="email"
              className="mx-auto h-10 w-[64%] rounded-lg bg-[var(--card)]"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t('preferences.cloud.email')}
              autoComplete="username"
            />
            <Input
              type="password"
              className="mx-auto h-10 w-[64%] rounded-lg bg-[var(--card)]"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitLegacyLogin();
              }}
              placeholder={t('preferences.cloud.password')}
              autoComplete="current-password"
            />
            <Button
              className="mx-auto flex h-10 w-[64%] rounded-lg"
              disabled={busy || !email.trim() || !password}
              onClick={submitLegacyLogin}
            >
              {busy
                ? t('preferences.cloud.working')
                : t('preferences.cloud.login')}
            </Button>
          </div>
          <div className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
            <span className="h-px flex-1 bg-[var(--border)]" />
            <span>{t('preferences.cloud.orContinueWith')}</span>
            <span className="h-px flex-1 bg-[var(--border)]" />
          </div>
          <Button
            variant="outline"
            className="mx-auto flex h-10 w-[64%] gap-2 rounded-lg bg-[var(--card)]"
            disabled={busy}
            onClick={() => void startGoogleSignIn()}
          >
            <img src={googleLogo} alt="" aria-hidden="true" className="h-4 w-4 object-contain" />
            {t('preferences.cloud.googleSignIn')}
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--muted)]">
                <Cloud className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {state.account?.user.displayName}
                </div>
                <div className="truncate text-xs text-[var(--muted-foreground)]">
                  {state.account?.user.email}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={busy}
                  onClick={() => void run(() => cloud.logout())}
                >
                  {t('preferences.cloud.logout')}
                </Button>
              </div>
            </div>

            <div className="space-y-3 border-t border-[var(--border)] pt-4">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium">{t('preferences.cloud.membership')}</div>
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-xs',
                  state.membership?.active
                    ? 'bg-emerald-500/15 text-emerald-600'
                    : 'bg-amber-500/15 text-amber-600',
                )}>
                  {state.membership?.active
                    ? t('preferences.cloud.active')
                    : t('preferences.cloud.inactive')}
                </span>
              </div>
              <div className="text-sm text-[var(--muted-foreground)]">
                {t('preferences.cloud.usage')}: {formatBytes(state.membership?.usedBytes ?? 0)}
                {' / '}
                {formatBytes(state.membership?.quotaBytes ?? 0)}
              </div>
              {state.membership?.expiresAt && (
                <div className="text-xs text-[var(--muted-foreground)]">
                  {t('preferences.cloud.expires')}:{' '}
                  {new Date(state.membership.expiresAt).toLocaleDateString()}
                </div>
              )}
            </div>
          </div>


          <div className="space-y-3">
            <div className="text-sm font-medium">{t('preferences.cloud.plans')}</div>
            {productsLoadError && (
              <p className="break-words text-sm text-[var(--destructive)]">
                {productsLoadError}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {products.map((product) => (
                <div
                  key={product.id}
                  className="flex min-h-40 flex-col justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 transition-colors hover:border-[var(--primary)]/40"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[var(--foreground)]">{product.name}</div>
                    <div className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-[var(--muted-foreground)]">
                      {product.description}
                    </div>
                    <div className="mt-3 text-lg font-semibold tabular-nums text-[var(--foreground)]">
                      {(product.price.amount / 100).toFixed(2)} {product.price.currency.toUpperCase()}
                    </div>
                  </div>
                  <Button
                    size="lg"
                    className="h-9 w-full rounded-lg"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void cloud.createCheckout(product.id)
                        .then((checkout) => openUrl(checkout.checkoutUrl))
                        .catch((error) => toast.error(errorMessage(error)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {t('preferences.cloud.buy')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
