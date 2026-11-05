import { getSessionId } from '../store/workspace-session-store';
import { sessionFor } from '../model/workspace-session';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => vi.fn());
vi.mock('./surface-opening', () => ({ openWorkspaceSurface: open }));
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { navigateWorkspaceSession } from './session-navigation';
import type { WorkspaceSessionReference } from '../model/workspace-session';
import type { OpenWorkspaceSurfaceRequest } from '../model/surface-opening';
import type { SessionSurfaceTarget } from '../model/session-target';

beforeEach(() => {
  useWorkspaceSessionStore.getState().reset();
  open.mockReset().mockImplementation(async (request: OpenWorkspaceSurfaceRequest) => {
    const id: WorkspaceSessionReference = request.host === 'column-1' ? 0 : 1;
    useWorkspaceSessionStore.getState().commitTarget(getSessionId(id), request.target as SessionSurfaceTarget, {
      history: 'skip', entryId: request.options?.navigationEntryId,
    });
    return { status: 'opened', host: request.host };
  });
});

const target = (name: string) => ({ kind: 'web' as const, url: 'https://' + name + '.example/' });
function seed(id: WorkspaceSessionReference) {
  const store = useWorkspaceSessionStore.getState();
  store.commitTarget(getSessionId(id), target('a'), { history: 'push' });
  const a = sessionFor(useWorkspaceSessionStore.getState(), id).navigation.current!;
  store.commitTarget(getSessionId(id), target('b'), { history: 'push' });
  const b = sessionFor(useWorkspaceSessionStore.getState(), id).navigation.current!;
  store.commitTarget(getSessionId(id), target('c'), { history: 'push' });
  return { a, b };
}

describe.each([0, 1] as const)('shared history transaction: %s', (id) => {
  it('replays backward/forward without inserting visits or replacing Surface IDs', async () => {
    const { a, b } = seed(id);
    await expect(navigateWorkspaceSession(id, 'back')).resolves.toBe(true);
    expect(sessionFor(useWorkspaceSessionStore.getState(), id).navigation.current?.id).toBe(b.id);
    await expect(navigateWorkspaceSession(id, 'back')).resolves.toBe(true);
    expect(sessionFor(useWorkspaceSessionStore.getState(), id).navigation.current?.id).toBe(a.id);
    await expect(navigateWorkspaceSession(id, 'forward')).resolves.toBe(true);
    const navigation = sessionFor(useWorkspaceSessionStore.getState(), id).navigation;
    expect(navigation.current?.id).toBe(b.id);
    expect(navigation.backStack.map((entry) => entry.id)).toEqual([a.id]);
    expect(navigation.forwardStack.map((entry) => entry.target)).toEqual([target('c')]);
  });

  it('leaves the current entry and both histories untouched when saving is refused', async () => {
    seed(id);
    const before = sessionFor(useWorkspaceSessionStore.getState(), id).navigation;
    open.mockResolvedValueOnce({ status: 'cancelled', reason: 'navigation-cancelled' });
    await expect(navigateWorkspaceSession(id, 'back')).resolves.toBeNull();
    expect(sessionFor(useWorkspaceSessionStore.getState(), id).navigation).toBe(before);
  });

  it('does not let a delayed history open overwrite the history of a newer visit', async () => {
    seed(id);
    let finish!: () => void;
    open.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ status: 'opened' });
    }));
    const navigating = navigateWorkspaceSession(id, 'back');
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    useWorkspaceSessionStore.getState().commitTarget(getSessionId(id), target('newer'), { history: 'push' });
    const newer = sessionFor(useWorkspaceSessionStore.getState(), id).navigation;
    finish();
    await expect(navigating).resolves.toBe(false);
    expect(sessionFor(useWorkspaceSessionStore.getState(), id).navigation).toBe(newer);
  });

  it('keeps navigating the same session after an unrelated state update', async () => {
    const { b } = seed(id);
    await expect(navigateWorkspaceSession(id, 'back')).resolves.toBe(true);
    expect(sessionFor(useWorkspaceSessionStore.getState(), id).navigation.current?.id).toBe(b.id);
  });
});
