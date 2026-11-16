'use client';

import { useCallback, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { SurfaceLifecycle, SurfacePresentationUpdate, WorkspaceColumnId } from '@features/workspace/public/surface-api';
import { registerWorkspaceColumnIdView, registerWorkspaceSurfaceLifecycle } from '@features/workspace/public/surface-lifecycle-api';
import {
  registerStartupSurfaceHostView,
  registerWorkspaceSurfacePresentationOwner,
  reportWorkspaceSurfacePresentation,
} from './workspace-surface-runtime';
import {
  WorkspaceSurfaceRendererView,
  workspaceSurfaceInitialLoadingState,
  workspaceSurfaceRetainsInitialContent,
  workspaceSurfaceSilentLoading,
} from './workspace-surface-renderer-registry';
import type { WorkspaceSurfaceRendererData, WorkspaceWebNavigationPort } from './workspace-surface-renderer-contract';
import type { SurfaceRenderPolicy } from './surface-render-policy';

/** Result a surface reports back to a document transition it was opened for. */
export type SurfaceTransitionOutcome = 'ready' | 'unavailable';

const SETTLED_STATES: readonly string[] = ['ready', 'error', 'unavailable'];

export interface SurfaceHostViewProps {
  surface: WorkspaceSurfaceRendererData;
  columnId: WorkspaceColumnId;
  /** View id used for presentation ownership, lifecycle and navigation. */
  viewId: string;
  sessionEntryId?: string | null;
  focused: boolean;
  readOnly: boolean;
  initialFocus?: 'title' | 'body';
  /** Memo scope of the presentation owner; must change when the presented content changes. */
  presentationScope: string;
  policy: SurfaceRenderPolicy;
  /** Document transition this surface is expected to settle, if the column opened one. */
  transitionId?: number | null;
  /** Kinds that finish their transition on mount keep their own loading UI instead. */
  transitionFinishOnMount?: boolean;
  /** Settles a transition the column started; the column owns that bookkeeping. */
  settleTransition?: (transitionId: number, outcome: SurfaceTransitionOutcome) => void;
  webNavigation?: WorkspaceWebNavigationPort;
  webAddressBarVisible?: boolean;
  onCollectionActiveViewChange?: (viewId: string) => void;
  wrapInFileBrowser?: (content: ReactNode) => ReactNode;
  /** Column-specific sink for accepted presentation updates (title, icon, state). */
  writeMetadata?: (update: SurfacePresentationUpdate) => void;
  onRendererError?: () => void;
}

/**
 * Mount one workspace surface.
 *
 * Both columns mount surfaces the same way: own a presentation owner for the
 * viewed content, expose the lifecycle port, seed the initial loading state and
 * settle any document transition. What differs between columns is data, not
 * control flow — the payload, presentation scope, policy and metadata sink all
 * arrive as props, so the renderer table never learns which column it runs in.
 */
export function SurfaceHostView({
  surface,
  columnId,
  viewId,
  sessionEntryId,
  focused,
  readOnly,
  initialFocus,
  presentationScope,
  policy,
  transitionId = null,
  transitionFinishOnMount = false,
  settleTransition,
  webNavigation,
  webAddressBarVisible,
  onCollectionActiveViewChange,
  wrapInFileBrowser,
  writeMetadata,
  onRendererError,
}: SurfaceHostViewProps) {
  // Identity token only: a new owner whenever the presented content changes, so
  // late updates from the previous content can no longer win.
  const presentationOwner = useMemo(() => ({ presentationScope }), [presentationScope]);
  const silentLoading = workspaceSurfaceSilentLoading(surface);
  const retainInitialContent = workspaceSurfaceRetainsInitialContent(surface);

  const reportPresentation = useCallback((update: SurfacePresentationUpdate) => {
    if (!reportWorkspaceSurfacePresentation(viewId, update, presentationOwner)) return;
    writeMetadata?.(update);
    const status = update.state?.status;
    if (transitionId !== null && status && SETTLED_STATES.includes(status)) {
      settleTransition?.(transitionId, status === 'ready' ? 'ready' : 'unavailable');
    }
  }, [presentationOwner, settleTransition, transitionId, viewId, writeMetadata]);
  const registerLifecycle = useCallback((lifecycle: SurfaceLifecycle | null, owner?: object) => {
    registerWorkspaceSurfaceLifecycle(viewId, lifecycle, owner);
  }, [viewId]);
  const handleRendererError = useCallback(() => {
    if (transitionId !== null) settleTransition?.(transitionId, 'unavailable');
    onRendererError?.();
  }, [onRendererError, settleTransition, transitionId]);

  useLayoutEffect(() => registerStartupSurfaceHostView(columnId, viewId), [columnId, viewId]);
  useLayoutEffect(() => registerWorkspaceColumnIdView(columnId, viewId), [columnId, viewId]);
  useLayoutEffect(() => {
    // These views have no DocumentContainer to finish the transition after
    // reading content; their own loading UI remains active.
    if (transitionFinishOnMount && transitionId !== null) settleTransition?.(transitionId, 'ready');
  }, [settleTransition, transitionFinishOnMount, transitionId]);
  useLayoutEffect(() => registerWorkspaceSurfacePresentationOwner(viewId, presentationOwner, {
    state: workspaceSurfaceInitialLoadingState(silentLoading, retainInitialContent),
  }), [presentationOwner, retainInitialContent, silentLoading, viewId]);

  const context = useMemo(() => ({
    sessionEntryId, host: columnId, viewId, focused, readOnly, initialFocus, policy,
    reportPresentation, registerLifecycle, onRendererError: handleRendererError,
    webNavigation, webAddressBarVisible, onCollectionActiveViewChange, wrapInFileBrowser,
  }), [sessionEntryId, columnId, viewId, focused, readOnly, initialFocus, policy, reportPresentation,
    registerLifecycle, handleRendererError, webNavigation, webAddressBarVisible,
    onCollectionActiveViewChange, wrapInFileBrowser]);

  return <WorkspaceSurfaceRendererView surface={surface} context={context} />;
}
