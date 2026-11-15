'use client';

import { useState } from 'react';

import { IntroCard } from '@shared/ui/intro-card';

const DISMISSED_KEY = 'flowix:memo-list-intro:dismissed:v2';

function wasDismissed() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function MemoListIntroCard() {
  const [dismissed, setDismissed] = useState(wasDismissed);

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // Keep the card dismissible when browser storage is unavailable.
    }
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <div data-memo-list-intro-card>
      <IntroCard
        title="memo.list.intro.title"
        description="memo.list.intro.description"
        onDismiss={dismiss}
        headingLevel={2}
      />
    </div>
  );
}
