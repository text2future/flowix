'use client';

import { isWindowsPlatform } from '@/lib/path';
import { Ellipsis } from 'lucide-react';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';
import { useI18n } from '@/lib/i18n';
import { useWorkspaceHeaderCreation } from '../hooks/use-workspace-header-creation';
import { WorkspaceEmptyState } from '@shared/ui/workspace-empty-state';
import { WorkspaceColumnContextMenu } from './workspace-column-context-menu';

export function EmptyWorkspaceActions({ columnId }: { columnId: WorkspaceColumnId }) {
  const { t } = useI18n();
  const creation = useWorkspaceHeaderCreation(columnId);
  const openContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const trigger = event.currentTarget.closest<HTMLElement>('[data-workspace-column-context-menu-trigger]');
    if (!trigger) return;
    const rect = event.currentTarget.getBoundingClientRect();
    trigger.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: event.clientX || rect.right,
      clientY: event.clientY || rect.bottom,
    }));
  };

  return (
    <WorkspaceColumnContextMenu columnId={columnId} isWindows={isWindowsPlatform()}>
      <div className="h-full min-h-0 w-full">
        <WorkspaceEmptyState message="" className="px-6">
          <div className="relative flex flex-row items-center justify-center gap-2">
            <div className="inline-flex h-8 items-center overflow-hidden rounded-lg border border-[var(--border)] text-xs text-[var(--foreground)]">
              <button
                type="button"
                disabled={!creation.canCreate}
                onClick={() => void creation.createNote()}
                className="inline-flex h-full items-center whitespace-nowrap rounded-l-lg px-3 transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50"
              >
                {t('tabWindow.context.newNote')}
              </button>
              <button
                type="button"
                aria-label={t('memo.fileTree.moreActions')}
                title={t('memo.fileTree.moreActions')}
                onClick={openContextMenu}
                className="inline-flex h-8 w-7 shrink-0 self-stretch items-center justify-center rounded-r-lg border-l border-[var(--border)] transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50"
              >
                <Ellipsis className="h-3 w-3 shrink-0 -translate-y-px" aria-hidden="true" />
              </button>
            </div>
          </div>
        </WorkspaceEmptyState>
      </div>
    </WorkspaceColumnContextMenu>
  );
}
