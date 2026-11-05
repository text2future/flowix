/** Workspace surface state consumed by the agent task panel and conversation list. */
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useColumnNavigation } from '@features/workspace/store/column-navigation';

/**
 * 主内容区（紧邻笔记列表的那一列）是唯一会话落点：会话列表与任务面板的
 * 「正在看」高亮只读它，不读焦点。焦点停在辅助栏不代表用户在看辅助栏。
 */
export function resolveActiveConversationInstanceId(input: {
  mainInstanceId: string | null;
  sideInstanceId: string | null;
  sideVisible: boolean;
}): string | null {
  if (input.mainInstanceId) return input.mainInstanceId;
  return input.sideVisible ? input.sideInstanceId : null;
}

/**
 * Used to highlight the conversation the user is already reading without
 * exposing the whole navigation model.
 */
export function useActiveAgentConversationInstanceId(): string | null {
  const sideVisible = useBrowserColumnStore((state) => state.visible);
  const mainInstanceId = useColumnNavigation(0, (navigation) => (
    navigation.current?.target.kind === 'agent-conversation'
      ? navigation.current.target.instanceId
      : null
  ));
  const sideInstanceId = useColumnNavigation(1, (navigation) => (
    navigation.current?.target.kind === 'agent-conversation' ? navigation.current.target.instanceId : null
  ));
  return resolveActiveConversationInstanceId({ mainInstanceId, sideInstanceId, sideVisible });
}
