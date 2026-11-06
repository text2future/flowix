'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { MemoListViewTabs, type MemoListViewTab } from '@features/memo/components/memo-list-view-tabs';
import { ListColumnGuideCard } from '@features/shell/components/list-column-guide-card';

interface ListColumnContentProps {
  activeView: MemoListViewTab;
  onViewChange: (view: MemoListViewTab) => void;
  children: ReactNode;
  conversationList?: ReactNode;
}

/** Stable ListColumn view switcher and its replaceable list surfaces. */
export function ListColumnContent({
  activeView,
  onViewChange,
  children,
  conversationList,
}: ListColumnContentProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousOpen = useRef(false);
  const interruptedTransform = useRef<string | null>(null);
  const drawerOpen = activeView === 'conversations';
  const hasConversationList = Boolean(conversationList);

  useLayoutEffect(() => {
    const drawer = drawerRef.current;
    const wasOpen = previousOpen.current;
    previousOpen.current = drawerOpen;
    if (!drawer || (!drawerOpen && !wasOpen) || typeof drawer.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const from = interruptedTransform.current ?? (wasOpen ? 'translateX(0)' : 'translateX(100%)');
    interruptedTransform.current = null;
    drawer.style.visibility = 'visible';
    const animation = drawer.animate(
      [{ transform: from }, { transform: drawerOpen ? 'translateX(0)' : 'translateX(100%)' }],
      // Keep in sync with --flowix-motion-duration / --flowix-motion-easing
      // in styles/index.css.
      { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    animation.onfinish = () => {
      drawer.style.visibility = drawerOpen ? 'visible' : 'hidden';
    };
    return () => {
      if (animation.playState === 'running') {
        interruptedTransform.current = window.getComputedStyle(drawer).transform;
      }
      animation.onfinish = null;
      animation.cancel();
    };
  }, [drawerOpen, hasConversationList]);

  return (
    <div className="sidebar-list-content relative isolate h-full min-h-0 bg-[var(--list-bg)]">
      <div className="absolute left-3 top-0 z-20">
        <MemoListViewTabs
          activeTab={activeView === 'conversations' ? 'folders' : activeView}
          onChange={onViewChange}
        />
      </div>
      <div className="absolute inset-0 z-0 overflow-hidden">
        <div
          className="sidebar-content-page--root absolute inset-0"
          data-page-active={activeView !== 'conversations'}
          inert={activeView === 'conversations'}
          aria-hidden={activeView === 'conversations'}
        >
          {children}
        </div>
        {conversationList && (
          <div data-sidebar-list-drawer-viewport className="sidebar-list-drawer-viewport pointer-events-none absolute inset-x-0 bottom-0 z-10 isolate overflow-hidden">
            <div
              ref={drawerRef}
              className="sidebar-content-page sidebar-content-page--detail absolute inset-0"
              data-page-active={activeView === 'conversations'}
              inert={activeView !== 'conversations'}
              aria-hidden={activeView !== 'conversations'}
            >
              {conversationList}
            </div>
          </div>
        )}
      </div>
      <ListColumnGuideCard activeView={activeView} onViewChange={onViewChange} />
    </div>
  );
}
