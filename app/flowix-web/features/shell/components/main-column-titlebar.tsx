import { isMac } from '@features/shortcuts';
import { MainColumnTitlebarShell, type MainColumnTitlebarShellProps } from './main-column-titlebar-shell';
import { WorkspaceColumnContextMenu } from './workspace-column-context-menu';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

/** Main main-column menu coordinates host actions around the visual frame. */
export function MainColumnTitlebar({ columnId = 'column-1', ...props }: MainColumnTitlebarShellProps & { columnId?: WorkspaceColumnId }) {
  return (
    <WorkspaceColumnContextMenu columnId={columnId} isWindows={props.isWindows}>
      <MainColumnTitlebarShell {...props}
        showTrafficLightSpacer={isMac() && props.showTrafficLightSpacer} />
    </WorkspaceColumnContextMenu>
  );
}
