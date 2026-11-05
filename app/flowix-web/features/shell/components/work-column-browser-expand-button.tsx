import { useColumnEnvironment } from './column-environment';
import { SidebarToggleIconRight } from '@shared/icons/sidebar-toggle-icon';
import { toggleBrowserColumn, useBrowserColumnVisible } from '@features/workspace/public/browser-column-api';
import { useI18n } from '@/lib/i18n';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

/**
 * Work-column header button that expands the browser column. It mirrors the
 * collapse button in the browser column header (same `SidebarToggleIconRight`
 * family) and reuses the context menu's `toggleBrowserColumn` action. Hidden
 * once the browser column is open, so the two never appear together.
 */
export function WorkColumnBrowserExpandButton({ iconButtonClass, columnId = 'column-1' }: { iconButtonClass: string; columnId?: WorkspaceColumnId }) {
  const { t } = useI18n();
  const environment = useColumnEnvironment();
  const browserColumnVisible = useBrowserColumnVisible();
  if (browserColumnVisible || (environment?.index ?? (columnId === 'column-1' ? 0 : 1)) === 1) return null;
  return (
    <button
      type="button"
      className={`${iconButtonClass} [-webkit-app-region:no-drag]`}
      aria-label={t('tabWindow.expandColumn')}
      title={t('tabWindow.expandColumn')}
      aria-expanded={false}
      onClick={toggleBrowserColumn}
    >
      <SidebarToggleIconRight className="h-4 w-4" variant="collapsed" />
    </button>
  );
}
