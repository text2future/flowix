'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Bell, X } from 'lucide-react';

import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';

export function IntroCard({
  title,
  description,
  onDismiss,
  headingLevel = 3,
  style,
}: {
  title: I18nKey;
  description: I18nKey;
  onDismiss: () => void;
  headingLevel?: 2 | 3;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const containerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [closingHeight, setClosingHeight] = useState<number | null>(null);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
  }, []);

  const handleDismiss = () => {
    if (isClosing) return;
    const container = containerRef.current;
    if (!container) {
      onDismiss();
      return;
    }

    setClosingHeight(container.getBoundingClientRect().height);
    setIsClosing(true);
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      setClosingHeight(0);
    });
    dismissTimerRef.current = window.setTimeout(onDismiss, 160);
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'overflow-hidden px-1.5',
        isClosing
          ? 'py-0 transition-[height,padding] duration-[160ms] ease-in-out'
          : 'py-1',
      )}
      style={{
        ...style,
        ...(isClosing ? { height: `${closingHeight ?? 0}px` } : undefined),
      }}
    >
      <section
        aria-label={t(title)}
        className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <Heading className="flex min-w-0 items-center gap-1.5 text-base font-medium leading-6 text-[var(--foreground)]">
            <Bell className="h-4 w-4 shrink-0 text-[var(--primary)]" aria-hidden="true" />
            <span>{t(title)}</span>
          </Heading>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)] active:bg-transparent"
            aria-label={t('common.close')}
            title={t('common.close')}
            disabled={isClosing}
            onClick={(event) => {
              event.stopPropagation();
              handleDismiss();
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <p className="mt-1 text-sm leading-5 text-[var(--foreground)]">
          {t(description)}
        </p>
      </section>
    </div>
  );
}
