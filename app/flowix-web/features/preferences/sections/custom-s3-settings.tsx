import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { getCloudSyncAccess } from '@/lib/cloud-account';
import { toast } from '@/lib/toast';
import { openCloudLoginDialog } from '@features/preferences/public/cloud-login-dialog';
import { cloud, type CloudStorageAccess, type CloudStorageSettings, listenToCloudStorageAccessChanges } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { cn } from '@/lib/utils';
import { useCloudAccountState } from '@features/preferences/hooks/use-cloud-account-state';
import { Field, FIELD_INPUT_CLASS } from '@features/preferences/sections/primitives';

const CUSTOM_S3_FORM_FIELD_CLASS = 'space-y-[3px]';
const CUSTOM_S3_FORM_CONTROL_CLASS = `${FIELD_INPUT_CLASS} !bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]`;
const CUSTOM_S3_FORM_SECRET_CLASS = `${FIELD_INPUT_CLASS} !border-[var(--primary)]`;

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

export function CustomS3Settings() {
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
