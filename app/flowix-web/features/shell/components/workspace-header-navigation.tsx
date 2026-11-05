import { useColumnEnvironment } from './column-environment';
import { hideBrowserColumn } from '@features/workspace/public/browser-column-api';
import { SidebarToggleIconRight } from '@shared/icons/sidebar-toggle-icon';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

export function WorkspaceHeaderNavigation({ sidebar, navigation, columnId = 'column-1', onCloseColumn = hideBrowserColumn }: {
  columnId?: WorkspaceColumnId;
  onCloseColumn?: () => void;
  sidebar: { hidden: boolean; onToggle: () => void };
  navigation: {
    visible?: boolean;
    canNavigateBack: boolean;
    canNavigateForward: boolean;
    onNavigateBack: () => void;
    onNavigateForward: () => void;
  };
}) {
  const { t } = useI18n();
  const environment = useColumnEnvironment();
  const index = environment?.index ?? (columnId === 'column-1' ? 0 : 1);
  const navClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35 [-webkit-app-region:no-drag]';
  return <div className="flex min-w-0 items-center gap-1">
    {index === 1 && <button type="button" className={navClass}
      aria-label={t('tabWindow.closeColumn')} onClick={onCloseColumn}>
      <SidebarToggleIconRight className="h-4 w-4" variant="expanded" />
    </button>}
    {index === 0 && (environment?.sidebarHidden ?? sidebar.hidden) && <button type="button" onClick={environment?.onToggleSidebar ?? sidebar.onToggle}
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
  </div>;
}
