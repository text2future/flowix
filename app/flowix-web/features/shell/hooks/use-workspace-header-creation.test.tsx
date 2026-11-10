import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceHeaderCreation } from './use-workspace-header-creation';
import { ColumnProvider } from '../components/column-environment';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

const io = vi.hoisted(() => ({ open: vi.fn(), create: vi.fn(), template: vi.fn(), agent: vi.fn(), discard: vi.fn() }));
vi.mock('@features/memo/public/note-creation-api', () => ({
  useShellSelectedNotebook: () => ({ id: 'book', path: '/book' }), createShellNote: io.create, createShellNoteFromTemplate: io.template,
}));
vi.mock('@features/agent/public/header-api', () => ({
  useNewConversationAgentSelection: () => ({ options: [] }), createBrowserColumnAgentConversation: io.agent, discardUnopenedBrowserColumnAgentConversation: io.discard,
}));
vi.mock('@features/workspace/public/session-opening-api', () => ({ openWorkspaceSurface: io.open }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
let root: Root;
let node: HTMLDivElement;
let commands: ReturnType<typeof useWorkspaceHeaderCreation>;
function Probe({ columnId }: { columnId: WorkspaceColumnId }) {
  commands = useWorkspaceHeaderCreation(columnId);
  return null;
}
beforeEach(() => {
  node = document.createElement('div'); root = createRoot(node);
  io.open.mockResolvedValue({ status: 'opened' }); io.template.mockResolvedValue({ path: '/book/template.md' }); io.agent.mockReturnValue('conversation');
});
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllMocks(); });
it.each(['column-1', 'column-2'] as const)('creation keeps the %s session binding after the columns exchange positions', async (columnId) => {
  await act(async () => root.render(<ColumnProvider value={{ index: columnId === 'column-1' ? 1 : 0, browserVisible: true, sidebarHidden: false, onToggleSidebar: vi.fn() }}>
    <Probe columnId={columnId} />
  </ColumnProvider>));
  await act(async () => commands.createNote('template'));
  expect(io.template).toHaveBeenCalledExactlyOnceWith('template', 'book');
  expect(io.open).toHaveBeenLastCalledWith({ columnId: columnId, target: { kind: 'external', path: '/book/template.md', scopePath: '/book' }, options: { initialFocus: 'title', notebookId: 'book' } });
  await act(async () => commands.createConversation('codex'));
  expect(io.open).toHaveBeenLastCalledWith({ columnId: columnId, target: { kind: 'agent-conversation', instanceId: 'conversation' } });
});
it('cleans up an unopened conversation when navigation is cancelled', async () => {
  io.open.mockResolvedValue({ status: 'cancelled' });
  await act(async () => root.render(<Probe columnId="column-2" />));
  await act(async () => commands.createConversation('codex'));
  expect(io.discard).toHaveBeenCalledExactlyOnceWith('conversation');
});
