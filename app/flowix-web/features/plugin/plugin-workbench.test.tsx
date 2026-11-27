import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PluginWorkbench } from './plugin-workbench';

vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: (selector: (state: unknown) => unknown) => selector({ selectedNotebook: { id: 'book', path: '/book' } }),
}));
vi.mock('./plugin-agent-workbench', () => ({
  AgentPluginWorkbench: ({ notebookPath, host }: { notebookPath: string; host: string }) =>
    <div data-notebook={notebookPath} data-host={host} />,
}));

it('supplies the selected notebook and owning column to a workbench without explicit context', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<PluginWorkbench
      plugin={{ manifest: { id: 'example', kind: 'agent' } } as never}
      notebookPath={undefined} currentNotePath={null} currentNoteContent="" host="column-2" />));
    expect(node.firstElementChild?.getAttribute('data-notebook')).toBe('/book');
    expect(node.firstElementChild?.getAttribute('data-host')).toBe('column-2');
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
