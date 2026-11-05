'use client';

import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
} from 'react';
import { useDocumentStore } from '@features/document/store/document-store';
import type {
  WorkColumnContentPresentation, WorkColumnSurface,
  WorkColumnSurfaceCapability, WorkColumnSurfaceChrome,
} from './types';
import { workspaceSurfaceAppearance } from '@features/workspace/public/surface-api';
import type { WorkspaceSurfaceKind } from '@features/workspace/public/surface-api';
import type { SurfaceAppearance } from '@features/workspace/public/surface-api';
import {
  getWorkspaceSurfaceRendererDefinition,
  workspaceSurfaceRetainsInitialContent,
  WorkspaceSurfaceRendererView,
} from './workspace-surface-renderer-registry';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';

import { primaryCurrentEntryId, updatePrimarySurfaceMetadata } from '@features/workspace/public/session-runtime-api';
import { workspaceSurfaceRendererDataFromWorkSurface } from './work-column-surface-adapter';
import { registerStartupSurfaceHostView, registerWorkspaceSurfacePresentationOwner, reportEmptyWorkspaceSurfaceForIdentity, reportWorkspaceSurfacePresentation } from './workspace-surface-runtime';
import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import { registerWorkspaceColumnIdView, registerWorkspaceSurfaceLifecycle } from '@features/workspace/public/surface-lifecycle-api';

export interface WorkColumnSurfaceDefinition {
  contentKind: WorkspaceSurfaceKind;
  appearance: Readonly<SurfaceAppearance>;
  chrome: WorkColumnSurfaceChrome;
  capabilities: readonly WorkColumnSurfaceCapability[];
  render: () => ReactNode;
}

/** Work adapts navigation data; renderer registration belongs to the common registry. */
export function getWorkColumnSurfaceDefinition(
  surface: WorkColumnSurface,
  reportPresentation?: (update: SurfacePresentationUpdate) => void,
  registerLifecycle?: (lifecycle: SurfaceLifecycle | null, owner?: object) => void,
  focused = false,
  onRendererError?: () => void,
  webAddressBarVisible = false,
): WorkColumnSurfaceDefinition {
  const sessionEntryId = surface.sessionEntryId;
  const data = workspaceSurfaceRendererDataFromWorkSurface(surface);
  const definition = getWorkspaceSurfaceRendererDefinition(data);
  return {
    contentKind: data.kind,
    appearance: definition.appearance,
    chrome: definition.appearance.headerStyle,
    capabilities: definition.capabilities,
    render: () => <WorkspaceSurfaceRendererView
      surface={data}
      context={{
        sessionEntryId, host: 'column-1', viewId: surface.instanceKey, focused,
        initialFocus: initialFocusForSurface(surface),
        readOnly: 'props' in surface && 'readOnly' in surface.props ? Boolean(surface.props.readOnly) : false,
        reportPresentation: reportPresentation ?? ((update) => reportWorkspaceSurfacePresentation(surface.instanceKey, update)),
        onRendererError,
        webAddressBarVisible,
        registerLifecycle,
      }}
    />,
  };
}

function initialFocusForSurface(surface: WorkColumnSurface): 'title' | 'body' | undefined {
  if (!('props' in surface) || !surface.props || !('initialFocus' in surface.props)) return undefined;
  const value = surface.props.initialFocus;
  return value === 'title' || value === 'body' ? value : undefined;
}

export function surfaceSupports(
  surface: WorkColumnSurface,
  capability: WorkColumnSurfaceCapability,
): boolean {
  return getWorkColumnSurfaceDefinition(surface).capabilities.includes(capability);
}

function transitionForSurface(surface: WorkColumnSurface): { id: number; finishOnMount: boolean } | null {
  let id: number | null = null;
  let finishOnMount = false;
  switch (surface.kind) {
    case 'csv-file':
      id = surface.transitionId ?? null;
      finishOnMount = true;
      break;
    case 'image-file':
    case 'video-file':
    case 'unavailable-file':
      id = surface.props.transitionId ?? null;
      finishOnMount = true;
      break;
    case 'md':
    case 'code':
    case 'html-file':
    case 'mindmap':
    case 'html':
    case 'json':
    case 'text':
    case 'plugin-artifact':
      id = surface.props.transitionId ?? null;
      break;
    case 'table-file':
      id = 'transitionId' in surface.props && typeof surface.props.transitionId === 'number'
        ? surface.props.transitionId : null;
      break;
    default:
      break;
  }
  return typeof id === 'number' ? { id, finishOnMount } : null;
}

function WorkColumnSurfaceMount({ surface, focused, webAddressBarVisible }: { surface: WorkColumnSurface; focused: boolean; webAddressBarVisible: boolean }) {
  const entryId = primaryCurrentEntryId();
  const transition = transitionForSurface(surface);
  const transitionId = transition?.id ?? null;
  const finishTransitionOnMount = transition?.finishOnMount ?? false;
  const presentationScope = `${surface.kind}:${surface.instanceKey}:${'fileIdentity' in surface ? surface.fileIdentity?.path ?? '' : ''}`;
  const presentationOwner = useMemo(() => ({}), [presentationScope]);
  const retainInitialContent = workspaceSurfaceRetainsInitialContent(
    workspaceSurfaceRendererDataFromWorkSurface(surface),
  );
  const reportPresentation = useCallback((update: SurfacePresentationUpdate) => {
    if (reportWorkspaceSurfacePresentation(surface.instanceKey, update, presentationOwner)) {
      updatePrimarySurfaceMetadata(entryId, update);
      if (transitionId !== null && update.state && ['ready', 'error', 'unavailable'].includes(update.state.status)) {
        useDocumentStore.getState().finishDocumentTransition(transitionId,
          update.state.status === 'ready' ? 'ready' : 'unavailable');
      }
    }
  }, [entryId, presentationOwner, surface.instanceKey, transitionId]);
  const registerLifecycle = useCallback((lifecycle: SurfaceLifecycle | null, owner?: object) => {
    registerWorkspaceSurfaceLifecycle(surface.instanceKey, lifecycle, owner);
  }, [surface.instanceKey]);
  const onRendererError = useCallback(() => {
    if (transitionId !== null) {
      useDocumentStore.getState().finishDocumentTransition(transitionId, 'unavailable');
    }
  }, [transitionId]);

  useLayoutEffect(() => registerStartupSurfaceHostView('column-1', surface.instanceKey), [surface.instanceKey]);
  useLayoutEffect(() => registerWorkspaceColumnIdView('column-1', surface.instanceKey), [surface.instanceKey]);

  useLayoutEffect(() => {
    // These views have no DocumentContainer to finish the transition after
    // reading content; their own loading UI remains active.
    if (finishTransitionOnMount && transitionId !== null) {
      useDocumentStore.getState().finishDocumentTransition(transitionId);
    }
  }, [finishTransitionOnMount, transitionId]);

  useLayoutEffect(() => registerWorkspaceSurfacePresentationOwner(surface.instanceKey, presentationOwner, {
    state: { status: 'loading', loadingMode: 'blocking', retainContent: retainInitialContent },
  }),
    [presentationOwner, retainInitialContent, surface.instanceKey]);

  return getWorkColumnSurfaceDefinition(surface, reportPresentation, registerLifecycle, focused, onRendererError, webAddressBarVisible).render();
}

export function WorkColumnSurfaceHost({ surface, focused = false, webAddressBarVisible = false }: { surface: WorkColumnSurface; focused?: boolean; webAddressBarVisible?: boolean }) {
  const instanceKey = `${surface.kind}:${surface.instanceKey}`;
  return <WorkColumnSurfaceMount key={instanceKey} surface={surface} focused={focused} webAddressBarVisible={webAddressBarVisible} />;
}

export function WorkColumnContentHost({ content, focused = false, startupIdentity = '', webAddressBarVisible = false }: { content: WorkColumnContentPresentation; focused?: boolean; startupIdentity?: string; webAddressBarVisible?: boolean }) {
  if (content.status === 'empty') {
    reportEmptyWorkspaceSurfaceForIdentity('column-1', startupIdentity);
    const baseAppearance = content.tone === 'agent' ? workspaceSurfaceAppearance('agent-conversation')
      : workspaceSurfaceAppearance('file-markdown');
    const appearance = content.actions?.length ? { ...baseAppearance, emptyDecoration: 'none' as const } : baseAppearance;
    return <WorkspaceSurfaceStateView
      appearance={appearance}
      state={{ status: 'empty', reason: content.reason, message: { key: 'document.file.loading' }, actions: content.actions }}
      messageOverride={content.message}
    />;
  }

  return <WorkColumnSurfaceHost surface={content.surface} focused={focused} webAddressBarVisible={webAddressBarVisible} />;
}
