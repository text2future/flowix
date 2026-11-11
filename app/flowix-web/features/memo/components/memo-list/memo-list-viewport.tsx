'use client';

import type { ReactNode, UIEventHandler } from 'react';
import { Loader2 } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { NoteListItem } from '@/types/note-item';
import { Button } from '@shared/ui/button';
import { ListSurfaceLoadingState } from '@shared/ui/list-surface';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { MemoListRows, type MemoRowKeepAliveChange } from './memo-list-rows';

interface MemoListViewportProps {
  active: boolean;
  items: readonly NoteListItem[];
  notebooksExist: boolean;
  scrollElement: HTMLDivElement | null;
  scrollerRef: (element: HTMLDivElement | null) => void;
  onScroll: UIEventHandler<HTMLDivElement>;
  showScrollTopHint: boolean;
  queryKey: string;
  error: { kind: 'initial' | 'refresh' | 'more' } | null;
  hasData: boolean;
  indexFailed: boolean;
  loading: boolean;
  skipInitialLoading: boolean;
  loadingMore: boolean;
  revealKey: string | null;
  onRevealed: () => void;
  renderRow: (item: NoteListItem, onKeepAliveChange: MemoRowKeepAliveChange) => ReactNode;
  onRetry: () => void;
  onRetryMore: () => void;
}

function EmptyState({ hasNotebooks }: { hasNotebooks: boolean }) {
  const { t } = useI18n();
  if (!hasNotebooks) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-[var(--muted-foreground)]">
        <span className="text-sm">{t('memo.list.emptyNoNotebook')}</span>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-lg border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          onClick={() => window.dispatchEvent(new Event('flowix:open-create-notebook'))}
        >
          {t('memo.list.createNotebook')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--muted-foreground)]">
      <span className="text-sm">{t('memo.list.emptyNotFound')}</span>
    </div>
  );
}

/** Owns the memo tab's scroll surface and its loading, error, and empty states. */
export function MemoListViewport({
  active,
  items,
  notebooksExist,
  scrollElement,
  scrollerRef,
  onScroll,
  showScrollTopHint,
  queryKey,
  error,
  hasData,
  indexFailed,
  loading,
  skipInitialLoading,
  loadingMore,
  revealKey,
  onRevealed,
  renderRow,
  onRetry,
  onRetryMore,
}: MemoListViewportProps) {
  const { t } = useI18n();

  return (
    <>
      <div className="absolute inset-0">
        <OverlayScrollbar
          className="flex h-full min-h-0 min-w-0 w-full"
          scrollerClassName="min-w-0 w-full flex-1 overflow-y-auto px-1 py-2"
          scrollerRef={scrollerRef}
          onScroll={onScroll}
        >
          {error?.kind === 'initial' || (!hasData && indexFailed) ? (
            <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 px-4 text-center" role="alert">
              <span className="text-sm text-[var(--muted-foreground)]">{t('memo.list.loadFailed')}</span>
              <Button size="sm" className="rounded-lg" onClick={onRetry}>{t('error.retry')}</Button>
            </div>
          ) : !hasData && loading ? (
            skipInitialLoading ? null : <ListSurfaceLoadingState ariaLabel={t('memo.list.loadingLibrary')} />
          ) : items.length > 0 ? (
            <div key={queryKey} className="flowix-list-content-enter">
              <MemoListRows
                enabled={active}
                items={items}
                scrollElement={scrollElement}
                queryKey={queryKey}
                revealKey={revealKey}
                onRevealed={onRevealed}
                renderRow={renderRow}
              />
            </div>
          ) : (
            <EmptyState hasNotebooks={notebooksExist} />
          )}
          {loadingMore && items.length > 0 && (
            <div className="flex h-10 items-center justify-center" role="status" aria-live="polite">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span className="sr-only">{t('memo.list.loadingMore')}</span>
            </div>
          )}
          {error?.kind === 'more' && (
            <div className="flex items-center justify-center gap-2 px-4 py-3 text-center text-xs text-[var(--muted-foreground)]" role="alert">
              <span>{t('memo.list.loadFailed')}</span>
              <Button size="sm" className="rounded-lg" onClick={onRetryMore}>{t('error.retry')}</Button>
            </div>
          )}
          {(error?.kind === 'refresh' || (hasData && indexFailed)) && (
            <div className="flex items-center justify-center gap-2 px-4 py-3 text-center text-xs text-[var(--muted-foreground)]" role="alert">
              <span>{t('memo.list.loadFailed')}</span>
              <Button size="sm" className="rounded-lg" onClick={onRetry}>{t('error.retry')}</Button>
            </div>
          )}
        </OverlayScrollbar>
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-[3] h-6 bg-gradient-to-b from-[var(--list-bg)] to-transparent transition-opacity duration-200',
          showScrollTopHint ? 'opacity-100' : 'opacity-0',
        )}
      />
    </>
  );
}
