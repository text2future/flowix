import { useWorkspaceFocusStore } from '../store/workspace-focus-store';
import type { WorkspaceColumnId } from '../model/surface-contract';

/** React portals share ancestors in React, but do not interact with the host DOM. */
export function focusWorkspaceColumnFromEvent(
  event: { currentTarget: HTMLElement; target: EventTarget | null },
  host: WorkspaceColumnId,
): void {
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
  useWorkspaceFocusStore.getState().focusColumn(host);
}
