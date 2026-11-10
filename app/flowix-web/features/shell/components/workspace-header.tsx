import type { ReactNode } from 'react';
import { Link2 } from 'lucide-react';
import {
  AgentThreadCardFullscreenExitButton, AgentThreadCardFullscreenIdentity,
  AgentThreadCardFullscreenMoreMenu, SurfaceHeaderIcon,
} from '@features/document/public/header-api';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';
import type { WorkspaceHeaderInput, WorkspaceHeaderModel } from '@features/workspace/public/header-api';
import { TITLEBAR_ICON_BUTTON_CLASS } from '@shared/ui/titlebar-icon-button';
import { useWorkspaceHeader } from '../hooks/use-workspace-header';
import { WorkspaceColumnContextMenu } from './workspace-column-context-menu';
import { WorkspaceHeaderShell } from './workspace-header-shell';
import { WorkspaceHeaderBreadcrumb, type WorkspaceHeaderBreadcrumbItem } from './workspace-header-breadcrumb';
import { WorkspaceHeaderIdentity } from './workspace-header-identity';
import { WorkspaceHeaderNavigation } from './workspace-header-navigation';
import { WorkColumnBrowserExpandButton } from './work-column-browser-expand-button';

export interface WorkspaceHeaderProps {
  /** Stable runtime namespace; physical placement comes from ColumnEnvironment. */
  columnId: WorkspaceColumnId;
  isWindows: boolean;
  presentation: WorkspaceHeaderInput;
  sidebar: { hidden: boolean; onToggle: () => void };
  navigation: {
    visible?: boolean;
    canNavigateBack: boolean; canNavigateForward: boolean;
    onNavigateBack: () => void; onNavigateForward: () => void;
  };
  reserveWindowsControls?: boolean;
  webAddressBarVisible?: boolean;
  onToggleWebAddressBar?: () => void;
  agent?: (beforeMoreMenu: ReactNode) => ReactNode;
  icon?: ReactNode;
  /** Path breadcrumb for documents; replaces the plain identity title when set. */
  breadcrumb?: WorkspaceHeaderBreadcrumbItem[] | null;
  /**
   * Column-local opener for a file picked inside a folder breadcrumb popover.
   * Omitted = the breadcrumb stays display-only (nothing owns the destination).
   */
  onBreadcrumbFileOpen?: (filePath: string, scopePath: string) => void;
  actions?: (header: WorkspaceHeaderModel, iconButtonClass: string) => ReactNode;
  onCloseColumn?: () => void;
  onCreateNote?: (templateId?: string) => void;
  onCreateAgentConversation?: Parameters<typeof WorkspaceColumnContextMenu>[0]['onCreateAgentConversation'];
  className?: string;
}

/** One header composition for every session, content kind and physical column. */
export function WorkspaceHeader({ columnId, isWindows, presentation, sidebar, navigation,
  reserveWindowsControls, webAddressBarVisible = false, onToggleWebAddressBar, agent, icon, breadcrumb, onBreadcrumbFileOpen, actions,
  onCloseColumn, onCreateNote, onCreateAgentConversation, className = '',
}: WorkspaceHeaderProps) {
  const { fullscreen, model: header } = useWorkspaceHeader(columnId, presentation);
  const iconButtonClass = `${TITLEBAR_ICON_BUTTON_CLASS} [-webkit-app-region:no-drag]`;
  const expandButton = <WorkColumnBrowserExpandButton columnId={columnId} iconButtonClass={iconButtonClass} />;
  return <WorkspaceColumnContextMenu isWindows={isWindows} onCreateNote={onCreateNote}
    onCreateAgentConversation={onCreateAgentConversation} columnId={columnId}>
    <WorkspaceHeaderShell as="header" isWindows={isWindows} header={header}
      reserveWindowsControls={reserveWindowsControls}
      showTrafficLightSpacer={sidebar.hidden}
      data-browser-column-header={columnId === 'column-2' ? '' : undefined}
      data-thread-card-fullscreen={fullscreen ? '' : undefined}
      className={`gap-1 ${isWindows ? '' : 'pr-2'} ${className}`}>
      <WorkspaceHeaderNavigation sidebar={sidebar} navigation={navigation}
        columnId={columnId} onCloseColumn={onCloseColumn} />
      <div className="flex min-w-0 flex-1 self-stretch items-center gap-2" data-tauri-drag-region>
        {fullscreen ? <AgentThreadCardFullscreenIdentity host={columnId} /> : agent?.(expandButton) ?? (
          breadcrumb && breadcrumb.length > 0
            ? <>
              {icon ?? <SurfaceHeaderIcon icon={header.identity?.icon ?? null} web={Boolean(onToggleWebAddressBar)} />}
              <WorkspaceHeaderBreadcrumb items={breadcrumb} onOpenFile={onBreadcrumbFileOpen} />
            </>
            : header.identity && <WorkspaceHeaderIdentity title={header.identity.title}
              icon={icon ?? <SurfaceHeaderIcon icon={header.identity.icon} web={Boolean(onToggleWebAddressBar)} />}
              className="font-medium" />
        )}
      </div>
      {(fullscreen || !agent) && <div data-tauri-drag-region className="ml-auto flex shrink-0 items-center gap-1 pr-2">
        <AgentThreadCardFullscreenExitButton host={columnId} className="agent-thread-card-fullscreen-exit-btn" />
        {expandButton}
        {fullscreen ? <AgentThreadCardFullscreenMoreMenu host={columnId} iconButtonClass={iconButtonClass} /> : <>
          {onToggleWebAddressBar && <button type="button" className={iconButtonClass}
            aria-label={webAddressBarVisible ? '隐藏网址条' : '显示网址条'}
            title={webAddressBarVisible ? '隐藏网址条' : '显示网址条'}
            aria-expanded={webAddressBarVisible} onClick={onToggleWebAddressBar}><Link2 className="h-4 w-4" /></button>}
          {actions?.(header, iconButtonClass)}
        </>}
      </div>}
    </WorkspaceHeaderShell>
  </WorkspaceColumnContextMenu>;
}
