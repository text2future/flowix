import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentConversationInstance } from '../store/agent-conversation-types';
import { AgentConversationHeaderContent } from './agent-conversation-header-content';

const io = vi.hoisted(() => ({ instance: null as AgentConversationInstance | null, notebook: vi.fn(), physical: vi.fn(), open: vi.fn() }));
vi.mock('../store/agent-session-store', () => ({ useAgentSessionStore: (selector: (state: unknown) => unknown) => selector({ getInstance: () => io.instance }) }));
vi.mock('./agent-conversation-identity', () => ({ AgentConversationIdentity: ({ title }: { title: string }) => <span>{title}</span> }));
vi.mock('./agent-conversation-more-menu', () => ({ AgentConversationMoreMenu: () => <button>agent commands</button> }));
vi.mock('@features/memo/public/note-navigation-api', () => ({ openNoteByNotebookPath: io.notebook, openNoteByPhysicalPath: io.physical }));
vi.mock('@features/workspace/public/session-opening-api', () => ({ openWorkspaceSurface: io.open }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  io.instance = { instanceId: 'agent', agentType: 'codex', title: 'Conversation', source: { kind: 'thread-card', notebookId: 'book', relativePath: 'note.md' } } as AgentConversationInstance;
  io.notebook.mockResolvedValue(null); io.physical.mockResolvedValue(undefined);
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllMocks(); });
it.each(['column-1', 'column-2'] as const)('offers the same source action bound to the %s session', async (columnId) => {
  await act(async () => root.render(<AgentConversationHeaderContent columnId={columnId} instanceId="agent" />));
  expect(node.textContent).toContain('Conversation'); expect(node.textContent).toContain('agent commands');
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="document.agent.viewInNote"]')!.click());
  expect(io.notebook).toHaveBeenCalledExactlyOnceWith('book', 'note.md', null, { columnId });
});
it('leaves the identity empty during hydration and shares the no-source marker after hydration', async () => {
  io.instance = null;
  await act(async () => root.render(<AgentConversationHeaderContent columnId="column-2" instanceId="agent" />));
  expect(node.textContent).toBe('');
  io.instance = { instanceId: 'agent', agentType: 'codex', title: '', source: { kind: 'thread-card' } } as AgentConversationInstance;
  await act(async () => root.render(<AgentConversationHeaderContent columnId="column-2" instanceId="agent" />));
  expect(node.textContent).toContain('common.untitled');
  expect(node.querySelector('[aria-label="document.agent.noSourceNote"]')).not.toBeNull();
});
