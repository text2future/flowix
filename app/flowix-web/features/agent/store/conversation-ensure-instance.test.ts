import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

function instance(patch: Partial<AgentConversationInstance> = {}): AgentConversationInstance {
  return {
    instanceId: 'inst-a',
    agentType: 'dsh',
    title: 'Conversation A',
    threadId: 'thread-a',
    providerSessionId: 'session-a',
    runtimeConfig: null,
    source: { kind: 'dedicated', notebookId: 'nb' },
    createdAt: 1,
    updatedAt: 10,
    ...patch,
  };
}

function registryInstance(): AgentConversationInstance {
  const stored = useAgentSessionStore.getState().conversationRegistry.instances['inst-a'];
  if (!stored) throw new Error('instance not registered');
  return stored;
}

beforeEach(() => {
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState(), true);
});

describe('ensureInstance (read model → authority)', () => {
  it('registers a conversation that arrived from a list snapshot', () => {
    const snapshot = instance();

    const resolved = useAgentSessionStore.getState().ensureInstance(snapshot);

    expect(resolved).toBe(snapshot);
    expect(registryInstance()).toBe(snapshot);
  });

  it('keeps the registered identity when the snapshot adds nothing', () => {
    const existing = instance();
    useAgentSessionStore.setState({
      conversationRegistry: { instances: { 'inst-a': existing } },
    });
    const registryBefore = useAgentSessionStore.getState().conversationRegistry;

    const resolved = useAgentSessionStore.getState().ensureInstance(instance());

    expect(resolved).toBe(existing);
    // No store write at all: a click that changes nothing must not repaint the
    // columns already showing this conversation.
    expect(useAgentSessionStore.getState().conversationRegistry).toBe(registryBefore);
  });

  it('never downgrades the authority with a stale snapshot', () => {
    const existing = instance({ runtimeConfig: { model: { id: 'gpt-test' } } as never, title: 'Renamed locally' });
    useAgentSessionStore.setState({
      conversationRegistry: { instances: { 'inst-a': existing } },
    });

    const resolved = useAgentSessionStore.getState().ensureInstance(instance({
      threadId: null,
      title: '',
      providerSessionId: null,
      runtimeConfig: null,
    }));

    expect(resolved).toBe(existing);
    expect(registryInstance().threadId).toBe('thread-a');
    expect(registryInstance().title).toBe('Renamed locally');
    expect(registryInstance().providerSessionId).toBe('session-a');
  });

  it('completes a missing thread id without dropping other fields', () => {
    const existing = instance({ threadId: null, title: 'Untitled' });
    useAgentSessionStore.setState({
      conversationRegistry: { instances: { 'inst-a': existing } },
    });

    const resolved = useAgentSessionStore.getState().ensureInstance(instance({ title: 'Untitled' }));

    expect(resolved).not.toBe(existing);
    expect(resolved.threadId).toBe('thread-a');
    expect(resolved.instanceId).toBe('inst-a');
    expect(registryInstance()).toBe(resolved);
  });
});

describe('activating a conversation', () => {
  it('does not mint a new session meta when the thread is already active', () => {
    useAgentSessionStore.getState().setActiveAgentThread('dsh', 'thread-a');
    const metaBefore = useAgentSessionStore.getState().sessionMeta;

    useAgentSessionStore.getState().setActiveAgentThread('dsh', 'thread-a');

    expect(useAgentSessionStore.getState().sessionMeta).toBe(metaBefore);
  });
});
