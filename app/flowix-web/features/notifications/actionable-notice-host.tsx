'use client';

import { useSyncExternalStore } from 'react';
import { AlertCircle, AlertTriangle, Info, Loader2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@shared/ui/button';
import {
  dismissActionableNotice,
  getActionableNotices,
  runActionableNoticeAction,
  subscribeActionableNotices,
} from './actionable-notice-store';

const EMPTY_NOTICES: ReturnType<typeof getActionableNotices> = [];

export function ActionableNoticeHost() {
  const { t } = useI18n();
  const notices = useSyncExternalStore(
    subscribeActionableNotices,
    getActionableNotices,
    () => EMPTY_NOTICES,
  );
  if (notices.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed left-1/2 top-8 z-[2147483647] flex max-h-[calc(100vh-4rem)] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 overflow-y-auto px-0.5"
      data-actionable-notice-host
      role="region"
      aria-label={t('notifications.actionable.region')}
    >
      {notices.map((notice, index) => {
        const Icon = notice.tone === 'error' ? AlertCircle : notice.tone === 'warning' ? AlertTriangle : Info;
        const working = notice.busyActionId !== null && notice.busyActionId !== undefined;
        return (
          <section
            key={notice.id}
            role={notice.tone === 'neutral' ? 'status' : 'alert'}
            aria-live={index === 0 && notice.tone !== 'neutral' ? 'assertive' : 'polite'}
            className={`pointer-events-auto animate-in slide-in-from-top-2 fade-in duration-200 rounded-xl border bg-[var(--card)] px-4 py-3 text-sm text-[var(--foreground)] shadow-xl ${notice.tone === 'error' ? 'border-destructive/30' : notice.tone === 'warning' ? 'border-[color-mix(in_oklch,var(--warning)_30%,transparent)]' : 'border-[var(--border)]'}`}
          >
            <div className="flex items-start gap-3">
              {working
                ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--primary)]" aria-hidden="true" />
                : <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${notice.tone === 'error' ? 'text-destructive' : notice.tone === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--muted-foreground)]'}`} aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <strong className="block font-semibold">{notice.title}</strong>
                {notice.message && <p className="mt-1 whitespace-pre-line break-words text-[var(--muted-foreground)]">{notice.message}</p>}
                {notice.actionError && <p className="mt-1 break-words text-destructive">{notice.actionError}</p>}
                {notice.actions.length > 0 && (
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    {notice.actions.map((action) => (
                      <Button
                        key={action.id}
                        type="button"
                        size="sm"
                        variant={action.variant ?? 'default'}
                        className="rounded-lg"
                        disabled={working}
                        onClick={() => void runActionableNoticeAction(notice.id, action.id)}
                      >
                        {working && notice.busyActionId === action.id
                          ? t('notifications.actionable.working')
                          : action.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              {notice.dismissible && (
                <button
                  type="button"
                  className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                  aria-label={t('common.close')}
                  title={t('common.close')}
                  disabled={working}
                  onClick={() => dismissActionableNotice(notice.id)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
