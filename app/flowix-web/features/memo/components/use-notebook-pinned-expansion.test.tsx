import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { useNotebookPinnedExpansion } from './use-notebook-pinned-expansion';

it('shares directory loading while pruning expansion outside the remaining pinned roots', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  const loadDirectory = vi.fn(async (_path: string) => {});
  let expansion: ReturnType<typeof useNotebookPinnedExpansion>;
  function Harness({ roots }: { roots: string[] }) {
    expansion = useNotebookPinnedExpansion({ roots, loadDirectory });
    return null;
  }
  try {
    await act(async () => root.render(<Harness roots={['/notes/a/', '/notes/ab']} />));
    await act(async () => {
      expansion.toggle('/notes/a/');
      expansion.toggle('/notes/a/child');
      expansion.toggle('/notes/ab');
    });
    expect(loadDirectory.mock.calls.map(([path]) => path)).toEqual([
      '/notes/a/', '/notes/a/child', '/notes/ab',
    ]);
    expect([...expansion!.expanded]).toEqual(['/notes/a', '/notes/a/child', '/notes/ab']);
    await act(async () => root.render(<Harness roots={['/notes/ab']} />));
    expect([...expansion!.expanded]).toEqual(['/notes/ab']);
    await act(async () => expansion.toggle('/notes/ab'));
    expect(expansion!.expanded.size).toBe(0);
    await act(async () => expansion.toggle('/notes/ab'));
    await act(async () => root.render(<Harness roots={[]} />));
    expect(expansion!.expanded.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
