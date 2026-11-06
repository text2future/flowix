'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, ChevronRight, Store } from 'lucide-react';
import { openSkillMarketUi } from '@features/surface/public/open-skill-market-ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { TREE_EDGE_GUTTER } from './notebook-tree-layout';

export function NotebookMoreSection({
  order,
  onHeightChange,
  sectionActions,
  compactTopSpacing = false,
}: {
  order: number;
  onHeightChange: (height: number) => void;
  sectionActions?: ReactNode;
  compactTopSpacing?: boolean;
}) {
  const { t } = useI18n();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const reportHeight = () => onHeightChange(section.getBoundingClientRect().height);
    reportHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(section);
    return () => observer.disconnect();
  }, [collapsed, onHeightChange]);

  return (
    <section
      ref={sectionRef}
      className={cn('pb-3', compactTopSpacing && '-mt-2.5')}
      aria-label={t('memo.fileTree.moreTitle')}
      data-notebook-more-section="true"
      style={{ order }}
    >
      <div
        className="notebook-file-tree__section-header group mb-0.5 flex h-7 items-center rounded-lg px-1.5 transition-colors hover:bg-[var(--muted)]"
        style={{ marginLeft: TREE_EDGE_GUTTER, width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)` }}
      >
        <button
          type="button"
          className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
          aria-label={t(collapsed ? 'memo.fileTree.expandMore' : 'memo.fileTree.collapseMore')}
          title={t(collapsed ? 'memo.fileTree.expandMore' : 'memo.fileTree.collapseMore')}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>{t('memo.fileTree.moreTitle')}</span>
          <ChevronRight className={cn(
            'h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100',
            collapsed && 'opacity-100',
            !collapsed && 'rotate-90',
          )} aria-hidden="true" />
        </button>
        <div className="ml-auto flex items-center">{sectionActions}</div>
      </div>
      {!collapsed && (
        <>
          <button
            type="button"
            onClick={() => void openSkillMarketUi('skills')}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--brand)]"
            style={{ marginLeft: TREE_EDGE_GUTTER, width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)` }}
          >
            <Store className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate opacity-[0.82]">{t('agent.empty.skillMarket')}</span>
          </button>
          <button
            type="button"
            onClick={() => void openSkillMarketUi('templates')}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--brand)]"
            style={{ marginLeft: TREE_EDGE_GUTTER, width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)` }}
          >
            <BookOpen className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate opacity-[0.82]">{t('memo.fileTree.knowledgeBase')}</span>
          </button>
        </>
      )}
    </section>
  );
}
