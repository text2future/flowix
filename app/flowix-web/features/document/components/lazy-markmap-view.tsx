import { lazy, Suspense } from 'react';
import { useI18n } from '@features/i18n';

const LazyMarkmap = lazy(() =>
  import('./markmap/markmap-view').then((module) => ({ default: module.MarkmapView })),
);

export function LazyMarkmapView({ content }: { content: string }) {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={(
        <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
          {t('document.markmap.loading')}
        </div>
      )}
    >
      <LazyMarkmap content={content} />
    </Suspense>
  );
}
