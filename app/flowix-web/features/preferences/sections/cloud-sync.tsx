'use client';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { consumeAccountRestoreNotice, getCloudSyncAccess } from '@/lib/cloud-account';

import { useEffect, useState } from 'react';
import { Check, ChevronRight, Crown, Ellipsis, Loader2 } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { openUrl } from '@platform/tauri/opener';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import {
  cloud,
  dialogs,
  type CloudCheckout,
  type CloudOrder,
  type CloudSubscription,
  type CloudState,
  type CloudStorageAccess,
  type CloudStorageSettings,
  type CloudUser,
  listenToCloudStorageAccessChanges,
  windows,
} from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useWechatPaymentStatus } from '@features/cloud-billing/public/use-wechat-payment-status';
import { WechatPaymentIcon, WechatPaymentQr } from '@features/cloud-billing/public/wechat-payment-qr';
import { Tooltip } from '@shared/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useCloudAccountState } from '@features/preferences/hooks/use-cloud-account-state';
import { DeleteAccountDialog } from '@features/preferences/sections/delete-account-dialog';
import { PiCloudModelsSection } from '@features/preferences/sections/pi-cloud-models-section';
import { useMembershipAccess } from '@features/preferences/public/membership';
import { AccountAuthFlow } from '@features/preferences/public/account-auth-flow';
import { openCloudLoginDialog } from '@features/preferences/public/cloud-login-dialog';
import { Field, FIELD_INPUT_CLASS, SectionHeader } from '@features/preferences/sections/primitives';

const CUSTOM_S3_FORM_FIELD_CLASS = 'space-y-[3px]';
const CUSTOM_S3_FORM_CONTROL_CLASS = `${FIELD_INPUT_CLASS} !bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]`;
const CUSTOM_S3_FORM_SECRET_CLASS = `${FIELD_INPUT_CLASS} !border-[var(--primary)]`;

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

function formatMembershipDateTime(value: number): string {
  const date = new Date(value);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${formatMembershipDate(value)} ${hours}:${minutes}`;
}

function isRunningStorageTarget(
  storageAccess: CloudStorageAccess | null,
  target: CloudStorageSettings['activeTarget'],
): boolean {
  if (!storageAccess) return false;
  if (target.type === 'official') return storageAccess.target === 'official';
  return storageAccess.target === 'customS3' && storageAccess.profileId === target.profileId;
}

function customS3ErrorMessage(
  error: unknown,
  t: ReturnType<typeof useI18n>['t'],
  operation: 'check' | 'save',
): string {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error ?? '');

  if (/re-enter S3 credentials after changing endpoint or storage scope/i.test(message)) {
    return t('cloudSync.custom.reenterCredentials');
  }
  if (/both S3 credentials must be provided together/i.test(message)) {
    return t('cloudSync.custom.credentialsPairRequired');
  }
  if (/credentials are required for a new S3 profile|S3 credentials are required/i.test(message)) {
    return t('cloudSync.custom.credentialsRequired');
  }
  if (/S3 bucket, region and credentials are required/i.test(message)) {
    return t('cloudSync.custom.requiredFields');
  }
  if (/invalid S3 endpoint|S3 endpoint must be an HTTP\(S\) origin/i.test(message)) {
    return t('cloudSync.custom.invalidEndpoint');
  }
  if (/dedicated S3 prefix without empty or dot segments/i.test(message)) {
    return t('cloudSync.custom.invalidPrefix');
  }
  if (/saved S3 credentials are unavailable|metadata does not match its stored credentials/i.test(message)) {
    return t('cloudSync.custom.savedCredentialsUnavailable');
  }
  if (/profile with this name already exists/i.test(message)) {
    return t('cloudSync.custom.duplicateProfileName');
  }
  if (operation === 'check' && /AccessDenied|Forbidden|not authorized|status\s*403/i.test(message)) {
    return t('cloudSync.custom.readAccessDenied');
  }
  return t(operation === 'check' ? 'cloudSync.custom.readAccessFailed' : 'cloudSync.custom.failed');
}

function CustomS3Settings() {
  const { t } = useI18n();
  const { state: accountState, loading: accountLoading } = useCloudAccountState();
  const accountSyncAccess = getCloudSyncAccess(accountState);
  const accountEmail = accountState?.account?.user.email ?? '';
  const officialAccountMessage = accountLoading
    ? t('cloudSync.custom.checkingAccount')
    : !accountState?.authenticated || accountSyncAccess.restriction === 'signed_out'
      ? t('cloudSync.custom.loginToUseOfficial')
      : accountSyncAccess.restriction === 'membership_required'
        ? t('cloudSync.custom.noStoragePermission', { email: accountEmail })
        : accountSyncAccess.restriction === 'verification_failed'
          ? t('cloudSync.custom.accountCheckFailed')
          : accountSyncAccess.restriction === 'verifying'
            ? t('cloudSync.custom.checkingAccount')
            : t('cloudSync.custom.usingOfficialAccount', { email: accountEmail });
  const [settings, setSettings] = useState<CloudStorageSettings | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('auto');
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('flowix');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [profileFormOpen, setProfileFormOpen] = useState(false);
  const [customStorageVisible, setCustomStorageVisible] = useState(false);
  const [storageAccess, setStorageAccess] = useState<CloudStorageAccess | null>(null);
  const remote = { endpoint, region, bucket, prefix };
  const input = { remote, profileId: profileId ?? undefined, accessKeyId, secretAccessKey };
  const profileInput = {
    profile: { id: profileId ?? '', remote },
    accessKeyId,
    secretAccessKey,
  };
  const editingProfile = settings?.profiles.some((profile) => profile.id === profileId) ?? false;
  const fields = [
    { id: 'endpoint', label: t('cloudSync.custom.endpoint'), value: endpoint, setValue: setEndpoint, type: 'url' },
    { id: 'region', label: t('cloudSync.custom.region'), value: region, setValue: setRegion, type: 'text' },
    { id: 'bucket', label: t('cloudSync.custom.bucket'), value: bucket, setValue: setBucket, type: 'text' },
    { id: 'prefix', label: t('cloudSync.custom.prefix'), value: prefix, setValue: setPrefix, type: 'text' },
    { id: 'accessKey', label: t('cloudSync.custom.accessKey'), value: accessKeyId, setValue: setAccessKeyId, type: 'text' },
    { id: 'secretKey', label: t('cloudSync.custom.secretKey'), value: secretAccessKey, setValue: setSecretAccessKey, type: 'password' },
  ] as const;
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void cloud.getStorageConfig().then((config) => {
        if (!cancelled) setSettings(config);
      }).catch(() => {
        if (!cancelled) setSettings(null);
      });
      void cloud.getStorageAccess().then((access) => {
        if (!cancelled) setStorageAccess(access);
      }).catch(() => {
        if (!cancelled) setStorageAccess(null);
      });
    };
    refresh();
    const unlisten = listenToCloudStorageAccessChanges(refresh);
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);
  const startNewProfile = () => {
    setProfileFormOpen(true);
    setProfileId(window.crypto.randomUUID());
    setEndpoint('');
    setRegion('auto');
    setBucket('');
    setPrefix('flowix');
    setAccessKeyId('');
    setSecretAccessKey('');
  };
  const editProfile = (profile: NonNullable<CloudStorageSettings['profiles']>[number]) => {
    setProfileFormOpen(true);
    setProfileId(profile.id);
    setEndpoint(profile.remote.endpoint);
    setRegion(profile.remote.region);
    setBucket(profile.remote.bucket);
    setPrefix(profile.remote.prefix);
    setAccessKeyId('');
    setSecretAccessKey('');
  };
  const closeProfileForm = () => {
    setProfileFormOpen(false);
    setAccessKeyId('');
    setSecretAccessKey('');
  };
  const revealCustomStorage = () => {
    setCustomStorageVisible(true);
    startNewProfile();
  };
  const collapseCustomStorage = () => {
    closeProfileForm();
    setCustomStorageVisible(false);
  };
  const checkAccess = async () => {
    setBusy(true);
    try {
      await cloud.checkCustomS3(input);
      toast.info(t('cloudSync.custom.checked'));
    } catch (error) {
      toast.error(customS3ErrorMessage(error, t, 'check'));
    } finally {
      setBusy(false);
    }
  };
  const saveProfile = async () => {
    setBusy(true);
    try {
      const id = profileId ?? window.crypto.randomUUID();
      const config = await cloud.saveCustomS3Profile({ ...profileInput, profile: { ...profileInput.profile, id } });
      setSettings(config);
      setProfileId(id);
      setSecretAccessKey('');
      setAccessKeyId('');
      setProfileFormOpen(false);
      const restartRequired = storageAccess?.profileId === id
        || (config.activeTarget.type === 'customS3' && config.activeTarget.profileId === id);
      toast.info(t(restartRequired ? 'cloudSync.custom.saved' : 'cloudSync.custom.savedOnly'));
    } catch (error) {
      toast.error(customS3ErrorMessage(error, t, 'save'));
    } finally {
      setBusy(false);
    }
  };
  const selectTarget = async (target: { type: 'official' } | { type: 'customS3'; profileId: string }) => {
    const restartRequired = !isRunningStorageTarget(storageAccess, target);
    setBusy(true);
    try {
      setSettings(await cloud.selectStorageTarget(target));
      toast.info(t(restartRequired ? 'cloudSync.custom.saved' : 'cloudSync.custom.targetAlreadyRunning'));
    } catch (error) {
      toast.error(customS3ErrorMessage(error, t, 'save'));
    } finally {
      setBusy(false);
    }
  };
  const deleteProfile = async (id: string) => {
    if (!window.confirm(t('cloudSync.custom.confirmDelete'))) return;
    const restartRequired = storageAccess?.profileId === id
      || (settings?.activeTarget.type === 'customS3' && settings.activeTarget.profileId === id);
    setBusy(true);
    try {
      setSettings(await cloud.deleteCustomS3Profile(id));
      if (profileId === id) {
        setProfileId(null);
        setProfileFormOpen(false);
        setAccessKeyId('');
        setSecretAccessKey('');
      }
      toast.info(t(restartRequired ? 'cloudSync.custom.saved' : 'cloudSync.custom.savedOnly'));
    } catch (error) {
      toast.error(customS3ErrorMessage(error, t, 'save'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t('cloudSync.custom.official')}</div>
          </div>
          {settings?.activeTarget.type !== 'official' && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || !settings}
              onClick={() => void selectTarget({ type: 'official' })}
            >
              {t('cloudSync.custom.useTarget')}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={cn(
            'text-xs',
            accountSyncAccess.restriction === 'membership_required'
              ? 'text-[var(--warning)]'
              : 'text-[var(--muted-foreground)]',
          )} role="status" aria-live="polite">
            {officialAccountMessage}
          </p>
          {!accountLoading && !accountState?.authenticated && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-0 text-xs text-[var(--primary)] hover:bg-transparent"
              onClick={() => void openCloudLoginDialog()}
            >
              {t('preferences.cloud.auth.signIn')}
            </Button>
          )}
        </div>
        {settings?.activeTarget.type === 'official'
          && storageAccess
          && !isRunningStorageTarget(storageAccess, settings.activeTarget)
          && <p className="text-xs text-[var(--warning)]" role="status">{t('cloudSync.custom.restartRequired')}</p>}
      </section>
      {!customStorageVisible ? (
        <Button
          type="button"
          variant="ghost"
          className="h-auto gap-1 px-0 py-1 text-sm text-[var(--primary)] hover:bg-transparent"
          onClick={revealCustomStorage}
        >
          {t('cloudSync.custom.useOwnStorage')}
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      ) : (
      <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="text-sm font-medium">{t('cloudSync.custom.title')}</div>
        <p className="text-xs text-[var(--muted-foreground)]">{t('cloudSync.custom.description')}</p>
        {storageAccess?.target === 'customS3' && (
          <div className="space-y-1" role="status" aria-live="polite">
            <p className={cn(
              'text-xs',
              !storageAccess.configured ? 'text-[var(--destructive)]' : 'text-[var(--muted-foreground)]',
            )}>
              {t(storageAccess.configured ? 'cloudSync.custom.active' : 'cloudSync.custom.credentialsUnavailable')}
            </p>
          </div>
        )}
        {settings?.activeTarget.type === 'customS3'
          && storageAccess
          && !isRunningStorageTarget(storageAccess, settings.activeTarget)
          && <p className="text-xs text-[var(--warning)]" role="status">{t('cloudSync.custom.restartRequired')}</p>}
        {!profileFormOpen && settings?.profiles.map((profile) => {
          const selected = settings.activeTarget.type === 'customS3'
            && settings.activeTarget.profileId === profile.id;
          return (
            <div key={profile.id} className={cn(
              'flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] p-3',
            )}>
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-medium">{profile.remote.bucket}/{profile.remote.prefix}</div>
                <div className="truncate text-xs text-[var(--muted-foreground)]">{profile.remote.endpoint}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => editProfile(profile)}>{t('cloudSync.custom.edit')}</Button>
                {!selected && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-pressed={false}
                    disabled={busy}
                    onClick={() => void selectTarget({ type: 'customS3', profileId: profile.id })}
                  >
                    {t('cloudSync.custom.useTarget')}
                  </Button>
                )}
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void deleteProfile(profile.id)}>{t('cloudSync.custom.delete')}</Button>
              </div>
            </div>
          );
        })}
        {profileFormOpen ? (
          <div className="space-y-3 border-t border-[var(--divider)] pt-3">
            {editingProfile && <div className="text-sm font-medium">{t('cloudSync.custom.editProfile')}</div>}
            {editingProfile && profileId && <p className="text-xs text-[var(--muted-foreground)]">
              {t('cloudSync.custom.credentialsHint')}
            </p>}
            {fields.map((field) => (
              <Field
                key={field.id}
                title={field.label}
                controlId={`custom-s3-${field.id}`}
                className={CUSTOM_S3_FORM_FIELD_CLASS}
              >
                <Input
                  id={`custom-s3-${field.id}`}
                  className={field.id === 'secretKey' ? CUSTOM_S3_FORM_SECRET_CLASS : CUSTOM_S3_FORM_CONTROL_CLASS}
                  type={field.type}
                  value={field.value}
                  onChange={(event) => field.setValue(event.target.value)}
                  autoComplete={field.id === 'secretKey' ? 'new-password' : 'off'}
                />
                {field.id === 'endpoint' && (
                  <>
                    <p className="text-xs text-[var(--muted-foreground)]">{t('cloudSync.custom.endpointHint')}</p>
                    {/^http:\/\//i.test(endpoint.trim()) && (
                      <p className="text-xs text-[var(--warning)]" role="status">
                        {t('cloudSync.custom.insecureEndpointWarning')}
                      </p>
                    )}
                  </>
                )}
              </Field>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={() => void checkAccess()}>{t('cloudSync.custom.check')}</Button>
                <Button type="button" disabled={busy} onClick={() => void saveProfile()}>{t('cloudSync.custom.save')}</Button>
              </div>
              <Button type="button" variant="outline" className="ml-auto" disabled={busy} onClick={collapseCustomStorage}>{t('cloudSync.custom.collapse')}</Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={startNewProfile}>{t('cloudSync.custom.addProfile')}</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={collapseCustomStorage}>{t('cloudSync.custom.collapse')}</Button>
          </div>
        )}
      </section>
      )}
    </div>
  );
}

function AccountSettingsPanel() {
  const { t } = useI18n();
  const { state, loadError: stateLoadError, applyState, membershipLoading, membershipError, refreshMembership } = useCloudAccountState();
  const [busy, setBusy] = useState(false);
  const [membershipNow, setMembershipNow] = useState(Date.now);
  const [orders, setOrders] = useState<CloudOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersLoadError, setOrdersLoadError] = useState<string | null>(null);
  const [ordersDialogOpen, setOrdersDialogOpen] = useState(false);
  const [deleteAccountDialogOpen, setDeleteAccountDialogOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [regionDialogOpen, setRegionDialogOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<CloudUser['region']>('non_mainland');
  const [updatingRegion, setUpdatingRegion] = useState(false);
  const [subscriptions, setSubscriptions] = useState<CloudSubscription[]>([]);
  const [subscriptionsLoadError, setSubscriptionsLoadError] = useState<string | null>(null);
  const [cancelingSubscriptionId, setCancelingSubscriptionId] = useState<string | null>(null);
  const [checkingOrderId, setCheckingOrderId] = useState<string | null>(null);
  const [orderCheckFailedId, setOrderCheckFailedId] = useState<string | null>(null);
  const [resumingOrderId, setResumingOrderId] = useState<string | null>(null);
  const [wechatCheckout, setWechatCheckout] = useState<CloudCheckout | null>(null);
  const { status: wechatStatus, refresh: refreshWechatStatus } = useWechatPaymentStatus(wechatCheckout?.orderId, () => { void loadOrders(); });
  const storageExpiresAt = state?.membership?.storageExpiresAt ?? state?.membership?.expiresAt;
  const { active: hasMembership, lifetime: hasLifetimeMembership, loading: memberAccessLoading } = useMembershipAccess();
  const storageMembershipInactive = state?.membershipStatus === 'verified' && !hasMembership && !membershipError;
  const membershipInfoLoading = Boolean(state?.authenticated
    && !state.membership
    && !membershipError
    && state.membershipStatus !== 'verified'
    && state.membershipStatus !== 'error');
  const aiExpiresAt = state?.membership?.aiGrantExpiresAt;
  useEffect(() => {
    if (aiExpiresAt == null || aiExpiresAt <= Date.now()) return;
    const timer = window.setTimeout(() => setMembershipNow(Date.now()),
      Math.min(aiExpiresAt - Date.now() + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [aiExpiresAt, state?.revision, membershipNow]);
  const aiKnown = state?.membershipStatus === 'verified' && typeof state.membership?.aiActive === 'boolean';
  const hasAiMembership = aiKnown && state?.membership?.aiActive === true
    && (aiExpiresAt == null || aiExpiresAt > Math.max(membershipNow, Date.now()));
  const aiMembershipStatus = !aiKnown ? 'unknown'
    : !hasAiMembership ? 'inactive'
    : state?.membership?.aiGrantDurationUnit === 'month' && state.membership.aiGrantDurationCount === 1
      ? 'active' : 'unknown';
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
    setSubscriptionsLoadError(null);
    try {
      setSubscriptions(await cloud.listSubscriptions());
    } catch (error) {
      setSubscriptionsLoadError(friendlyErrorMessage(error, t, 'errors.friendly.subscriptionLoad'));
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
    setSubscriptionsLoadError(null);
    void cloud.listSubscriptions().then((next) => {
      if (active) setSubscriptions(next);
    }).catch((error) => {
      if (active) setSubscriptionsLoadError(friendlyErrorMessage(error, t, 'errors.friendly.subscriptionLoad'));
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
      } else if (result.checkStatus === 'closed') {
        toast.info(t('preferences.cloud.order.closed'));
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
      if (checkout.checkoutUrl.startsWith('weixin://')) {
        setWechatCheckout(checkout);
      } else if (checkout.checkoutUrl) {
        await openUrl(checkout.checkoutUrl);
      }
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

  const openRegionDialog = () => {
    setSelectedRegion(state?.account?.user.region ?? 'non_mainland');
    setRegionDialogOpen(true);
  };

  const updateAccountRegion = async () => {
    if (updatingRegion || !state?.account) return;
    if (selectedRegion === state.account.user.region) {
      setRegionDialogOpen(false);
      return;
    }
    setUpdatingRegion(true);
    try {
      const nextState = await cloud.updateAccountRegion(selectedRegion);
      applyState(nextState);
      setRegionDialogOpen(false);
      toast.success(t('preferences.cloud.region.updated'));
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setUpdatingRegion(false);
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

  // A sign-in can revive a deleted account (OAuth completes immediately, so the
  // server restores instead of refusing). The notice is shared with the
  // notebook login dialog so it appears once no matter where the user signed in.
  useEffect(() => {
    if (consumeAccountRestoreNotice(state)) toast.info(t('preferences.cloud.restored'));
  }, [state, t]);

  return (
    <div className={cn(
      'space-y-5 pb-8',
      !state?.authenticated && 'flex min-h-full flex-col justify-center',
    )}>
      {(stateLoadError ?? state?.authError) && (
        <p className="break-words text-sm text-[var(--destructive)]">
          {cloudSyncErrorMessage(stateLoadError ?? state?.authError, t, 'errors.friendly.accountLoad')}
        </p>
      )}

      {!state?.authenticated ? (
        <AccountAuthFlow layout="page" onAuthenticated={applyState} />
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

          <div className="space-y-5">
            <PiCloudModelsSection
              authenticated
              membershipStatus={aiMembershipStatus}
              membershipLoading={membershipInfoLoading}
            />
            <div className="space-y-1.5">
            <div className="text-sm font-medium text-[var(--foreground)]">{t('preferences.cloud.storage.title')}</div>
            <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
              <div className="space-y-3">
                <div className="grid grid-cols-[5em_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
                  <div className="text-[var(--muted-foreground)]">{t('preferences.cloud.storage.type')}</div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {membershipInfoLoading ? (
                      <span aria-hidden="true" className="h-[18px] w-16 animate-pulse rounded-md bg-[var(--muted)]" />
                    ) : <span className={cn(
                      'inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-px text-xs',
                      hasMembership
                        ? 'border border-amber-500/40 bg-amber-100 text-amber-900 dark:border-amber-300/30 dark:bg-amber-950 dark:text-amber-200'
                        : 'bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[var(--warning)]',
                    )}>
                      {hasMembership && <Crown className="size-3" aria-hidden="true" />}
                      {hasMembership
                        ? t('preferences.cloud.section.storage')
                        : t('preferences.cloud.member.regular')}
                    </span>}
                    {membershipLoading && !membershipInfoLoading && (
                      <span className="flex items-center gap-1 whitespace-nowrap text-[var(--muted-foreground)]">
                        <Loader2 className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" />
                        {t('preferences.cloud.membershipLoading')}
                      </span>
                    )}
                    {!membershipInfoLoading && !memberAccessLoading && !hasLifetimeMembership && (
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
                  {membershipInfoLoading ? <>
                    <div className="self-start text-[var(--muted-foreground)]">{t('preferences.cloud.storage.space')}</div>
                    <div className="min-w-0 space-y-2" aria-hidden="true">
                      <div className="flex items-center gap-2">
                        <span className="h-4 w-20 animate-pulse rounded bg-[var(--muted)]" />
                        <span className="text-[var(--muted-foreground)]">/</span>
                        <span className="h-4 w-20 animate-pulse rounded bg-[var(--muted)]" />
                      </div>
                      <div className="h-1.5 w-full animate-pulse rounded-full bg-[var(--muted)]" />
                      <div className="flex items-center justify-between gap-2">
                        <span className="h-3 w-36 animate-pulse rounded bg-[var(--muted)]" />
                        <span className="h-3 w-16 animate-pulse rounded bg-[var(--muted)]" />
                      </div>
                    </div>
                  </> : storageMembershipInactive ? <>
                    <div className="self-start text-[var(--muted-foreground)]">{t('preferences.cloud.storage.space')}</div>
                    <div className="min-w-0 text-[var(--foreground)]">
                      {t('preferences.cloud.storage.used')} {formatMembershipBytes(0)}
                      <span aria-hidden="true" className="px-2 text-[var(--muted-foreground)]">/</span>
                      {t('preferences.cloud.usage')} {formatMembershipBytes(0)}
                    </div>
                  </> : state.membership && state.membership.quotaBytes > 0 && <>
                    <div className="self-start text-[var(--muted-foreground)]">{t('preferences.cloud.storage.space')}</div>
                    <div className="min-w-0 space-y-2 text-[var(--foreground)]">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span>{t('preferences.cloud.storage.used')} {formatMembershipBytes(state.membership.usedBytes)}</span>
                        <span aria-hidden="true" className="text-[var(--muted-foreground)]">/</span>
                        <span>{t('preferences.cloud.usage')} {formatMembershipBytes(state.membership.quotaBytes)}</span>
                      </div>
                      <div
                        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted)]"
                        role="progressbar"
                        aria-label={t('preferences.cloud.storage.space')}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.min(100, Math.round(state.membership.usedBytes / state.membership.quotaBytes * 100))}
                      >
                        <div
                          className={cn(
                            'h-full rounded-full transition-[width] duration-300',
                            state.membership.usedBytes / state.membership.quotaBytes >= 0.95
                              ? 'bg-[var(--destructive)]'
                              : 'bg-[var(--brand)]',
                          )}
                          style={{ width: `${Math.min(100, state.membership.usedBytes / state.membership.quotaBytes * 100)}%` }}
                        />
                      </div>
                      {state.membership.usedBytes / state.membership.quotaBytes >= 0.95 && (
                        <p className="text-xs text-[var(--destructive)]" role="status">
                          {t('preferences.cloud.storage.nearLimit')}
                        </p>
                      )}
                      <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted-foreground)]">
                        <span>
                          {state.membership.usageReadStatus === 'error'
                            ? t('preferences.cloud.storage.measurementFailed')
                            : state.membership.usageReadStatus !== 'ok'
                              ? t('preferences.cloud.storage.measurementUnavailable')
                              : state.membership.usageSource === 'object_store' && state.membership.usageObservedAt != null
                                ? t('preferences.cloud.storage.measured', { date: formatMembershipDateTime(state.membership.usageObservedAt) })
                                : t('preferences.cloud.storage.ledgerEstimate')}
                        </span>
                        <span className="shrink-0">
                          {t('preferences.cloud.storage.remaining', {
                            percent: Math.max(0, Math.min(100, (state.membership.quotaBytes - state.membership.usedBytes) / state.membership.quotaBytes * 100)).toFixed(2),
                          })}
                        </span>
                      </div>
                    </div>
                  </>}
                  {(membershipInfoLoading || storageMembershipInactive || storageExpiresAt != null) && <>
                    <div className="text-[var(--muted-foreground)]">{t('preferences.cloud.expires')}</div>
                    <div className="font-mono text-[var(--foreground)]">
                      {membershipInfoLoading
                        ? <span aria-hidden="true" className="inline-block h-4 w-24 animate-pulse rounded bg-[var(--muted)] align-middle" />
                        : storageMembershipInactive
                        ? t('preferences.cloud.member.regular')
                        : storageExpiresAt == null
                          ? ''
                          : hasLifetimeMembership && new Date(storageExpiresAt).getUTCFullYear() >= 9999
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
                {(subscriptionsLoadError || (
                  annualMembershipSubscription && !annualMembershipSubscription.cancelAtPeriodEnd
                )) && (
                  <div className="space-y-2">
                    {subscriptionsLoadError ? (
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
          </div>

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

          <Dialog open={regionDialogOpen} onOpenChange={setRegionDialogOpen}>
            <DialogContent className="max-w-md" closeDisabled={updatingRegion}>
              <DialogHeader>
                <DialogTitle>{t('preferences.cloud.region.title')}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <p className="text-sm text-[var(--muted-foreground)]">
                  {t('preferences.cloud.region.description')}
                </p>
                <div role="radiogroup" aria-label={t('preferences.cloud.region.title')} className="space-y-2">
                  {([
                    ['mainland', 'preferences.cloud.region.mainland', 'preferences.cloud.region.mainlandDescription'],
                    ['non_mainland', 'preferences.cloud.region.nonMainland', 'preferences.cloud.region.nonMainlandDescription'],
                  ] as const).map(([region, titleKey, descriptionKey]) => {
                    const selected = selectedRegion === region;
                    return (
                      <button
                        key={region}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={updatingRegion}
                        onClick={() => setSelectedRegion(region)}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand)]',
                          selected
                            ? 'border-[var(--brand)] bg-[var(--muted)]'
                            : 'border-[var(--border)] hover:bg-[var(--muted)]',
                        )}
                      >
                        <span className="min-w-0 space-y-1">
                          <span className="block text-sm font-medium text-[var(--foreground)]">{t(titleKey)}</span>
                          <span className="block text-xs text-[var(--muted-foreground)]">{t(descriptionKey)}</span>
                        </span>
                        <span className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full border',
                          selected
                            ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--primary-foreground)]'
                            : 'border-[var(--border)] text-transparent',
                        )}>
                          <Check className="size-3" aria-hidden="true" />
                        </span>
                      </button>
                    );
                  })}
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" disabled={updatingRegion} onClick={() => setRegionDialogOpen(false)}>
                    {t('preferences.cloud.region.cancel')}
                  </Button>
                  <Button
                    type="button"
                    disabled={updatingRegion || selectedRegion === state?.account?.user.region}
                    onClick={() => void updateAccountRegion()}
                  >
                    {updatingRegion ? t('preferences.cloud.region.saving') : t('preferences.cloud.region.save')}
                  </Button>
                </DialogFooter>
              </div>
            </DialogContent>
          </Dialog>

          <Dialog
            open={wechatCheckout !== null}
            onOpenChange={(open) => { if (!open) setWechatCheckout(null); }}
          >
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2"><WechatPaymentIcon />{t('billing.dialog.wechatTitle')}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <p className="text-sm text-[var(--muted-foreground)]">
                  {t(wechatStatus === 'paid' ? 'billing.dialog.wechatPaid' : wechatStatus === 'paidRefreshFailed' ? 'billing.dialog.wechatPaidRefreshFailed' : wechatStatus === 'checkFailed' ? 'billing.dialog.wechatCheckFailed' : wechatStatus === 'pending' ? 'billing.dialog.wechatPendingStatus' : 'billing.dialog.wechatInstructions')}
                </p>
                {wechatStatus !== 'paid' && wechatStatus !== 'paidRefreshFailed' && wechatCheckout && (
                  <WechatPaymentQr url={wechatCheckout.checkoutUrl} svg={wechatCheckout.qrCodeSvg} />
                )}
                <DialogFooter>
                  {wechatStatus !== 'paid' && wechatStatus !== 'paidRefreshFailed' && <Button type="button" variant="outline" disabled={wechatStatus === 'checking'} onClick={() => void refreshWechatStatus()}>
                    {t(wechatStatus === 'checking' ? 'billing.dialog.wechatChecking' : 'billing.dialog.wechatRefresh')}
                  </Button>}
                  <Button type="button" onClick={() => setWechatCheckout(null)}>
                    {t('billing.dialog.wechatClose')}
                  </Button>
                </DialogFooter>
              </div>
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
                <DropdownMenuItem className="rounded-lg" onClick={openRegionDialog}>
                  {t('preferences.cloud.region.menu')}
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

export function CloudSyncSection() {
  return <AccountSettingsPanel />;
}

export function CloudStorageSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-6 pb-16">
      <SectionHeader title={t('cloudSync.storage.title')} />
      <CustomS3Settings />
    </div>
  );
}
