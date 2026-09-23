'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import type { Notebook } from '@features/memo/store/memo-store';
import { MemoListTitlebarMac } from '@features/memo/components/memo-list-titlebar-mac';
import { MemoListTitlebarWin } from '@features/memo/components/memo-list-titlebar-win';
import type { NoteNavigationDrawerPhase } from '@features/memo/public/shell-api';
import { cn } from '@/lib/utils';

type ListColumnPreviewPhase = 'open' | 'closing';

interface ListColumnProps {
  hidden: boolean;
  previewVisible: boolean;
  previewPhase: ListColumnPreviewPhase;
  memoColWidth: number;
  isDraggingListDivider: boolean;
  selectedNotebook: Notebook | null;
  noteNavigationPhase: NoteNavigationDrawerPhase;
  onCollapseMemoList: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: (tab?: string) => void;
  onPreviewEnter: () => void;
  onPreviewLeave: () => void;
  onPointerDown: () => void;
  children: ReactNode;
}

function ListColumnChrome({
  previewVisible,
  selectedNotebook,
  noteNavigationPhase,
  onCollapseMemoList,
  onToggleNoteNavigation,
  onOpenPreferences,
}: Pick<
  ListColumnProps,
  | 'previewVisible'
  | 'selectedNotebook'
  | 'noteNavigationPhase'
  | 'onCollapseMemoList'
  | 'onToggleNoteNavigation'
  | 'onOpenPreferences'
>) {
  const props = {
    isPreview: previewVisible,
    selectedNotebook,
    noteNavigationVisible: noteNavigationPhase !== 'closed',
    onCollapseMemoList,
    onToggleNoteNavigation,
    onOpenPreferences,
  };

  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform)
    ? <MemoListTitlebarWin {...props} />
    : <MemoListTitlebarMac {...props} />;
}

/**
 * The middle list column shared by the docked sidebar and the hover preview.
 * The list content stays mounted as one subtree. The preview keeps the
 * titlebar's layout space while hiding its docked-only controls.
 */
export function ListColumn({
  hidden,
  previewVisible,
  previewPhase,
  memoColWidth,
  isDraggingListDivider,
  selectedNotebook,
  noteNavigationPhase,
  onCollapseMemoList,
  onToggleNoteNavigation,
  onOpenPreferences,
  onPreviewEnter,
  onPreviewLeave,
  onPointerDown,
  children,
}: ListColumnProps) {
  const previewRef = useRef<HTMLDivElement>(null);

  // Run the preview animation from the presence lifecycle only. In
  // particular, changing the navigation drawer must only update `left`; it
  // must not replay the preview's enter animation.
  useEffect(() => {
    const preview = previewRef.current;
    if (!previewVisible || !preview) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const animation = preview.animate(
      previewPhase === 'open'
        ? [
            { opacity: 0, transform: 'translate3d(-12px, 0, 0) scale(0.98)' },
            { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
          ]
        : [
            { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
            { opacity: 0, transform: 'translate3d(-12px, 0, 0) scale(0.98)' },
          ],
      {
        duration: previewPhase === 'open' ? 200 : 160,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'both',
      },
    );

    return () => animation.cancel();
  }, [previewPhase, previewVisible]);

  useEffect(() => {
    if (!previewVisible) return;

    const isOwnedOverlay = (target: EventTarget | null) => (
      target instanceof Element
      && Boolean(target.closest('[data-flowix-list-column-overlay]'))
    );

    const handlePointerOver = (event: PointerEvent) => {
      if (isOwnedOverlay(event.target)) onPreviewEnter();
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (!isOwnedOverlay(event.target)) return;
      const relatedTarget = event.relatedTarget;
      const isInsidePreview = relatedTarget instanceof Node
        && Boolean(previewRef.current?.contains(relatedTarget));
      if (isOwnedOverlay(relatedTarget) || isInsidePreview) {
        return;
      }
      onPreviewLeave();
    };

    document.addEventListener('pointerover', handlePointerOver);
    document.addEventListener('pointerout', handlePointerOut);
    return () => {
      document.removeEventListener('pointerover', handlePointerOver);
      document.removeEventListener('pointerout', handlePointerOut);
    };
  }, [onPreviewEnter, onPreviewLeave, previewVisible]);

  return (
    <div
      className={cn(
        'relative flex h-full shrink-0 flex-col will-change-[width]',
        isDraggingListDivider
          ? 'transition-none'
          : 'transition-[width] duration-150 ease-out',
        previewVisible ? 'overflow-visible' : 'overflow-hidden',
      )}
      style={{ width: hidden ? 0 : memoColWidth }}
      aria-hidden={hidden && !previewVisible}
      onPointerDown={onPointerDown}
    >
      <div
        ref={previewRef}
        data-memo-list-hover-preview={previewVisible ? '' : undefined}
        data-preview-state={previewVisible ? previewPhase : undefined}
        onMouseEnter={previewVisible ? onPreviewEnter : undefined}
        onMouseLeave={previewVisible ? onPreviewLeave : undefined}
        className={cn(
          'flex min-w-0 flex-col',
          previewVisible
            ? cn(
                'absolute left-0 top-0 m-1 h-[calc(100%-0.5rem)] w-[280px] overflow-hidden rounded-xl transition-[left] flowix-note-navigation-motion',
                noteNavigationPhase === 'open' ? 'z-[110]' : 'z-[90]',
                'border border-[var(--border-popup)] bg-[var(--list-bg)]',
                'shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]',
              )
            : 'relative h-full w-full overflow-hidden bg-[var(--list-bg)]',
        )}
        style={previewVisible && noteNavigationPhase === 'open'
          ? { left: 'calc(var(--flowix-note-navigation-drawer-width) + 0.25rem)' }
          : undefined}
      >
        <ListColumnChrome
          previewVisible={previewVisible}
          selectedNotebook={selectedNotebook}
          noteNavigationPhase={noteNavigationPhase}
          // In the hover preview the same control closes the popover. The
          // memo list is already hidden, so collapsing it again would not
          // dismiss the preview.
          onCollapseMemoList={previewVisible ? onPreviewLeave : onCollapseMemoList}
          onToggleNoteNavigation={onToggleNoteNavigation}
          onOpenPreferences={onOpenPreferences}
        />
        <div className="relative min-h-0 flex-1">
          {children}
        </div>
      </div>
    </div>
  );
}
