'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Eye, EyeOff, Loader2, Mail } from 'lucide-react';
import googleLogo from '@/assets/google.svg';
import { useI18n, useRegionStore } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cloudSyncErrorMessage, hasTauriErrorCode } from '@platform/tauri/errors';
import { subscribe } from '@platform/tauri/event-bus';
import { cloud, type CloudState } from '@platform/tauri/client';
import { openUrl } from '@platform/tauri/opener';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useCloudAccountState } from '@features/preferences/hooks/use-cloud-account-state';

type AccountAuthView = 'choices' | 'login' | 'register' | 'verify' | 'password-reset' | 'password-reset-verify';

const FLOWIX_LEGAL_URLS = {
  'zh-CN': {
    privacy: 'https://flowix.cc/cn/privacy/',
    terms: 'https://flowix.cc/cn/terms/',
  },
  'en-US': {
    privacy: 'https://flowix.cc/privacy/',
    terms: 'https://flowix.cc/terms/',
  },
} as const;

function registrationErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = /\b(EMAIL_ALREADY_REGISTERED|EMAIL_NOT_CONFIGURED|EMAIL_REGISTRATION_DISABLED|AUTH_NOT_CONFIGURED|REGISTRATION_CODE_PENDING|REGISTRATION_CODE_RATE_LIMITED|INVALID_REGISTRATION_CODE|INVALID_PASSWORD_RESET_CODE|RATE_LIMITED)\b/.exec(message);
  return match?.[1] ?? null;
}

function registrationDisplayNameFromEmail(email: string): string {
  return email.trim().split('@', 1)[0]?.trim() ?? '';
}

export function AccountAuthFlow({
  layout = 'page',
  onAuthenticated,
}: {
  layout?: 'page' | 'dialog';
  onAuthenticated?: (state: CloudState) => void;
}) {
  const { t } = useI18n();
  const region = useRegionStore((current) => current.region);
  const emailLanguage = region === 'mainland' ? 'zh-CN' : 'en-US';
  const legalUrls = FLOWIX_LEGAL_URLS[emailLanguage];
  const { state, loadError, applyState, loading } = useCloudAccountState();
  const [view, setView] = useState<AccountAuthView>('choices');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [restoreAccountOpen, setRestoreAccountOpen] = useState(false);
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginPasswordVisible, setLoginPasswordVisible] = useState(false);
  const [registrationEmail, setRegistrationEmail] = useState('');
  const [registrationPassword, setRegistrationPassword] = useState('');
  const [registrationPasswordVisible, setRegistrationPasswordVisible] = useState(false);
  const [registrationCode, setRegistrationCode] = useState('');
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registrationNotice, setRegistrationNotice] = useState<string | null>(null);
  const [registrationBusy, setRegistrationBusy] = useState(false);
  const [registrationResendDeadline, setRegistrationResendDeadline] = useState<number | null>(null);
  const [registrationClock, setRegistrationClock] = useState(() => Date.now());
  const [passwordResetEmail, setPasswordResetEmail] = useState('');
  const [passwordResetPassword, setPasswordResetPassword] = useState('');
  const [passwordResetConfirmPassword, setPasswordResetConfirmPassword] = useState('');
  const [passwordResetCode, setPasswordResetCode] = useState('');
  const [passwordResetError, setPasswordResetError] = useState<string | null>(null);
  const [passwordResetBusy, setPasswordResetBusy] = useState(false);
  const [passwordResetResendDeadline, setPasswordResetResendDeadline] = useState<number | null>(null);
  const [passwordResetClock, setPasswordResetClock] = useState(() => Date.now());
  const hasReportedAuth = useRef(false);

  const reportAuthenticated = useCallback((next: CloudState) => {
    if (hasReportedAuth.current) return;
    hasReportedAuth.current = true;
    onAuthenticated?.(next);
  }, [onAuthenticated]);

  useEffect(() => {
    if (state?.authenticated) reportAuthenticated(state);
  }, [state, reportAuthenticated]);

  useEffect(() => subscribe<string>('cloud-google-auth-error', (message) => {
    toast.error(cloudSyncErrorMessage(message, t));
    setGoogleBusy(false);
  }), [t]);

  useEffect(() => {
    if (view !== 'verify' || registrationResendDeadline == null) return;
    const deadline = registrationResendDeadline;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setRegistrationClock(now);
      if (now >= deadline) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [view, registrationResendDeadline]);

  useEffect(() => {
    if (view !== 'password-reset-verify' || passwordResetResendDeadline == null) return;
    const deadline = passwordResetResendDeadline;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setPasswordResetClock(now);
      if (now >= deadline) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [view, passwordResetResendDeadline]);

  const registrationResendSeconds = registrationResendDeadline == null
    ? 0
    : Math.max(0, Math.ceil((registrationResendDeadline - registrationClock) / 1000));
  const passwordResetResendSeconds = passwordResetResendDeadline == null
    ? 0
    : Math.max(0, Math.ceil((passwordResetResendDeadline - passwordResetClock) / 1000));

  const startGoogleSignIn = async () => {
    if (loading || busy || googleBusy || state?.authenticated) return;
    setGoogleBusy(true);
    try {
      await cloud.startGoogleSignIn(region === 'mainland' ? 'mainland' : 'non_mainland');
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setGoogleBusy(false);
    }
  };

  const loginWithCredentials = async (restoreDeleted = false) => {
    if (busy || !loginIdentifier.trim() || !loginPassword) return;
    setBusy(true);
    try {
      const next = await cloud.login(loginIdentifier.trim(), loginPassword, restoreDeleted);
      applyState(next);
      setLoginPassword('');
      setRestoreAccountOpen(false);
      setView('choices');
      toast.success(t('preferences.cloud.login'));
      reportAuthenticated(next);
    } catch (error) {
      if (hasTauriErrorCode(error, 'ACCOUNT_DELETED_RESTORABLE')) setRestoreAccountOpen(true);
      else toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const registrationErrorMessage = (error: unknown) => {
    switch (registrationErrorCode(error)) {
      case 'EMAIL_ALREADY_REGISTERED': return t('preferences.cloud.registration.emailExists');
      case 'EMAIL_NOT_CONFIGURED': return t('preferences.cloud.registration.emailUnavailable');
      case 'EMAIL_REGISTRATION_DISABLED':
      case 'AUTH_NOT_CONFIGURED': return t('preferences.cloud.registration.unavailable');
      case 'INVALID_REGISTRATION_CODE': return t('preferences.cloud.registration.invalidCode');
      case 'RATE_LIMITED':
      case 'REGISTRATION_CODE_RATE_LIMITED': return t('errors.friendly.rateLimited');
      default: return cloudSyncErrorMessage(error, t);
    }
  };

  const passwordResetErrorMessage = (error: unknown) => {
    switch (registrationErrorCode(error)) {
      case 'INVALID_PASSWORD_RESET_CODE': return t('preferences.cloud.passwordReset.invalidCode');
      case 'EMAIL_NOT_CONFIGURED': return t('preferences.cloud.registration.emailUnavailable');
      case 'RATE_LIMITED': return t('errors.friendly.rateLimited');
      default: return cloudSyncErrorMessage(error, t);
    }
  };

  const requestRegistrationCode = async () => {
    if (registrationBusy) return;
    setRegistrationBusy(true);
    setRegistrationError(null);
    setRegistrationNotice(null);
    try {
      const result = await cloud.requestRegistrationCode(
        registrationEmail.trim(), registrationPassword, registrationDisplayNameFromEmail(registrationEmail), emailLanguage,
      );
      setRegistrationEmail(result.email);
      setRegistrationCode('');
      setRegistrationResendDeadline(Date.now() + result.resendAfterSeconds * 1000);
      setRegistrationClock(Date.now());
      setView('verify');
    } catch (error) {
      if (registrationErrorCode(error) === 'REGISTRATION_CODE_PENDING') {
        setRegistrationResendDeadline(Date.now() + 60_000);
        setRegistrationClock(Date.now());
        setRegistrationError(t('preferences.cloud.registration.pendingRetry'));
      } else setRegistrationError(registrationErrorMessage(error));
    } finally {
      setRegistrationBusy(false);
    }
  };

  const resendRegistrationCode = async () => {
    if (registrationBusy || registrationResendSeconds > 0) return;
    setRegistrationBusy(true);
    setRegistrationError(null);
    setRegistrationNotice(null);
    try {
      const result = await cloud.resendRegistrationCode(registrationEmail.trim());
      if (result.resendAfterSeconds != null) {
        setRegistrationResendDeadline(Date.now() + result.resendAfterSeconds * 1000);
        setRegistrationClock(Date.now());
      } else {
        const next = await cloud.requestRegistrationCode(
          registrationEmail.trim(), registrationPassword, registrationDisplayNameFromEmail(registrationEmail), emailLanguage,
        );
        setRegistrationEmail(next.email);
        setRegistrationResendDeadline(Date.now() + next.resendAfterSeconds * 1000);
        setRegistrationClock(Date.now());
      }
      setRegistrationCode('');
    } catch (error) {
      if (registrationErrorCode(error) === 'REGISTRATION_CODE_PENDING') {
        setRegistrationNotice(t('preferences.cloud.registration.pendingCode'));
      } else setRegistrationError(registrationErrorMessage(error));
    } finally {
      setRegistrationBusy(false);
    }
  };

  const confirmRegistration = async () => {
    if (registrationBusy || registrationCode.length !== 6) return;
    setRegistrationBusy(true);
    setRegistrationError(null);
    setRegistrationNotice(null);
    try {
      const next = await cloud.confirmRegistration(registrationEmail.trim(), registrationCode, registrationPassword);
      applyState(next);
      setRegistrationPassword('');
      setRegistrationCode('');
      setRegistrationResendDeadline(null);
      setView('choices');
      toast.success(t('preferences.cloud.registration.complete'));
      reportAuthenticated(next);
    } catch (error) {
      setRegistrationError(registrationErrorMessage(error));
    } finally {
      setRegistrationBusy(false);
    }
  };

  const beginPasswordReset = () => {
    const identifier = loginIdentifier.trim();
    setPasswordResetEmail(identifier.includes('@') ? identifier : '');
    setPasswordResetPassword('');
    setPasswordResetConfirmPassword('');
    setPasswordResetCode('');
    setPasswordResetError(null);
    setPasswordResetResendDeadline(null);
    setView('password-reset');
  };

  const requestPasswordResetCode = async () => {
    if (passwordResetBusy) return;
    if (passwordResetPassword !== passwordResetConfirmPassword) {
      setPasswordResetError(t('preferences.cloud.passwordReset.passwordMismatch'));
      return;
    }
    setPasswordResetBusy(true);
    setPasswordResetError(null);
    try {
      const result = await cloud.requestPasswordResetCode(passwordResetEmail.trim(), emailLanguage);
      setPasswordResetEmail(passwordResetEmail.trim().toLowerCase());
      setPasswordResetCode('');
      setPasswordResetResendDeadline(Date.now() + result.resendAfterSeconds * 1000);
      setPasswordResetClock(Date.now());
      setView('password-reset-verify');
    } catch (error) {
      setPasswordResetError(passwordResetErrorMessage(error));
    } finally {
      setPasswordResetBusy(false);
    }
  };

  const resendPasswordResetCode = async () => {
    if (passwordResetBusy || passwordResetResendSeconds > 0) return;
    setPasswordResetBusy(true);
    setPasswordResetError(null);
    try {
      const result = await cloud.requestPasswordResetCode(passwordResetEmail.trim(), emailLanguage);
      setPasswordResetResendDeadline(Date.now() + result.resendAfterSeconds * 1000);
      setPasswordResetClock(Date.now());
      setPasswordResetCode('');
    } catch (error) {
      setPasswordResetError(passwordResetErrorMessage(error));
    } finally {
      setPasswordResetBusy(false);
    }
  };

  const confirmPasswordResetCode = async () => {
    if (passwordResetBusy || passwordResetCode.length !== 6) return;
    setPasswordResetBusy(true);
    setPasswordResetError(null);
    try {
      await cloud.confirmPasswordResetCode(passwordResetEmail.trim(), passwordResetCode, passwordResetPassword);
      setLoginIdentifier(passwordResetEmail.trim());
      setLoginPassword('');
      setPasswordResetPassword('');
      setPasswordResetConfirmPassword('');
      setPasswordResetCode('');
      setPasswordResetResendDeadline(null);
      setView('login');
      toast.success(t('preferences.cloud.passwordReset.success'));
    } catch (error) {
      setPasswordResetError(passwordResetErrorMessage(error));
    } finally {
      setPasswordResetBusy(false);
    }
  };

  const disabled = loading || busy || registrationBusy || passwordResetBusy || googleBusy;
  const isDialog = layout === 'dialog';
  const backFromAuthStep = () => setView(
    view === 'login' ? 'choices'
      : view === 'register' ? 'login'
        : view === 'verify' ? 'register'
          : view === 'password-reset' ? 'login'
            : 'password-reset',
  );
  const authStepTitle = t(view === 'login'
    ? 'preferences.cloud.auth.loginTitle'
    : view === 'register'
      ? 'preferences.cloud.auth.registerTitle'
      : view === 'verify'
        ? 'preferences.cloud.registration.verifyTitle'
        : view === 'password-reset'
          ? 'preferences.cloud.passwordReset.title'
          : 'preferences.cloud.passwordReset.codeTitle');

  return (
    <>
      <Dialog open={restoreAccountOpen} onOpenChange={setRestoreAccountOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('preferences.cloud.restore.title')}</DialogTitle></DialogHeader>
          <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.cloud.restore.description')}</p>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRestoreAccountOpen(false)}>{t('preferences.cloud.restore.cancel')}</Button>
            <Button disabled={busy} onClick={() => void loginWithCredentials(true)}>{t('preferences.cloud.restore.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className={`mx-auto w-full max-w-[372px] ${isDialog ? 'space-y-0' : ''}`}>
        {isDialog && (loadError ?? state?.authError) && (
          <p role="alert" className="mb-4 break-words text-sm text-[var(--destructive)]">
            {cloudSyncErrorMessage(loadError ?? state?.authError, t, 'errors.friendly.accountLoad')}
          </p>
        )}
        {view === 'choices' ? (
          isDialog ? (
            <DialogHeader className="mb-5">
              <DialogTitle>{t('notebook.cloudLogin.title')}</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed">{t('notebook.cloudLogin.description')}</DialogDescription>
            </DialogHeader>
          ) : (
            <header className="mb-5">
              <h2 className="text-xl font-semibold leading-tight tracking-[-0.025em] text-[var(--foreground)]">
                {t('notebook.cloudLogin.title')}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-[var(--muted-foreground)]">
                {t('notebook.cloudLogin.description')}
              </p>
            </header>
          )
        ) : (['login', 'register', 'verify', 'password-reset', 'password-reset-verify'].includes(view)) ? (
          isDialog ? (
            <DialogHeader className="mb-5">
              <div className="flex flex-row items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="-ml-2 shrink-0 text-[var(--muted-foreground)] hover:bg-transparent dark:hover:bg-transparent"
                  aria-label={t('preferences.cloud.auth.back')}
                  disabled={disabled}
                  onClick={backFromAuthStep}
                >
                  <ChevronLeft className="size-5" aria-hidden="true" />
                </Button>
                <DialogTitle className="min-w-0">{authStepTitle}</DialogTitle>
              </div>
              {view === 'password-reset' && (
                <DialogDescription className="leading-relaxed">{t('preferences.cloud.passwordReset.description')}</DialogDescription>
              )}
              {view === 'password-reset-verify' && (
                <DialogDescription className="break-all leading-relaxed">
                  {t('preferences.cloud.passwordReset.codeSent', { email: passwordResetEmail })}
                </DialogDescription>
              )}
            </DialogHeader>
          ) : (
            <header className="mb-5">
              <div className="flex flex-row items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="-ml-2 shrink-0 text-[var(--muted-foreground)] hover:bg-transparent dark:hover:bg-transparent"
                  aria-label={t('preferences.cloud.auth.back')}
                  disabled={disabled}
                  onClick={backFromAuthStep}
                >
                  <ChevronLeft className="size-5" aria-hidden="true" />
                </Button>
                <h2 className="min-w-0 text-xl font-semibold leading-tight tracking-[-0.025em] text-[var(--foreground)]">{authStepTitle}</h2>
              </div>
              {view === 'password-reset' && (
                <p className="mt-1 text-sm leading-relaxed text-[var(--muted-foreground)]">{t('preferences.cloud.passwordReset.description')}</p>
              )}
              {view === 'password-reset-verify' && (
                <p className="mt-1 break-all text-sm leading-relaxed text-[var(--muted-foreground)]">
                  {t('preferences.cloud.passwordReset.codeSent', { email: passwordResetEmail })}
                </p>
              )}
            </header>
          )
        ) : null}
        {view === 'choices' ? (
          <div className="space-y-4">
            <Button variant="outline" size="lg" className="relative h-10 w-full gap-2 rounded-xl bg-[var(--card)]" disabled={disabled} onClick={() => setView('login')}>
              <Mail className="absolute left-4 size-5" aria-hidden="true" />
              {t('preferences.cloud.existingAccount')}
            </Button>
            <Button variant="outline" size="lg" className="relative h-10 w-full gap-2 rounded-xl bg-[var(--card)]" disabled={disabled} onClick={() => void startGoogleSignIn()}>
              {googleBusy
                ? <Loader2 className="absolute left-4 size-4 animate-spin" aria-hidden="true" />
                : <img src={googleLogo} alt="" aria-hidden="true" className="absolute left-4 h-5 w-5 object-contain" />}
              {googleBusy ? t('preferences.cloud.loggingIn') : t('preferences.cloud.googleSignIn')}
            </Button>
            <div aria-hidden="true" className="py-1">
              <span className="block h-px w-full bg-[var(--border)]" />
            </div>
            <div className="flex items-center justify-between gap-4 px-1">
              <div className="flex shrink-0 items-center text-xs">
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-xs text-[var(--foreground)] hover:text-[var(--foreground)]"
                  disabled={disabled}
                  onClick={() => { setRegistrationError(null); setView('register'); }}
                >
                  {t('preferences.cloud.registration.startRegister')}
                </Button>
              </div>
              <p className="min-w-0 flex-1 text-right text-xs text-[var(--muted-foreground)]">
                {t('preferences.cloud.registration.continueLegal')}{' '}
                <a href={legalUrls.privacy} className="text-[var(--primary)] underline" onClick={(event) => { event.preventDefault(); void openUrl(legalUrls.privacy); }}>{t('preferences.cloud.registration.privacyPolicy')}</a>
                {' '}{t('preferences.cloud.registration.agreementConjunction')}{' '}
                <a href={legalUrls.terms} className="text-[var(--primary)] underline" onClick={(event) => { event.preventDefault(); void openUrl(legalUrls.terms); }}>{t('preferences.cloud.registration.termsOfService')}</a>.
              </p>
            </div>
          </div>
        ) : view === 'login' ? (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void loginWithCredentials(); }}>
            <label className="block">
              <span className="sr-only">{t('preferences.cloud.email')}</span>
              <Input className="h-10 rounded-xl bg-[var(--card)] px-4 text-base placeholder:text-[var(--input-placeholder)]" value={loginIdentifier} onChange={(event) => setLoginIdentifier(event.target.value)} placeholder={t('preferences.cloud.email')} autoComplete="username" autoFocus required />
            </label>
            <div>
              <label htmlFor="cloud-login-password" className="sr-only">{t('preferences.cloud.password')}</label>
              <span className="relative block">
                <Input id="cloud-login-password" type={loginPasswordVisible ? 'text' : 'password'} className="h-10 rounded-xl bg-[var(--card)] py-2 pl-4 pr-12 text-base placeholder:text-[var(--input-placeholder)]" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} placeholder={t('preferences.cloud.auth.passwordPlaceholder')} autoComplete="current-password" required />
                <Button type="button" variant="ghost" size="icon-sm" className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)]" aria-label={t(loginPasswordVisible ? 'preferences.cloud.auth.hidePassword' : 'preferences.cloud.auth.showPassword')} aria-pressed={loginPasswordVisible} onClick={() => setLoginPasswordVisible((visible) => !visible)}>
                  {loginPasswordVisible ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
                </Button>
              </span>
            </div>
            <Button type="submit" className="h-10 w-full rounded-xl" disabled={loading || busy}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              <span>{busy ? t('preferences.cloud.loggingIn') : t('preferences.cloud.auth.signIn')}</span>
            </Button>
            <div className="flex items-center justify-start gap-2 pt-3 text-xs">
              <p className="whitespace-nowrap text-[var(--muted-foreground)]">
                {t('preferences.cloud.registration.noAccount')}{' '}
                <Button type="button" variant="link" className="h-auto px-0 text-xs text-[var(--foreground)] hover:text-[var(--foreground)]" disabled={disabled} onClick={() => { setRegistrationError(null); setView('register'); }}>
                  {t('preferences.cloud.registration.startRegister')}
                </Button>
              </p>
              <span role="separator" aria-orientation="vertical" className="h-3 w-px shrink-0 bg-[var(--border)]" />
              <Button type="button" variant="link" size="sm" className="h-auto px-0 text-xs text-[var(--foreground)] hover:text-[var(--foreground)]" disabled={disabled} onClick={beginPasswordReset}>{t('preferences.cloud.passwordReset.forgot')}</Button>
            </div>
          </form>
        ) : view === 'register' ? (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void requestRegistrationCode(); }}>
            <label className="block">
              <span className="sr-only">{t('preferences.cloud.email')}</span>
              <Input type="email" className="h-10 rounded-xl bg-[var(--card)] px-4 text-base placeholder:text-[var(--input-placeholder)]" value={registrationEmail} onChange={(event) => setRegistrationEmail(event.target.value)} placeholder={t('preferences.cloud.email')} autoComplete="email" maxLength={254} autoFocus required />
            </label>
            <div>
              <label htmlFor="cloud-register-password" className="sr-only">{t('preferences.cloud.password')}</label>
              <span className="relative block">
                <Input id="cloud-register-password" type={registrationPasswordVisible ? 'text' : 'password'} className="h-10 rounded-xl bg-[var(--card)] py-2 pl-4 pr-12 text-base placeholder:text-[var(--input-placeholder)]" value={registrationPassword} onChange={(event) => setRegistrationPassword(event.target.value)} placeholder={t('preferences.cloud.auth.registerPasswordPlaceholder')} autoComplete="new-password" minLength={10} maxLength={200} required />
                <Button type="button" variant="ghost" size="icon-sm" className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)]" aria-label={t(registrationPasswordVisible ? 'preferences.cloud.auth.hidePassword' : 'preferences.cloud.auth.showPassword')} aria-pressed={registrationPasswordVisible} onClick={() => setRegistrationPasswordVisible((visible) => !visible)}>
                  {registrationPasswordVisible ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
                </Button>
              </span>
            </div>
            {registrationError && <p role="alert" className="text-xs text-[var(--destructive)]">{registrationError}</p>}
            <Button type="submit" className="h-10 w-full rounded-xl" disabled={loading || registrationBusy}>
              {registrationBusy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              <span>{registrationBusy ? t('preferences.cloud.registration.sendingCode') : t('preferences.cloud.registration.sendCode')}</span>
            </Button>
            <div className="grid grid-cols-2 items-start gap-3 pt-3 text-xs">
              <p className="min-w-0 text-left text-xs text-[var(--muted-foreground)]">
                {t('preferences.cloud.auth.alreadyHaveAccount')}{' '}
                <Button type="button" variant="link" className="h-auto px-0 text-xs text-[var(--foreground)] hover:text-[var(--foreground)]" disabled={disabled} onClick={() => setView('login')}>{t('preferences.cloud.auth.signIn')}</Button>
              </p>
              <p className="min-w-0 text-right text-xs leading-4 text-[var(--muted-foreground)]">
                {t('preferences.cloud.registration.continueRegisterLegal')}{' '}
                <a href={legalUrls.privacy} target="_blank" rel="noopener noreferrer" className="text-[var(--primary)] underline-offset-2 hover:underline" onClick={(event) => { event.preventDefault(); void openUrl(legalUrls.privacy).catch((error) => console.error('Failed to open Flowix privacy policy:', error)); }}>{t('preferences.cloud.registration.privacyPolicy')}</a>
                {' '}{t('preferences.cloud.registration.agreementConjunction')}{' '}
                <a href={legalUrls.terms} target="_blank" rel="noopener noreferrer" className="text-[var(--primary)] underline-offset-2 hover:underline" onClick={(event) => { event.preventDefault(); void openUrl(legalUrls.terms).catch((error) => console.error('Failed to open Flowix terms of service:', error)); }}>{t('preferences.cloud.registration.termsOfService')}</a>
              </p>
            </div>
          </form>
        ) : view === 'verify' ? (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void confirmRegistration(); }}>
            <p className="break-all text-sm text-[var(--muted-foreground)]">{t('preferences.cloud.registration.codeSent', { email: registrationEmail })}</p>
            <div>
              <label htmlFor="cloud-registration-code" className="sr-only">{t('preferences.cloud.registration.code')}</label>
              <div className="flex items-center gap-2">
                <Input id="cloud-registration-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} className="h-10 min-w-0 flex-1 rounded-xl bg-[var(--card)] text-left font-mono text-lg tracking-[0.35em]" value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus required />
                <Button type="button" variant="outline" className="h-10 shrink-0 rounded-xl bg-[var(--card)] px-3 hover:bg-[var(--card)] dark:bg-[var(--card)] dark:hover:bg-[var(--card)]" disabled={registrationBusy || registrationResendSeconds > 0} onClick={() => void resendRegistrationCode()}>
                  {registrationResendSeconds > 0 ? t('preferences.cloud.registration.resendIn', { seconds: registrationResendSeconds }) : t('preferences.cloud.registration.resendCode')}
                </Button>
              </div>
            </div>
            {registrationNotice && <p role="status" className="text-xs text-[var(--muted-foreground)]">{registrationNotice}</p>}
            {registrationError && <p role="alert" className="text-xs text-[var(--destructive)]">{registrationError}</p>}
            <Button type="submit" className="h-10 w-full rounded-xl" disabled={loading || registrationBusy || registrationCode.length !== 6}>{registrationBusy ? t('preferences.cloud.registration.verifying') : t('preferences.cloud.registration.verifyAndCreate')}</Button>
          </form>
        ) : view === 'password-reset' ? (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void requestPasswordResetCode(); }}>
            <label className="block">
              <span className="sr-only">{t('preferences.cloud.email')}</span>
              <Input type="email" className="h-10 rounded-xl bg-[var(--card)] px-4 text-base placeholder:text-[var(--input-placeholder)]" value={passwordResetEmail} onChange={(event) => setPasswordResetEmail(event.target.value)} placeholder={t('preferences.cloud.email')} autoComplete="email" maxLength={254} autoFocus required />
            </label>
            <label className="block">
              <span className="sr-only">{t('preferences.cloud.passwordReset.newPassword')}</span>
              <Input type="password" className="h-10 rounded-xl bg-[var(--card)] px-4 text-base placeholder:text-[var(--input-placeholder)]" value={passwordResetPassword} onChange={(event) => setPasswordResetPassword(event.target.value)} placeholder={t('preferences.cloud.passwordReset.newPassword')} autoComplete="new-password" minLength={10} maxLength={200} required />
            </label>
            <label className="block">
              <span className="sr-only">{t('preferences.cloud.passwordReset.confirmPassword')}</span>
              <Input type="password" className="h-10 rounded-xl bg-[var(--card)] px-4 text-base placeholder:text-[var(--input-placeholder)]" value={passwordResetConfirmPassword} onChange={(event) => setPasswordResetConfirmPassword(event.target.value)} placeholder={t('preferences.cloud.passwordReset.confirmPassword')} autoComplete="new-password" minLength={10} maxLength={200} required />
            </label>
            {passwordResetError && <p role="alert" className="text-xs text-[var(--destructive)]">{passwordResetError}</p>}
            <div className="space-y-2">
              <Button type="submit" className="h-10 w-full rounded-xl" disabled={loading || passwordResetBusy}>{passwordResetBusy ? t('preferences.cloud.passwordReset.sendingCode') : t('preferences.cloud.passwordReset.sendCode')}</Button>
            </div>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void confirmPasswordResetCode(); }}>
            <label className="block space-y-1 text-sm">
              <span className="text-[var(--muted-foreground)]">{t('preferences.cloud.registration.code')}</span>
              <Input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} className="h-10 rounded-xl text-center font-mono text-lg tracking-[0.35em]" value={passwordResetCode} onChange={(event) => setPasswordResetCode(event.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus required />
              <span className="block text-xs text-[var(--muted-foreground)]">{t('preferences.cloud.registration.codeHint')}</span>
            </label>
            {passwordResetError && <p role="alert" className="text-xs text-[var(--destructive)]">{passwordResetError}</p>}
            <div className="space-y-2">
              <Button type="button" variant="outline" className="h-10 w-full rounded-xl" disabled={passwordResetBusy || passwordResetResendSeconds > 0} onClick={() => void resendPasswordResetCode()}>
                {passwordResetResendSeconds > 0 ? t('preferences.cloud.registration.resendIn', { seconds: passwordResetResendSeconds }) : t('preferences.cloud.registration.resendCode')}
              </Button>
            </div>
            <div className="space-y-2">
              <Button type="submit" className="h-10 w-full rounded-xl" disabled={loading || passwordResetBusy || passwordResetCode.length !== 6}>{passwordResetBusy ? t('preferences.cloud.passwordReset.submitting') : t('preferences.cloud.passwordReset.submit')}</Button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
