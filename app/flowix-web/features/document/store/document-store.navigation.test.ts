import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prepareDocumentLeave } = vi.hoisted(() => ({ prepareDocumentLeave: vi.fn() }));
vi.mock('./document-session-service', () => ({ prepareDocumentLeave }));
vi.mock('@/lib/document-open-perf', () => ({
  startDocumentOpenTrace: vi.fn(), markDocumentOpenTrace: vi.fn(),
  attachDocumentOpenJourney: vi.fn(() => false),
}));

import { useDocumentStore } from './document-store';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';

describe('document navigation supersession', () => {
  beforeEach(() => {
    useDocumentStore.setState(useDocumentStore.getInitialState(), true);
    prepareDocumentLeave.mockReset().mockResolvedValue(true);
  });

  it('keeps A when the user returns to A while B is preparing to leave it', async () => {
    await useDocumentStore.getState().openExternalDocument('/A.md');
    useDocumentStore.getState().finishDocumentTransition(useDocumentStore.getState().documentTransitionId);
    let finishLeave!: (saved: boolean) => void;
    prepareDocumentLeave.mockImplementationOnce(() => new Promise((resolve) => { finishLeave = resolve; }));
    const openingB = useDocumentStore.getState().openExternalDocument('/B.md');
    await vi.waitFor(() => expect(prepareDocumentLeave).toHaveBeenCalledOnce());
    const returningToA = useDocumentStore.getState().openExternalDocument('/A.md');
    finishLeave(true);
    await Promise.all([openingB, returningToA]);
    expect(useDocumentStore.getState()).toMatchObject({
      currentDocumentPath: '/A.md', isDocumentTransitioning: false,
      activeExternalSession: { fileIdentity: { path: '/A.md' } },
    });
  });
  it('lets C supersede a saving B and ignores B completion signals', async () => {
    await useDocumentStore.getState().openExternalDocument('/A.md');
    useDocumentStore.getState().finishDocumentTransition(useDocumentStore.getState().documentTransitionId);
    let finishLeave!: (saved: boolean) => void;
    prepareDocumentLeave.mockImplementationOnce(() => new Promise((resolve) => { finishLeave = resolve; }));
    const openingB = useDocumentStore.getState().openExternalDocument('/B.md');
    const transitionB = useDocumentStore.getState().documentTransitionId;
    await vi.waitFor(() => expect(prepareDocumentLeave).toHaveBeenCalledOnce());
    const openingC = useDocumentStore.getState().openExternalDocument('/C.md');
    finishLeave(true);
    await Promise.all([openingB, openingC]);
    useDocumentStore.getState().finishDocumentTransition(transitionB);
    expect(useDocumentStore.getState()).toMatchObject({
      currentDocumentPath: '/C.md', isDocumentTransitioning: true, documentLoadOutcome: 'pending',
    });
    useDocumentStore.getState().finishDocumentTransition(useDocumentStore.getState().documentTransitionId);
    expect(useDocumentStore.getState().isDocumentTransitioning).toBe(false);
  });

  it('ends loading on a refused leave, retains A, and allows retrying B', async () => {
    await useDocumentStore.getState().openExternalDocument('/A.md');
    useDocumentStore.getState().finishDocumentTransition(useDocumentStore.getState().documentTransitionId);
    prepareDocumentLeave.mockResolvedValueOnce(false);
    await expect(useDocumentStore.getState().openExternalDocument('/B.md')).rejects.toBeInstanceOf(NavigationCancelledError);
    expect(useDocumentStore.getState()).toMatchObject({
      currentDocumentPath: '/A.md', isDocumentTransitioning: false,
    });
    await useDocumentStore.getState().openExternalDocument('/B.md');
    expect(useDocumentStore.getState()).toMatchObject({
      currentDocumentPath: '/B.md', isDocumentTransitioning: true, documentLoadOutcome: 'pending',
    });
  });

});
