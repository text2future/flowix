'use client';

import { useLayoutEffect, useRef } from 'react';
import { ChevronLeft, Plus } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import type { WorkspaceAgentRepository } from '@features/agent/public/workspace-api';
import { AgentRepositoriesSection } from './notebook-repositories-section';

interface NotebookRepositoriesPageProps {
  open: boolean;
  repositories: WorkspaceAgentRepository[];
  introEnabled: boolean;
  canAddRepository: boolean;
  onBack: () => void;
  onAddRepository: () => void;
  onRemoveRepository: (repository: WorkspaceAgentRepository) => void;
  onOpenFile: (path: string, scopePath: string) => void;
  onOpenFileInBrowserColumn: (path: string, scopePath: string) => void;
}

export function NotebookRepositoriesPage({
  open,
  repositories,
  introEnabled,
  canAddRepository,
  onBack,
  onAddRepository,
  onRemoveRepository,
  onOpenFile,
  onOpenFileInBrowserColumn,
}: NotebookRepositoriesPageProps) {
  const { t } = useI18n();
  const pageRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  const interruptedTransformRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open && !wasOpen) {
      page.style.visibility = 'hidden';
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof page.animate !== 'function') {
      page.style.transform = open ? 'translateX(0)' : 'translateX(100%)';
      page.style.visibility = open ? 'visible' : 'hidden';
      interruptedTransformRef.current = null;
      return;
    }
    const from = interruptedTransformRef.current
      ?? (wasOpen ? 'translateX(0)' : 'translateX(100%)');
    interruptedTransformRef.current = null;
    page.style.visibility = 'visible';
    const animation = page.animate(
      [{ transform: from }, { transform: open ? 'translateX(0)' : 'translateX(100%)' }],
      { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    animation.onfinish = () => {
      page.style.visibility = open ? 'visible' : 'hidden';
    };
    return () => {
      if (animation.playState === 'running') {
        interruptedTransformRef.current = window.getComputedStyle(page).transform;
      }
      animation.onfinish = null;
      animation.cancel();
    };
  }, [open]);

  return (
    <div
      ref={pageRef}
      className="sidebar-content-page sidebar-content-page--detail absolute inset-0 z-30 flex min-h-0 flex-col bg-[var(--list-bg)]"
      data-page-active={open}
      inert={!open}
      aria-hidden={!open}
      aria-label={t('memo.fileTree.repositoriesTitle')}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label={t('memo.navigation.backToFileTree')}
            title={t('memo.navigation.backToFileTree')}
            className="group flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-transparent p-0 text-sm text-[var(--foreground)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          >
            <ChevronLeft className="h-4 w-4 transition-[filter] duration-150 group-hover:brightness-125" aria-hidden="true" />
          </button>
          <span className="text-sm font-medium">{t('memo.fileTree.repositoriesTitle')}</span>
          <span className="text-xs text-[var(--muted-foreground)]">{repositories.length}</span>
        </div>
        <button
          type="button"
          onClick={onAddRepository}
          disabled={!canAddRepository}
          aria-label={t('agent.workspace.addRepository')}
          title={t('agent.workspace.addRepository')}
          className="group flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--foreground)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5 transition-[filter] duration-150 group-hover:brightness-125" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <AgentRepositoriesSection
          repositories={repositories}
          introEnabled={introEnabled}
          order={1}
          onHeightChange={() => {}}
          onAddRepository={onAddRepository}
          onRemoveRepository={onRemoveRepository}
          onExpandRepository={() => {}}
          canAddRepository={canAddRepository}
          onOpenFile={onOpenFile}
          onOpenFileInBrowserColumn={onOpenFileInBrowserColumn}
          hideSectionHeader
        />
      </div>
    </div>
  );
}
