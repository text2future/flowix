import { useSessionHostEnvironment } from './session-host-environment';
import { SidebarToggleIconRight } from '@shared/icons/sidebar-toggle-icon';
import { toggleBrowserColumn, useBrowserColumnVisible } from '@features/workspace/public/browser-column-api';
import { useI18n } from '@/lib/i18n';

/**
 * Work-column header button that expands the browser column. It mirrors the
 * collapse button in the browser column header (same `SidebarToggleIconRight`
 * family) and reuses the context menu's `toggleBrowserColumn` action. Hidden
 * once the browser column is open, so the two never appear together.
 */
export function WorkColumnBrowserExpandButton({ iconButtonClass }: { iconButtonClass: string }) {
  const { t } = useI18n();
  const environment = useSessionHostEnvironment();
  const browserColumnVisible = useBrowserColumnVisible();
  if (browserColumnVisible || environment?.host === 'browser-column') return null;
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
