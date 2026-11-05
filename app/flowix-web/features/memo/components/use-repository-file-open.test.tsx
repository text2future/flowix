import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openWorkspaceSurface = vi.hoisted(() => vi.fn(() => Promise.resolve({ status: 'opened' })));

vi.mock('@features/workspace/public/open-surface-api', () => ({ openWorkspaceSurface }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useRepositoryFileOpen } from './use-repository-file-open';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mountProbe(): {
  openRepositoryFileInBrowser: (path: string, scopePath: string) => void;
  openRepositoryFileInWork: (path: string, scopePath: string) => void;
} {
  const handlers: { current: ReturnType<typeof useRepositoryFileOpen> | null } = { current: null };
  const Probe = () => {
    handlers.current = useRepositoryFileOpen();
    return null;
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root?.render(createElement(Probe)); });
  if (!handlers.current) throw new Error('probe did not render');
  return handlers.current;
}

describe('repository file open placement', () => {
  beforeEach(() => {
    openWorkspaceSurface.mockClear();
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container?.remove();
    container = null;
  });

  it('opens a row click in the Browser column', () => {
    const handlers = mountProbe();

    handlers.openRepositoryFileInBrowser('/repo/notes/a.md', '/repo');

    expect(openWorkspaceSurface).toHaveBeenCalledWith({
      index: 1,
      target: { kind: 'external', path: '/repo/notes/a.md', scopePath: '/repo', transitionId: null },
    });
  });

  it('keeps the row menu pointing at the Work column', () => {
    const handlers = mountProbe();

    handlers.openRepositoryFileInWork('/repo/notes/a.md', '/repo');

    expect(openWorkspaceSurface).toHaveBeenCalledWith({
      index: 0,
      target: { kind: 'external', path: '/repo/notes/a.md', scopePath: '/repo', transitionId: null },
    });
  });
});
