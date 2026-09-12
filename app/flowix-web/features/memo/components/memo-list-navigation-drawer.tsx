'use client';

import { Layers, ListTodo } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useMemoStore, type Notebook } from '@features/memo';
import { TagTree } from '@features/memo/components/tag-tree';

interface MemoListNavigationDrawerProps {
  open: boolean;
  selectedNotebook: Notebook | null;
  onClose: () => void;
}

export function MemoListNavigationDrawer({
  open,
  selectedNotebook,
  onClose,
}: MemoListNavigationDrawerProps) {
  const { t } = useI18n();
  const drawerRef = useRef<HTMLElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const setActiveFilter = useMemoStore((state) => state.setActiveFilter);

  useEffect(() => {
    if (open) setIsClosing(false);
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [open]);

  const closeWithAnimation = useCallback(() => {
    if (!open || isClosing) return;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 100);
  }, [isClosing, onClose, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeWithAnimation();
    };
    window.addEventListener('keydown', handleKeyDown);
    drawerRef.current?.focus();
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeWithAnimation, open]);

  const selectFilter = (filter: 'all' | 'todos') => {
    setActiveFilter(filter);
    closeWithAnimation();
  };

  const selectTag = () => {
    closeWithAnimation();
  };

  return (
    <div
      className={cn(
        'absolute inset-0 z-[40] overflow-hidden',
        open && !isClosing ? 'pointer-events-auto' : 'pointer-events-none',
      )}
      aria-hidden={!open}
    >
      <aside
        ref={drawerRef}
        tabIndex={-1}
        aria-label={t('memo.navigation.menuTitle')}
        className={cn(
          'absolute inset-y-0 left-0 flex w-full min-w-0 flex-col',
          'text-[var(--foreground)] shadow-xl',
          'transition-transform duration-100 ease-out',
          open && !isClosing ? 'translate-x-0' : '-translate-x-full',
        )}
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.8)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          willChange: 'transform',
        }}
      >
        <div className="relative z-[1] h-full min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          <div className="pt-3">
            <div className="agent-thread-card__access-section-label">
              {t('memo.navigation.notebookNavigation')}
            </div>
            <div className="space-y-0.5">
              <button
                type="button"
                className="group relative flex h-7 w-full cursor-pointer select-none items-center gap-0 rounded-lg pr-2 text-left text-sm text-[var(--foreground)] transition-[color] hover:bg-[var(--muted)]"
                style={{ paddingLeft: 6 }}
                onClick={() => selectFilter('all')}
              >
                <span className="mr-2 shrink-0 opacity-90">
                  <Layers className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate">{t('memo.navigation.all')}</span>
              </button>
              <button
                type="button"
                className="group relative flex h-7 w-full cursor-pointer select-none items-center gap-0 rounded-lg pr-2 text-left text-sm text-[var(--foreground)] transition-[color] hover:bg-[var(--muted)]"
                style={{ paddingLeft: 6 }}
                onClick={() => selectFilter('todos')}
              >
                <span className="mr-2 shrink-0 opacity-90">
                  <ListTodo className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate">{t('memo.list.filterTasks')}</span>
              </button>
            </div>
          </div>
          <TagTree
            selectedNotebook={selectedNotebook}
            onCountsChange={() => undefined}
            onSelectTag={selectTag}
            hideSelectionStyle
            hideSectionHeader
          />
        </div>
      </aside>
    </div>
  );
}
