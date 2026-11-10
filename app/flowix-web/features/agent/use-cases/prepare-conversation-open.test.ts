import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { prepareConversationForOpen } from './prepare-conversation-open';

function instance(patch: Partial<AgentConversationInstance> = {}): AgentConversationInstance {
  return {
    instanceId: 'inst-a',
    agentType: 'dsh',
    title: 'Conversation A',
    threadId: 'thread-a',
    providerSessionId: null,
    runtimeConfig: null,
    source: { kind: 'dedicated', notebookId: 'nb' },
    createdAt: 1,
    updatedAt: 10,
    ...patch,
  };
}

beforeEach(() => {
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState(), true);
});

describe('prepareConversationForOpen', () => {
  it('is a no-op for a conversation the columns already own', () => {
    const authoritative = instance();
    useAgentSessionStore.setState({
      conversationRegistry: { instances: { 'inst-a': authoritative } },
    });
    useAgentSessionStore.getState().setActiveAgentThread('dsh', 'thread-a');
    const before = useAgentSessionStore.getState();
    const registryBefore = before.conversationRegistry;
    const metaBefore = before.sessionMeta;

    // Same row the file tree renders after a refresh: equal values, new object.
    prepareConversationForOpen({ ...instance() });

    const after = useAgentSessionStore.getState();
    expect(after.conversationRegistry).toBe(registryBefore);
    expect(after.sessionMeta).toBe(metaBefore);
  });

  it('registers a conversation that is not in the registry yet', () => {
    prepareConversationForOpen(instance());

    expect(useAgentSessionStore.getState().conversationRegistry.instances['inst-a']).toBeDefined();
    expect(useAgentSessionStore.getState().sessionMeta.activeThreadIds.dsh).toBe('thread-a');
  });

  it('activates the authoritative thread, not the snapshot thread', () => {
    useAgentSessionStore.setState({
      conversationRegistry: { instances: { 'inst-a': instance({ threadId: 'thread-live' }) } },
    });

    prepareConversationForOpen(instance({ threadId: 'thread-stale' }));

    const state = useAgentSessionStore.getState();
    expect(state.sessionMeta.activeThreadIds.dsh).toBe('thread-live');
    expect(state.conversationRegistry.instances['inst-a']?.threadId).toBe('thread-live');
  });

  it('leaves the runtime slot alone for a conversation without a thread', () => {
    prepareConversationForOpen(instance({ threadId: null }));

    expect(useAgentSessionStore.getState().conversationRegistry.instances['inst-a']).toBeDefined();
    expect(useAgentSessionStore.getState().sessionMeta.activeThreadIds.dsh).toBeUndefined();
  });
});
