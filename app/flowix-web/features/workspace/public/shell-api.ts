import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { openWorkColumnTargetInBrowserColumn } from '@features/workspace/use-cases/browser-column-navigation';

export {
  BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
  BROWSER_COLUMN_MIN_WIDTH,
} from '@features/workspace/store/browser-column-store';
export type { WorkColumnTarget } from '@features/workspace/store/work-column-target';

export function useShellWorkspaceViewModel() {
  const navigation = useWorkColumnStore((state) => state.navigation);
  const browser = useBrowserColumnStore(useShallow((state) => ({
    browserColumnVisible: state.visible,
    browserColumnSplitRatio: state.splitRatio,
    setBrowserColumnSplitRatio: state.setSplitRatio,
  })));
  const focus = useWorkspaceFocusStore(useShallow((state) => ({
    focusWorkspaceHost: state.focusHost,
    focusedHostId: state.focusedHostId,
  })));
  return { navigation, ...browser, ...focus };
}

export function useWorkColumnTransferViewModel() {
  const target = useWorkColumnStore((state) => state.navigation.target);
  const canOpenInBrowserColumn = target.kind !== 'empty'
    && target.kind !== 'plugin-workbench';
  const openInBrowserColumn = useCallback(() => {
    if (!canOpenInBrowserColumn) return Promise.resolve(null);
    return openWorkColumnTargetInBrowserColumn(target);
  }, [canOpenInBrowserColumn, target]);
  return { canOpenInBrowserColumn, openInBrowserColumn };
}
