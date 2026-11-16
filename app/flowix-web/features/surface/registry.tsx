'use client';

import { useCallback, type ReactNode } from 'react';
import type {
  WorkColumnContentPresentation, WorkColumnSurface,
  WorkColumnSurfaceCapability, WorkColumnSurfaceChrome,
} from './types';
import { workspaceSurfaceAppearance } from '@features/workspace/public/surface-api';
import type { WorkspaceSurfaceKind } from '@features/workspace/public/surface-api';
import type { SurfaceAppearance } from '@features/workspace/public/surface-api';
import { getWorkspaceSurfaceRendererDefinition } from './workspace-surface-renderer-registry';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';
import { surfaceRenderPolicy } from './surface-render-policy';
import { SurfaceHostView } from './surface-host-view';
import { useDocumentStore } from '@features/document/store/document-store';

import { primaryCurrentEntryId, updatePrimarySurfaceMetadata } from '@features/workspace/public/session-runtime-api';
import { workspaceSurfaceRendererDataFromWorkSurface } from './work-column-surface-adapter';
import { reportEmptyWorkspaceSurfaceForIdentity } from './workspace-surface-runtime';

export interface WorkColumnSurfaceDefinition {
  contentKind: WorkspaceSurfaceKind;
  appearance: Readonly<SurfaceAppearance>;
  chrome: WorkColumnSurfaceChrome;
  capabilities: readonly WorkColumnSurfaceCapability[];
}

/** Work adapts navigation data; mounting belongs to SurfaceHostView. */
export function getWorkColumnSurfaceDefinition(
  surface: WorkColumnSurface,
): WorkColumnSurfaceDefinition {
  const data = workspaceSurfaceRendererDataFromWorkSurface(surface);
  const definition = getWorkspaceSurfaceRendererDefinition(data);
  return {
    contentKind: data.kind,
    appearance: definition.appearance,
    chrome: definition.appearance.headerStyle,
    capabilities: definition.capabilities,
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
  const viewId = surface.instanceKey;
  const transition = transitionForSurface(surface);
  const writeMetadata = useCallback((update: Parameters<typeof updatePrimarySurfaceMetadata>[1]) => {
    updatePrimarySurfaceMetadata(entryId, update);
  }, [entryId]);
  const settleTransition = useCallback((transitionId: number, outcome: 'ready' | 'unavailable') => {
    useDocumentStore.getState().finishDocumentTransition(transitionId, outcome);
  }, []);

  return <SurfaceHostView
    surface={workspaceSurfaceRendererDataFromWorkSurface(surface)}
    columnId="column-1"
    viewId={viewId}
    sessionEntryId={surface.sessionEntryId}
    focused={focused}
    readOnly={'props' in surface && 'readOnly' in surface.props ? Boolean(surface.props.readOnly) : false}
    initialFocus={initialFocusForSurface(surface)}
    presentationScope={`${surface.kind}:${surface.instanceKey}:${'fileIdentity' in surface ? surface.fileIdentity?.path ?? '' : ''}`}
    policy={surfaceRenderPolicy('column-1', viewId)}
    transitionId={transition?.id ?? null}
    transitionFinishOnMount={transition?.finishOnMount ?? false}
    settleTransition={settleTransition}
    webAddressBarVisible={webAddressBarVisible}
    writeMetadata={writeMetadata}
  />;
}

export function WorkColumnSurfaceHost({ surface, focused = false, webAddressBarVisible = false }: { surface: WorkColumnSurface; focused?: boolean; webAddressBarVisible?: boolean }) {
  const instanceKey = `${surface.kind}:${surface.instanceKey}`;
  return <WorkColumnSurfaceMount key={instanceKey} surface={surface} focused={focused} webAddressBarVisible={webAddressBarVisible} />;
}

export function WorkColumnContentHost({ content, focused = false, startupIdentity = '', webAddressBarVisible = false, renderNoTargetEmpty }: {
  content: WorkColumnContentPresentation;
  focused?: boolean;
  startupIdentity?: string;
  webAddressBarVisible?: boolean;
  /** Column creation controls belong to the shell, so the shell supplies this view. */
  renderNoTargetEmpty?: () => ReactNode;
}) {
  if (content.status === 'empty') {
    reportEmptyWorkspaceSurfaceForIdentity('column-1', startupIdentity);
    if (content.reason === 'no-target' && renderNoTargetEmpty) return <>{renderNoTargetEmpty()}</>;
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
