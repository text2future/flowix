'use client';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { consumeAccountRestoreNotice } from '@/lib/cloud-account';

import { useEffect, useState } from 'react';
import { Ellipsis, Loader2 } from 'lucide-react';

import googleLogo from '@/assets/google.svg';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { openUrl } from '@platform/tauri/opener';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import { subscribe } from '@platform/tauri/event-bus';
import {
  cloud,
  dialogs,
  type CloudOrder,
  type CloudSubscription,
  type CloudState,
  windows,
} from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Tooltip } from '@shared/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useCloudAccountState } from '@features/preferences/hooks/use-cloud-account-state';
import { DeleteAccountDialog } from '@features/preferences/sections/delete-account-dialog';
import { PiCloudModelsSection } from '@features/preferences/sections/pi-cloud-models-section';
import { useMembershipAccess } from '@features/preferences/public/membership';

function formatStorageCapacity(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let capacity = value;
  let unitIndex = 0;
  while (capacity >= 1024 && unitIndex < units.length - 1) {
    capacity /= 1024;
    unitIndex += 1;
  }
  const formatted = Number.isInteger(capacity) ? String(capacity) : capacity.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

function formatMembershipBytes(value: number): string {
  return value === 0 ? '0 MB' : formatStorageCapacity(value);
}

function formatMembershipDate(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function CloudSyncSection() {
  const { t } = useI18n();
  const { state, loadError: stateLoadError, loading: loadingLoginState, applyState, membershipLoading, membershipError, refreshMembership } = useCloudAccountState();
  const [busy, setBusy] = useState(false);
  const [activeAccountSection, setActiveAccountSection] = useState<'ai' | 'storage'>('ai');
  const [orders, setOrders] = useState<CloudOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersLoadError, setOrdersLoadError] = useState<string | null>(null);
  const [ordersDialogOpen, setOrdersDialogOpen] = useState(false);
  const [deleteAccountDialogOpen, setDeleteAccountDialogOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [subscriptions, setSubscriptions] = useState<CloudSubscription[]>([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  const [subscriptionsLoadError, setSubscriptionsLoadError] = useState<string | null>(null);
  const [cancelingSubscriptionId, setCancelingSubscriptionId] = useState<string | null>(null);
  const [checkingOrderId, setCheckingOrderId] = useState<string | null>(null);
  const [orderCheckFailedId, setOrderCheckFailedId] = useState<string | null>(null);
  const [resumingOrderId, setResumingOrderId] = useState<string | null>(null);

  const storageExpiresAt = state?.membership?.storageExpiresAt ?? state?.membership?.expiresAt;
  const { active: hasMembership, lifetime: hasLifetimeMembership, loading: memberAccessLoading } = useMembershipAccess();
  const annualMembershipSubscription = subscriptions.find((subscription) =>
    subscription.isAnnualMembership
      && ['active', 'trialing', 'past_due'].includes(subscription.status)
  ) ?? null;

  const loadOrders = async () => {
    if (!state?.authenticated) {
      setOrders([]);
      setOrdersLoadError(null);
      return;
    }
    setOrdersLoading(true);
    setOrdersLoadError(null);
    try {
      setOrders(await cloud.listBillingOrders());
    } catch (error) {
      setOrdersLoadError(friendlyErrorMessage(error, t, 'errors.friendly.ordersLoad'));
    } finally {
      setOrdersLoading(false);
    }
  };

  const loadSubscriptions = async () => {
    if (!state?.authenticated) {
      setSubscriptions([]);
      setSubscriptionsLoadError(null);
      return;
    }
    setSubscriptionsLoading(true);
    setSubscriptionsLoadError(null);
    try {
      setSubscriptions(await cloud.listSubscriptions());
    } catch (error) {
      setSubscriptionsLoadError(friendlyErrorMessage(error, t, 'errors.friendly.subscriptionLoad'));
    } finally {
      setSubscriptionsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (!state?.authenticated) {
      setOrders([]);
      setOrdersLoadError(null);
      setOrdersLoading(false);
      setOrdersDialogOpen(false);
      return () => { active = false; };
    }
    if (!ordersDialogOpen) return () => { active = false; };
    setOrdersLoading(true);
    setOrdersLoadError(null);
    void cloud.listBillingOrders().then((next) => {
      if (active) setOrders(next);
    }).catch((error) => {
      if (active) setOrdersLoadError(friendlyErrorMessage(error, t, 'errors.friendly.ordersLoad'));
    }).finally(() => {
      if (active) setOrdersLoading(false);
    });
    return () => { active = false; };
  }, [state?.authenticated, state?.account?.user.id, ordersDialogOpen, t]);

  useEffect(() => {
    let active = true;
    if (!state?.authenticated) {
      setSubscriptions([]);
      setSubscriptionsLoadError(null);
      return () => { active = false; };
    }
    setSubscriptionsLoading(true);
    setSubscriptionsLoadError(null);
    void cloud.listSubscriptions().then((next) => {
      if (active) setSubscriptions(next);
    }).catch((error) => {
      if (active) setSubscriptionsLoadError(friendlyErrorMessage(error, t, 'errors.friendly.subscriptionLoad'));
    }).finally(() => {
      if (active) setSubscriptionsLoading(false);
    });
    return () => { active = false; };
  }, [state?.authenticated, state?.account?.user.id]);

  const checkOrder = async (orderId: string) => {
    setCheckingOrderId(orderId);
    setOrderCheckFailedId(null);
    try {
      const result = await cloud.checkBillingOrder(orderId);
      await loadOrders();
      if (result.confirmed) {
        const refreshResult = await refreshMembership();
        if (refreshResult === 'refreshed') {
          toast.success(t('preferences.cloud.order.confirmed'));
        } else if (refreshResult === 'failed') {
          toast.error(t('preferences.cloud.order.refreshFailed'));
        }
      } else if (result.checkStatus === 'pending') {
        toast.info(t('preferences.cloud.order.notConfirmed'));
      } else if (result.checkStatus === 'processing') {
        toast.info(t('preferences.cloud.order.processing'));
      } else if (result.checkStatus === 'failed') {
        setOrderCheckFailedId(orderId);
        toast.error(t('preferences.cloud.order.syncFailed'));
      } else if (['unsupported', 'dead_letter'].includes(result.checkStatus)) {
        toast.error(t('preferences.cloud.order.needsReview'));
      } else if (result.checkStatus === 'unavailable') {
        toast.error(t('preferences.cloud.order.unavailable'));
      } else if (result.checkStatus === 'refunded') {
        toast.info(t('preferences.cloud.order.refunded'));
      } else {
        toast.error(t('preferences.cloud.order.unknownResult'));
      }
    } catch (error) {
      setOrderCheckFailedId(orderId);
      toast.error(cloudSyncErrorMessage(error, t, 'errors.friendly.orderCheck'));
    } finally {
      setCheckingOrderId(null);
    }
  };

  const resumeCheckout = async (order: CloudOrder) => {
    setResumingOrderId(order.id);
    try {
      const checkout = await cloud.createCheckout(order.productId);
      await openUrl(checkout.checkoutUrl);
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t, 'errors.friendly.checkout'));
    } finally {
      await loadOrders();
      setResumingOrderId(null);
    }
  };

  const cancelAnnualSubscription = async (subscription: CloudSubscription) => {
    if (!window.confirm(t('preferences.cloud.subscription.cancelConfirm'))) return;
    setCancelingSubscriptionId(subscription.id);
    try {
      await cloud.cancelSubscription(subscription.id);
      toast.success(t('preferences.cloud.subscription.cancelSuccess'));
      await loadSubscriptions();
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t, 'errors.friendly.subscriptionCancel'));
    } finally {
      setCancelingSubscriptionId(null);
    }
  };

  const run = async (task: () => Promise<CloudState>) => {
    setBusy(true);
    try {
      const next = await task();
      applyState(next);
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const copyAccountId = async () => {
    const accountId = state?.account?.user.id;
    if (!accountId) return;
    try {
      await navigator.clipboard.writeText(accountId);
      toast.success(t('preferences.cloud.accountIdCopied'));
    } catch {
      toast.error(t('preferences.cloud.accountIdCopyFailed'));
    }
  };

  const exportAccountData = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const document = await cloud.exportAccount();
      const stamp = new Date().toISOString().slice(0, 10);
      const target = await dialogs.saveFile(`flowix-account-${stamp}.json`, [
        { name: 'JSON', extensions: ['json'] },
      ]);
      if (!target) return;
      const written = await dialogs.writeExportFile(target, JSON.stringify(document, null, 2));
      if (written) toast.success(t('preferences.cloud.exportSuccess'));
      else toast.error(t('preferences.cloud.exportFailed'));
    } catch {
      toast.error(t('preferences.cloud.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  const startGoogleSignIn = async () => {
    if (loadingLoginState || busy || state?.authenticated) return;
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

  // A sign-in can revive a deleted account (OAuth completes immediately, so the
  // server restores instead of refusing). The notice is shared with the
  // notebook login dialog so it appears once no matter where the user signed in.
  useEffect(() => {
    if (consumeAccountRestoreNotice(state)) toast.info(t('preferences.cloud.restored'));
  }, [state, t]);

  return (
    <div className="space-y-5 pb-8">
      {(stateLoadError ?? state?.authError) && (
        <p className="break-words text-sm text-[var(--destructive)]">
          {cloudSyncErrorMessage(stateLoadError ?? state?.authError, t, 'errors.friendly.accountLoad')}
        </p>
      )}

      {!state?.authenticated ? (
        <Button
          variant="outline"
          className="mx-auto flex h-10 w-[64%] gap-2 rounded-lg bg-[var(--card)]"
          disabled={loadingLoginState || busy}
          onClick={() => void startGoogleSignIn()}
        >
          <img src={googleLogo} alt="" aria-hidden="true" className="h-4 w-4 object-contain" />
          {t('preferences.cloud.googleSignIn')}
        </Button>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--brand)_10%,transparent)] text-base font-medium text-[var(--foreground)]">
              {state.account?.user.email?.trim().charAt(0).toUpperCase() || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {state.account?.user.displayName}
              </div>
              <div className="truncate text-sm text-[var(--muted-foreground)]">
                {state.account?.user.email}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-1">
            {([
              ['ai', t('preferences.cloud.section.ai')],
              ['storage', t('preferences.cloud.section.storage')],
            ] as const).map(([section, label]) => (
              <Button
                key={section}
                type="button"
                size="sm"
                variant={activeAccountSection === section ? 'secondary' : 'ghost'}
                className="rounded-lg"
                aria-pressed={activeAccountSection === section}
                onClick={() => setActiveAccountSection(section)}
              >
                {label}
              </Button>
            ))}
          </div>

          {activeAccountSection === 'ai' ? (
            <PiCloudModelsSection authenticated />
          ) : (
            <div className="space-y-1.5">
            <div className="text-sm font-medium text-[var(--foreground)]">{t('preferences.cloud.storage.title')}</div>
            <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
              <div className="space-y-3">
                <div className="grid grid-cols-[5em_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
                  <div className="text-[var(--muted-foreground)]">{t('preferences.cloud.storage.type')}</div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className={cn(
                      'shrink-0 rounded-md px-1.5 py-0.5 text-xs',
                      hasMembership
                        ? 'bg-[color-mix(in_oklch,var(--success)_15%,transparent)] text-[var(--success)]'
                        : 'bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[var(--warning)]',
                    )}>
                      {hasMembership
                        ? t(hasLifetimeMembership ? 'preferences.cloud.member.lifetimeBadge' : 'preferences.cloud.member.annualBadge')
                        : t('preferences.cloud.member.regular')}
                    </span>
                    {membershipLoading && (
                      <span className="flex items-center gap-1 whitespace-nowrap text-[var(--muted-foreground)]">
                        <Loader2 className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" />
                        {t('preferences.cloud.membershipLoading')}
                      </span>
                    )}
                    {!memberAccessLoading && !hasLifetimeMembership && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="ml-auto h-7 shrink-0 rounded-lg px-2 text-xs"
                        disabled={busy || membershipLoading}
                        onClick={() => void windows.openPaymentDialogInMain('membership').catch((error) => {
                          toast.error(cloudSyncErrorMessage(error, t, 'errors.friendly.checkout'));
                        })}
                      >
                        {t('preferences.cloud.member.upgrade')}
                      </Button>
                    )}
                  </div>
                  {state.membership && state.membership.quotaBytes > 0 && <>
                    <div className="text-[var(--muted-foreground)]">{t('preferences.cloud.storage.space')}</div>
                    <div className="flex flex-wrap items-center gap-x-2 text-[var(--foreground)]">
                      <span>{t('preferences.cloud.storage.used')} {formatMembershipBytes(state.membership.usedBytes)}</span>
                      <span aria-hidden="true" className="text-[var(--muted-foreground)]">/</span>
                      <span>{t('preferences.cloud.usage')} {formatMembershipBytes(state.membership.quotaBytes)}</span>
                    </div>
                  </>}
                  {storageExpiresAt != null && <>
                    <div className="text-[var(--muted-foreground)]">{t('preferences.cloud.expires')}</div>
                    <div className="font-mono text-[var(--foreground)]">
                      {hasLifetimeMembership && new Date(storageExpiresAt).getUTCFullYear() >= 9999
                        ? t('preferences.cloud.lifetime')
                        : formatMembershipDate(storageExpiresAt)}
                    </div>
                  </>}
                </div>
                {membershipError && <div className="space-y-2">
                  <p className="text-sm text-[var(--destructive)]">{t('preferences.cloud.membershipFailed')}</p>
                  <Button variant="outline" className="px-3" disabled={membershipLoading} onClick={() => void refreshMembership()}>
                    {t('preferences.cloud.retry')}
                  </Button>
                </div>}
                {(subscriptionsLoading || subscriptionsLoadError || (
                  annualMembershipSubscription && !annualMembershipSubscription.cancelAtPeriodEnd
                )) && (
                  <div className="space-y-2">
                    {subscriptionsLoading ? (
                      <div aria-hidden="true" className="h-5 animate-pulse rounded bg-[var(--muted)]" />
                    ) : subscriptionsLoadError ? (
                      <div className="space-y-2">
                        <p className="break-words text-sm text-[var(--destructive)]">
                          {subscriptionsLoadError}
                        </p>
                        <Button variant="outline" size="sm" className="rounded-lg" onClick={() => void loadSubscriptions()}>
                          {t('preferences.cloud.retry')}
                        </Button>
                      </div>
                    ) : annualMembershipSubscription && !annualMembershipSubscription.cancelAtPeriodEnd ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-[var(--muted-foreground)]">
                            {t('preferences.cloud.subscription.renewal', {
                              date: annualMembershipSubscription.currentPeriodEnd == null
                                ? t('preferences.cloud.subscription.periodEnd')
                                : formatMembershipDate(annualMembershipSubscription.currentPeriodEnd),
                            })}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="rounded-lg"
                          disabled={cancelingSubscriptionId !== null}
                          onClick={() => void cancelAnnualSubscription(annualMembershipSubscription)}
                        >
                          {cancelingSubscriptionId === annualMembershipSubscription.id
                            ? t('preferences.cloud.subscription.canceling')
                            : t('preferences.cloud.subscription.cancel')}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </section>
          </div>
          )}

          <Dialog open={ordersDialogOpen} onOpenChange={setOrdersDialogOpen}>
            <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('preferences.cloud.order.title')}</DialogTitle>
              </DialogHeader>
          {ordersDialogOpen && (ordersLoading ? (
              <div aria-hidden="true" className="h-20 animate-pulse rounded-xl bg-[var(--muted)]" />
            ) : (
              <div>
                {ordersLoadError ? (
                  <div className="space-y-2">
                    <p className="break-words text-sm text-[var(--destructive)]">{ordersLoadError}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-lg"
                      disabled={ordersLoading}
                      onClick={() => void loadOrders()}
                    >
                      {t('preferences.cloud.retry')}
                    </Button>
                  </div>
                ) : orders.length === 0 ? (
                  <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.cloud.order.empty')}</p>
                ) : (
                  <ul className="divide-y divide-[var(--border)]">
                      <li aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_6rem_4rem] gap-x-3 pb-2 text-xs text-[var(--muted-foreground)]">
                        <span>{t('preferences.cloud.order.productName')}</span>
                        <span className="font-mono text-right">{t('preferences.cloud.order.price')}</span>
                        <span>{t('preferences.cloud.order.statusLabel')}</span>
                      </li>
                      {orders.map((order) => {
                        const checkable = ['pending', 'paid'].includes(order.status);
                        const statusLabel = order.status === 'pending'
                          ? t('preferences.cloud.order.status.pending')
                          : order.status === 'paid'
                          ? t('preferences.cloud.order.status.paid')
                          : order.status === 'expired'
                          ? t('preferences.cloud.order.status.expired')
                          : order.status === 'refunded'
                          ? t('preferences.cloud.order.status.refunded')
                          : t('preferences.cloud.order.status.unknown');

                        return (
                          <li key={order.id} className="space-y-1.5 py-3 last:pb-0">
                            <div className="grid grid-cols-[minmax(0,1fr)_6rem_4rem] items-center gap-x-3 text-sm">
                              <div className="min-w-0">
                                <div className="truncate font-medium text-[var(--foreground)]">{order.productName}</div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                                  <span className="whitespace-nowrap font-mono text-xs text-[var(--muted-foreground)]">
                                    {new Date(order.createdAt).toLocaleString(undefined, {
                                      year: 'numeric',
                                      month: '2-digit',
                                      day: '2-digit',
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}
                                  </span>
                                  {checkable && (
                                    <Tooltip content={t('preferences.cloud.order.checkTooltip')}>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="xs"
                                        className="h-auto min-h-6 rounded-md px-1 text-xs text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)]"
                                        disabled={checkingOrderId !== null || resumingOrderId !== null}
                                        onClick={() => void checkOrder(order.id)}
                                      >
                                        {checkingOrderId === order.id
                                          ? t('preferences.cloud.order.checking')
                                          : orderCheckFailedId === order.id
                                          ? t('preferences.cloud.retry')
                                          : t('preferences.cloud.order.check')}
                                      </Button>
                                    </Tooltip>
                                  )}
                                  {order.status === 'pending' && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="xs"
                                      className="h-auto min-h-6 rounded-md px-1 text-xs text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)]"
                                      disabled={checkingOrderId !== null || resumingOrderId !== null}
                                      onClick={() => void resumeCheckout(order)}
                                    >
                                      {resumingOrderId === order.id
                                        ? t('preferences.cloud.order.resumingPayment')
                                        : t('preferences.cloud.order.continuePayment')}
                                    </Button>
                                  )}
                                </div>
                              </div>
                              <span className="whitespace-nowrap font-mono text-right text-xs text-[var(--muted-foreground)]">
                                {new Intl.NumberFormat(undefined, {
                                  style: 'currency', currency: order.currency.toUpperCase(),
                                }).format(order.amount / 100)}
                              </span>
                              <span className={cn(
                                'w-fit whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs',
                                order.status === 'paid'
                                  ? 'bg-[color-mix(in_oklch,var(--success)_15%,transparent)] text-[var(--success)]'
                                  : 'bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[var(--warning)]',
                              )}>{statusLabel}</span>
                            </div>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </div>
            ))}
            </DialogContent>
          </Dialog>

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto min-h-0 rounded-none p-0 text-sm text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)]"
              onClick={() => {
                setOrdersLoading(true);
                setOrdersDialogOpen(true);
              }}
            >
              {t('preferences.cloud.order.title')}
            </Button>
            <span aria-hidden="true" className="h-4 w-px self-center bg-[var(--border)]" />
            <Button
              variant="ghost"
              size="sm"
              className="h-auto min-h-0 rounded-none p-0 text-sm text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)]"
              disabled={busy}
              onClick={() => void run(() => cloud.logout())}
            >
              {t('preferences.cloud.logout')}
            </Button>
            <span aria-hidden="true" className="h-4 w-px self-center bg-[var(--border)]" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 rounded-full p-0 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)]"
                  aria-label={t('preferences.cloud.accountMore')}
                  title={t('preferences.cloud.accountMore')}
                >
                  <Ellipsis className="size-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[180px] max-w-[calc(100vw-16px)] rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-xs">
                  <span className="shrink-0 text-[var(--muted-foreground)]">{t('preferences.cloud.accountId')}</span>
                  <code className="min-w-0 flex-1 truncate font-mono text-[var(--foreground)]" title={state?.account?.user.id}>
                    {state?.account?.user.id}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-1.5 text-xs text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)]"
                    onClick={() => void copyAccountId()}
                  >
                    {t('preferences.cloud.copy')}
                  </Button>
                </div>
                <DropdownMenuItem
                  className="rounded-lg"
                  disabled={exporting}
                  onClick={() => void exportAccountData()}
                >
                  {exporting ? t('preferences.cloud.exporting') : t('preferences.cloud.export')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="rounded-lg text-[var(--destructive)] focus:text-[var(--destructive)]"
                  onClick={() => setDeleteAccountDialogOpen(true)}
                >
                  {t('preferences.cloud.deleteAccount')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <DeleteAccountDialog
            open={deleteAccountDialogOpen}
            onOpenChange={setDeleteAccountDialogOpen}
            email={state?.account?.user.email ?? ''}
            onExport={() => void exportAccountData()}
            exporting={exporting}
          />

        </>
      )}
    </div>
  );
}
