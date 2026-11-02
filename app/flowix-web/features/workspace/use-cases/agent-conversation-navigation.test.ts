import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkColumnTarget } from '../store/work-column-target';

const mocks = vi.hoisted(() => ({
  openAgentConversation: vi.fn().mockResolvedValue(undefined),
  beginNavigation: vi.fn().mockReturnValue(1),
  commitNavigation: vi.fn().mockReturnValue(true),
  failNavigation: vi.fn().mockReturnValue(true),
  isCurrentNavigation: vi.fn().mockReturnValue(true),
  activeAgentConversationId: 'conversation-a',
  activeFilter: 'all',
  navigationRevision: 1,
  navigationTarget: { kind: 'empty' } as WorkColumnTarget,
  hydrateInstance: vi.fn(),
  selectAgentConversation: vi.fn(),
  setDesiredTarget: vi.fn(),
  clearAgentConversation: vi.fn(),
  clearDocument: vi.fn(),
  agentRestore: {
    selectedInstanceId: 'conversation-a' as string | null,
    detailOpen: true,
  },
  setActivePluginId: vi.fn(),
}));

vi.mock('@features/agent/store/agent-session-store', () => ({
  useAgentSessionStore: {
    getState: () => ({
      hydrateInstance: mocks.hydrateInstance,
      // `hasWorkspaceAgentConversation` 现在是异步的（store 走动态 import），
      // 它需要 getInstance 判断实例是否已在内存；这里统一返回"不在内存"，
      // 让流程继续走到 hydrate。
      getInstance: () => null,
    }),
  },
}));

vi.mock('@features/document/store/document-store', () => ({
  useDocumentStore: {
    getState: () => ({
      openAgentConversation: mocks.openAgentConversation,
      clearDocument: mocks.clearDocument,
      activeAgentConversationId: mocks.activeAgentConversationId,
    }),
  },
}));

vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: {
    getState: () => ({
      activeFilter: mocks.activeFilter,
      setActivePluginId: mocks.setActivePluginId,
    }),
  },
}));

vi.mock('@features/workspace/store/workspace-restore-store', () => ({
  useWorkspaceRestoreStore: {
    getState: () => ({
      agentConversation: mocks.agentRestore,
      desiredTarget: mocks.agentRestore.detailOpen && mocks.agentRestore.selectedInstanceId
        ? { kind: 'agent-conversation', instanceId: mocks.agentRestore.selectedInstanceId }
        : null,
      selectAgentConversation: mocks.selectAgentConversation,
      setDesiredTarget: mocks.setDesiredTarget,
      clearAgentConversation: mocks.clearAgentConversation,
    }),
  },
}));

vi.mock('@features/workspace/store/work-column-store', () => ({
  useWorkColumnStore: {
    getState: () => ({
      navigation: { phase: 'committed', showWorkColumnLoading: false, requestId: mocks.navigationRevision, target: mocks.navigationTarget, pendingTarget: null, previousTarget: null, failure: null, retryToken: null },
      beginNavigation: mocks.beginNavigation,
      commitNavigation: mocks.commitNavigation,
      failNavigation: mocks.failNavigation,
      isCurrentNavigation: mocks.isCurrentNavigation,
    }),
  },
}));

import { selectAndOpenAgentConversation } from './agent-conversation-navigation';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

describe('agent conversation navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeFilter = 'all';
    mocks.navigationRevision = 1;
    mocks.navigationTarget = { kind: 'plugin-workbench', plugin: { manifest: { id: 'plugin-a' } } } as WorkColumnTarget;
    mocks.commitNavigation.mockImplementation((_requestId, target: WorkColumnTarget) => {
      mocks.navigationTarget = target;
      return true;
    });
    mocks.activeAgentConversationId = 'conversation-a';
    mocks.clearDocument.mockImplementation(async () => { mocks.activeAgentConversationId = ''; });
    mocks.hydrateInstance.mockResolvedValue({ instanceId: 'conversation-a' });
    mocks.agentRestore = {
      selectedInstanceId: 'conversation-a',
      detailOpen: true,
    };
    useBrowserColumnStore.getState().reset();
  });

  it('commits the agent target and clears stale workspace selection', async () => {
    await selectAndOpenAgentConversation(' conversation-a ');

    expect(mocks.commitNavigation).toHaveBeenCalledWith(1, {
      kind: 'agent-conversation',
      instanceId: 'conversation-a',
    }, 'push');
    expect(mocks.setActivePluginId).toHaveBeenCalledWith(null);
    expect(mocks.openAgentConversation).toHaveBeenCalledWith('conversation-a');
    expect(mocks.selectAgentConversation).toHaveBeenCalledWith('conversation-a', true);
  });

  it('opens an existing browser-column conversation in Work for a default Work request', async () => {
    useBrowserColumnStore.getState().openContent({
      id: 'agent:conversation-a',
      title: 'Conversation A',
      icon: null,
      target: { kind: 'agent_conversation', instanceId: 'conversation-a' },
    });
    mocks.openAgentConversation.mockClear();

    await selectAndOpenAgentConversation('conversation-a');

    expect(mocks.openAgentConversation).toHaveBeenCalledWith('conversation-a');
    expect(useBrowserColumnStore.getState()).toMatchObject({
      visible: true,
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
    expect(mocks.selectAgentConversation).toHaveBeenCalledWith('conversation-a', true);
  });

  it('clears an absent persisted conversation after session database rebuild', async () => {
    mocks.hydrateInstance.mockResolvedValue(null);
    const { restoreAgentConversationWorkspace } = await import('./agent-conversation-navigation');
    await restoreAgentConversationWorkspace();
    expect(mocks.clearDocument).toHaveBeenCalledOnce();
    expect(mocks.clearAgentConversation).toHaveBeenCalledOnce();
    expect(mocks.openAgentConversation).not.toHaveBeenCalled();
  });

  it.each([null, { instanceId: 'conversation-a' }])('does not replace later navigation after delayed hydration (%j)', async (result) => {
    let finish!: (value: typeof result) => void;
    mocks.hydrateInstance.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { restoreAgentConversationWorkspace } = await import('./agent-conversation-navigation');
    const restoring = restoreAgentConversationWorkspace();
    // 判断"实例是否已在内存"这一步现在是异步的，会让出一个微任务；
    // 必须等 hydrate 真的被调用后再接管它的 resolver。
    await vi.waitFor(() => expect(mocks.hydrateInstance).toHaveBeenCalledOnce());
    mocks.navigationRevision = 2;
    finish(result);
    await restoring;
    expect(mocks.openAgentConversation).not.toHaveBeenCalled();
    expect(mocks.clearDocument).not.toHaveBeenCalled();
    expect(mocks.clearAgentConversation).not.toHaveBeenCalled();
  });

  it('restores the work-column conversation even when the middle column is on notes', async () => {
    const { restoreAgentConversationWorkspace } = await import('./agent-conversation-navigation');

    await restoreAgentConversationWorkspace();

    expect(mocks.hydrateInstance).toHaveBeenCalledWith('conversation-a');
    expect(mocks.openAgentConversation).toHaveBeenCalledWith('conversation-a');
    expect(mocks.selectAgentConversation).toHaveBeenCalledWith('conversation-a', true);
  });
});
