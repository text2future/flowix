'use client';

import { useSyncExternalStore, type ReactNode } from 'react';

import type { I18nKey } from '@/lib/i18n';
import { IntroCard } from '@shared/ui/intro-card';

const DISMISSED_KEY_PREFIX = 'flowix:tree-section-intro:dismissed:v2';
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
  const storeKey = `${DISMISSED_KEY_PREFIX}:${sectionId}`;
  const dismissed = useSyncExternalStore(
    subscribeToIntroStore,
    () => dismissedIntroKeys.has(storeKey) || wasDismissed(storeKey),
    () => false,
  );

  if (!enabled || dismissed) return <>{fallback}</>;

  return (
    <div
      style={{ marginLeft: edgeGutter, width: `calc(100% - ${edgeGutter * 2}px)` }}
      data-tree-section-intro-card={sectionId}
    >
      <IntroCard
        title={title}
        description={description}
        onDismiss={() => dismissIntro(storeKey)}
      />
    </div>
  );
}
