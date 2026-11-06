'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { useI18n, type I18nKey } from '@/lib/i18n';
import { Button } from '@shared/ui/button';

const DISMISSED_KEY_PREFIX = 'flowix:tree-section-intro:dismissed:v1';
const dismissedIntroKeys = new Set<string>();
const introStoreListeners = new Set<() => void>();

function wasDismissed(key: string) {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function subscribeToIntroStore(listener: () => void) {
  introStoreListeners.add(listener);
  if (typeof window !== 'undefined') {
    const handleStorage = (event: StorageEvent) => {
      if (event.key?.startsWith(`${DISMISSED_KEY_PREFIX}:`)) listener();
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      introStoreListeners.delete(listener);
      window.removeEventListener('storage', handleStorage);
    };
  }
  return () => { introStoreListeners.delete(listener); };
}

function dismissIntro(key: string) {
  if (dismissedIntroKeys.has(key)) return;
  dismissedIntroKeys.add(key);
  try {
    window.localStorage.setItem(key, 'true');
  } catch {
    // Keep the card dismissible when browser storage is unavailable.
  }
  introStoreListeners.forEach((listener) => listener());
}

export function TreeSectionIntroCard({
  sectionId,
  title,
  description,
  edgeGutter = 6,
  enabled = true,
  fallback,
}: {
  sectionId: 'agents' | 'repositories';
  title: I18nKey;
  description: I18nKey;
  edgeGutter?: number;
  enabled?: boolean;
  fallback: ReactNode;
}) {
  const { t } = useI18n();
  const storeKey = `${DISMISSED_KEY_PREFIX}:${sectionId}`;
  const dismissed = useSyncExternalStore(
    subscribeToIntroStore,
    () => dismissedIntroKeys.has(storeKey) || wasDismissed(storeKey),
    () => false,
  );

  if (!enabled || dismissed) return <>{fallback}</>;

  return (
    <div
      className="px-1.5 py-1"
      style={{ marginLeft: edgeGutter, width: `calc(100% - ${edgeGutter * 2}px)` }}
      data-tree-section-intro-card={sectionId}
    >
      <section
        aria-label={t(title)}
        className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-medium leading-5 text-[var(--foreground)]">
            {t(title)}
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-mr-1 -mt-1 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)] active:bg-transparent"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={(event) => {
              event.stopPropagation();
              dismissIntro(storeKey);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <p className="mt-1 text-sm leading-5 text-[var(--muted-foreground)]">
          {t(description)}
        </p>
      </section>
    </div>
  );
}
