import { beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => vi.fn());
vi.mock('./surface-opening', () => ({ openWorkspaceSurface: open }));
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { navigateWorkspaceSession } from './session-navigation';
import type { WorkspaceSessionId } from '../model/workspace-session';
import type { OpenWorkspaceSurfaceRequest } from '../model/surface-opening';
import type { SessionSurfaceTarget } from '../model/session-target';

beforeEach(() => {
  useWorkspaceSessionStore.getState().reset();
  open.mockReset().mockImplementation(async (request: OpenWorkspaceSurfaceRequest) => {
    const id: WorkspaceSessionId = request.host === 'main-third' ? 'primary-session' : 'secondary-session';
    useWorkspaceSessionStore.getState().commitTarget(id, request.target as SessionSurfaceTarget, {
      history: 'skip', entryId: request.options?.navigationEntryId,
    });
    return { status: 'opened', host: request.host };
  });
});

const target = (name: string) => ({ kind: 'web' as const, url: 'https://' + name + '.example/' });
function seed(id: WorkspaceSessionId) {
  const store = useWorkspaceSessionStore.getState();
  store.commitTarget(id, target('a'), { history: 'push' });
  const a = useWorkspaceSessionStore.getState().sessions[id].navigation.current!;
  store.commitTarget(id, target('b'), { history: 'push' });
  const b = useWorkspaceSessionStore.getState().sessions[id].navigation.current!;
  store.commitTarget(id, target('c'), { history: 'push' });
  return { a, b };
}

describe.each(['primary-session', 'secondary-session'] as const)('shared history transaction: %s', (id) => {
  it('replays backward/forward without inserting visits or replacing Surface IDs', async () => {
    const { a, b } = seed(id);
    await expect(navigateWorkspaceSession(id, 'back')).resolves.toBe(true);
    expect(useWorkspaceSessionStore.getState().sessions[id].navigation.current?.id).toBe(b.id);
    await expect(navigateWorkspaceSession(id, 'back')).resolves.toBe(true);
    expect(useWorkspaceSessionStore.getState().sessions[id].navigation.current?.id).toBe(a.id);
    await expect(navigateWorkspaceSession(id, 'forward')).resolves.toBe(true);
    const navigation = useWorkspaceSessionStore.getState().sessions[id].navigation;
    expect(navigation.current?.id).toBe(b.id);
    expect(navigation.backStack.map((entry) => entry.id)).toEqual([a.id]);
    expect(navigation.forwardStack.map((entry) => entry.target)).toEqual([target('c')]);
  });

  it('leaves the current entry and both histories untouched when saving is refused', async () => {
    seed(id);
    const before = useWorkspaceSessionStore.getState().sessions[id].navigation;
    open.mockResolvedValueOnce({ status: 'cancelled', reason: 'navigation-cancelled' });
    await expect(navigateWorkspaceSession(id, 'back')).resolves.toBeNull();
    expect(useWorkspaceSessionStore.getState().sessions[id].navigation).toBe(before);
  });

  it('does not let a delayed history open overwrite the history of a newer visit', async () => {
    seed(id);
    let finish!: () => void;
    open.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ status: 'opened' });
    }));
    const navigating = navigateWorkspaceSession(id, 'back');
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    useWorkspaceSessionStore.getState().commitTarget(id, target('newer'), { history: 'push' });
    const newer = useWorkspaceSessionStore.getState().sessions[id].navigation;
    finish();
    await expect(navigating).resolves.toBe(false);
    expect(useWorkspaceSessionStore.getState().sessions[id].navigation).toBe(newer);
  });

  it('keeps navigating the same session after placement changes', async () => {
    const { b } = seed(id);
    useWorkspaceSessionStore.getState().swap();
    await expect(navigateWorkspaceSession(id, 'back')).resolves.toBe(true);
    expect(useWorkspaceSessionStore.getState().sessions[id].navigation.current?.id).toBe(b.id);
  });
});
