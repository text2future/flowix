'use client';

import { isWindowsPlatform } from '@features/shortcuts';
import { WorkspaceHeader } from '@features/shell/public/work-column-api';
import { AgentConversationHeaderContent } from './agent-conversation-header-content';

export function AgentConversationTitlebar({
  reserveWindowsControls = true,
  instanceId,
  isMiddleColumnCollapsed,
  isSidebarVisible,
  onExpandSidebar,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
}: {
  instanceId: string;
  reserveWindowsControls?: boolean;
  isMiddleColumnCollapsed: boolean;
  isSidebarVisible: boolean;
  onExpandSidebar: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
}) {
  const isWindows = isWindowsPlatform();

  return <WorkspaceHeader columnId="column-1" isWindows={isWindows}
    presentation={{ chrome: 'agent', contentKind: 'agent-conversation' }}
    reserveWindowsControls={reserveWindowsControls}
    sidebar={{ hidden: isMiddleColumnCollapsed, noteNavigationVisible: isSidebarVisible, onToggle: onExpandSidebar }}
    navigation={{ canNavigateBack, canNavigateForward, onNavigateBack, onNavigateForward }}
    agent={(beforeMoreMenu) => <AgentConversationHeaderContent beforeMoreMenu={beforeMoreMenu} columnId="column-1" key={instanceId} instanceId={instanceId} />}
    className="agent-conversation-titlebar" />;
}
