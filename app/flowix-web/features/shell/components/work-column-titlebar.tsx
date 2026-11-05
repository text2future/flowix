import { isMac } from '@features/shortcuts';
import { WorkColumnTitlebarShell, type WorkColumnTitlebarShellProps } from './work-column-titlebar-shell';
import { WorkspaceColumnContextMenu } from './workspace-column-context-menu';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

/** Main work-column menu coordinates host actions around the visual frame. */
export function WorkColumnTitlebar({ columnId = 'column-1', ...props }: WorkColumnTitlebarShellProps & { columnId?: WorkspaceColumnId }) {
  return (
    <WorkspaceColumnContextMenu columnId={columnId} isWindows={props.isWindows}>
      <WorkColumnTitlebarShell {...props}
        showTrafficLightSpacer={isMac() && props.showTrafficLightSpacer} />
    </WorkspaceColumnContextMenu>
  );
}
