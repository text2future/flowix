import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';

export function WorkColumnTitlebarNavigation({ sidebar, navigation, children }: {
  sidebar: { hidden: boolean; onToggle: () => void };
  navigation: {
    visible?: boolean;
    canNavigateBack: boolean;
    canNavigateForward: boolean;
    onNavigateBack: () => void;
    onNavigateForward: () => void;
  };
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const navClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35 [-webkit-app-region:no-drag]';
  return <div className="flex min-w-0 items-center gap-1">
    {sidebar.hidden && <button type="button" onClick={sidebar.onToggle}
      aria-label={t('document.titlebar.showSidebar')} title={t('document.titlebar.showSidebarTooltip')}
      className={navClass}>
      <SidebarToggleIcon className="h-4 w-4" variant="collapsed" />
    </button>}
    {navigation.visible !== false && <>
      <Tooltip content={t('document.titlebar.backTooltip')} shortcut="history.back">
        <button type="button" onClick={navigation.onNavigateBack} disabled={!navigation.canNavigateBack}
          aria-label={t('document.titlebar.back')} className={navClass}><ChevronLeft className="h-4 w-4" /></button>
      </Tooltip>
      <Tooltip content={t('document.titlebar.forwardTooltip')} shortcut="history.forward">
        <button type="button" onClick={navigation.onNavigateForward} disabled={!navigation.canNavigateForward}
          aria-label={t('document.titlebar.forward')} className={navClass}><ChevronRight className="h-4 w-4" /></button>
      </Tooltip>
    </>}
    {children}
  </div>;
}
