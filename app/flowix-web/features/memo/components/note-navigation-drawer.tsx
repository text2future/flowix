'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { Notebook } from '@features/memo';
import { NoteNavigationPanel } from '@features/memo/components/note-navigation-panel';

interface NoteNavigationDrawerProps {
  open: boolean;
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onCreateNotebook: () => void;
  onOpenPreferences: (tab?: string) => void;
  activePluginId: string | null;
  onOpenPlugin: (plugin: PluginDescriptor) => void | Promise<void>;
  onClose: () => void;
}

/**
 * The note navigation is intentionally an overlay now. Keeping the panel
 * itself intact means notebook/tag/file interactions stay in one place while
 * the drawer owns only presentation concerns: backdrop, focus, and motion.
 */
export function NoteNavigationDrawer({
  open,
  notebooks,
  selectedNotebook,
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
  onCreateNotebook,
  onOpenPreferences,
  activePluginId,
  onOpenPlugin,
  onClose,
}: NoteNavigationDrawerProps) {
  const { t } = useI18n();
  const drawerRef = useRef<HTMLElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setIsClosing(false);
      drawerRef.current?.focus();
    } else {
      // The close callback changes `open` after the slide-out animation.
      // Reset this flag as well, otherwise the closed drawer keeps its
      // shadow forever and leaves a strip along the window's left edge.
      setIsClosing(false);
    }
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
    }, 160);
  }, [isClosing, onClose, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeWithAnimation();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeWithAnimation, open]);

  const handleSelectNotebook = useCallback((notebook: Notebook) => {
    onSelectNotebook(notebook);
  }, [onSelectNotebook]);

  const handleOpenPlugin = useCallback(async (plugin: PluginDescriptor) => {
    await onOpenPlugin(plugin);
    closeWithAnimation();
  }, [closeWithAnimation, onOpenPlugin]);

  return (
    <div
      className={cn(
        // Keep the drawer above the message interaction layer (z-index 70)
        // while leaving higher-level popovers/dialogs available above it.
        'absolute inset-0 z-[100] overflow-hidden',
        open && !isClosing ? 'pointer-events-auto' : 'pointer-events-none',
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label={t('memo.navigation.closeDrawer')}
        tabIndex={open ? 0 : -1}
        onClick={closeWithAnimation}
        className={cn(
          'absolute inset-0 h-full w-full cursor-default bg-transparent transition-opacity duration-150',
          open && !isClosing ? 'opacity-100' : 'opacity-0',
        )}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        tabIndex={-1}
        aria-label={t('memo.navigation.notebookNavigation')}
        aria-modal="true"
        className={cn(
          'relative m-1 h-[calc(100%-0.5rem)] w-[min(240px,calc(100vw-16px))] min-w-0 overflow-hidden rounded-xl',
          'border border-[var(--border-popup)] bg-[var(--card)] text-[var(--agent-foreground)]',
          'transition-transform duration-150 ease-out',
          open && !isClosing ? 'translate-x-0' : '-translate-x-[calc(100%+0.5rem)]',
          // Keep the navigation drawer shadow at a softened weight (24% -> 16%).
          open && !isClosing && 'shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.16)]',
        )}
      >
        <NoteNavigationPanel
          notebooks={notebooks}
          selectedNotebook={selectedNotebook}
          onSelectNotebook={handleSelectNotebook}
          onEditNotebook={onEditNotebook}
          onDeleteNotebook={onDeleteNotebook}
          onCreateNotebook={onCreateNotebook}
          onTogglePanel={closeWithAnimation}
          onOpenPreferences={onOpenPreferences}
          activePluginId={activePluginId}
          onOpenPlugin={handleOpenPlugin}
        />
      </aside>
    </div>
  );
}
