'use client';

import { SessionViewRecoveryContext } from '@features/workspace/public/session-view-state-api';

import { Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import {
  workspaceSurfaceAppearance,
  workspaceSurfaceCapabilities,
  workspaceSurfaceRegistry,
  resolveWorkspaceFileSurfaceKind,
} from '@features/workspace/public/surface-api';
import type {
  SurfaceAppearance,
  SurfaceState,
  WorkspaceSurfaceCapability,
  WorkspaceSurfaceHost,
  WorkspaceSurfaceKind,
} from '@features/workspace/public/surface-api';
import { useWorkspaceSurfaceRendererLazy, WorkspaceSurfaceErrorBoundary, WorkspaceSurfaceStateView } from './workspace-surface-state-view';
import { registerStartupSurfaceHostView, useWorkspaceSurfacePresentation } from './workspace-surface-runtime';
import { CsvTableLoadingSkeleton } from '@shared/ui/csv-table-loading-skeleton';
import { MultidimensionalTableLoadingSkeleton } from '@shared/ui/multidimensional-table-loading-skeleton';
import { MediaLibraryLoadingSkeleton } from '@shared/ui/media-library-loading-skeleton';
import { WorkDocumentsLoadingSkeleton } from '@shared/ui/work-documents-loading-skeleton';

export type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';
import type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';
type EnsureSurfaceData<K extends WorkspaceSurfaceRendererData['kind']> = K;
// Adding a public surface kind requires a typed renderer data variant.
type WorkspaceSurfaceRendererKind = EnsureSurfaceData<WorkspaceSurfaceKind>;
type RendererId = typeof workspaceSurfaceRegistry[WorkspaceSurfaceKind]['rendererId'];
type SurfaceKindsForRenderer<R extends RendererId> = {
  [K in WorkspaceSurfaceKind]: typeof workspaceSurfaceRegistry[K]['rendererId'] extends R ? K : never
}[WorkspaceSurfaceKind];
type RendererProps<R extends RendererId> = {
  surface: Extract<WorkspaceSurfaceRendererData, { kind: SurfaceKindsForRenderer<R> }>;
  context: WorkspaceSurfaceRenderContext;
};
type RendererLoader<R extends RendererId> = () => Promise<{ default: ComponentType<RendererProps<R>> }>;

interface RendererImplementation {
  render: (surface: WorkspaceSurfaceRendererData, context: WorkspaceSurfaceRenderContext) => ReactNode;
}

export interface WorkspaceSurfaceRendererDefinition extends RendererImplementation {
  kind: WorkspaceSurfaceRendererKind;
  hosts: readonly WorkspaceSurfaceHost[];
  appearance: Readonly<SurfaceAppearance>;
  capabilities: readonly WorkspaceSurfaceCapability[];
}

function RetryableRenderer<R extends RendererId>({
  loader,
  surface,
  context,
}: {
  loader: RendererLoader<R>;
  surface: RendererProps<R>['surface'];
  context: WorkspaceSurfaceRenderContext;
}) {
  const Renderer = useWorkspaceSurfaceRendererLazy(loader);
  return <Renderer surface={surface} context={context} />;
}

function implementRenderer<R extends RendererId>(
  rendererId: R,
  loader: RendererLoader<R>,
): RendererImplementation {
  return {
    render(surface, context) {
      if (workspaceSurfaceRegistry[surface.kind].rendererId !== rendererId) {
        throw new Error(`Surface '${surface.kind}' does not use renderer '${rendererId}'`);
      }
      // The public renderer ID check above correlates the data variant with the
      // component. Keep the generic assertion at this single implementation boundary.
      return <RetryableRenderer<R>
        loader={loader}
        surface={surface as RendererProps<R>['surface']}
        context={context}
      />;
    },
  };
}

/** Implementations have no host registration or independent support declarations. */
const rendererImplementations = {
  'file-markdown': implementRenderer('file-markdown', () => import('./workspace-surface-renderers').then((module) => ({ default: module.MarkdownRenderer }))),
  'file-code': implementRenderer('file-code', () => import('./workspace-surface-renderers').then((module) => ({ default: module.CodeRenderer }))),
  'file-csv': implementRenderer('file-csv', () => import('./workspace-surface-renderers').then((module) => ({ default: module.CsvRenderer }))),
  'file-image': implementRenderer('file-image', () => import('./workspace-surface-renderers').then((module) => ({ default: module.ImageRenderer }))),
  'file-video': implementRenderer('file-video', () => import('./workspace-surface-renderers').then((module) => ({ default: module.VideoRenderer }))),
  'file-table': implementRenderer('file-table', () => import('./workspace-surface-renderers').then((module) => ({ default: module.TableRenderer }))),
  'file-media-library': implementRenderer('file-media-library', () => import('./workspace-surface-renderers').then((module) => ({ default: module.MediaLibraryRenderer }))),
  'file-work-documents': implementRenderer('file-work-documents', () => import('./workspace-surface-renderers').then((module) => ({ default: module.WorkDocumentsCollectionRenderer }))),
  'file-html': implementRenderer('file-html', () => import('./workspace-surface-renderers').then((module) => ({ default: module.HtmlRenderer }))),
  'file-docx': implementRenderer('file-docx', () => import('./workspace-surface-renderers').then((module) => ({ default: module.DocxRenderer }))),
  'file-unavailable': implementRenderer('file-unavailable', () => import('./workspace-surface-renderers').then((module) => ({ default: module.UnavailableRenderer }))),
  media: implementRenderer('media', () => import('./workspace-surface-renderers').then((module) => ({ default: module.MediaResourceRenderer }))),
  'agent-conversation': implementRenderer('agent-conversation', () => import('./workspace-surface-renderers').then((module) => ({ default: module.AgentConversationRenderer }))),
  'plugin-document': implementRenderer('plugin-document', () => import('./workspace-surface-renderers').then((module) => ({ default: module.PluginDocumentRenderer }))),
  'plugin-workbench': implementRenderer('plugin-workbench', () => import('./workspace-surface-renderers').then((module) => ({ default: module.PluginWorkbenchRenderer }))),
  collection: implementRenderer('collection', () => import('./workspace-surface-renderers').then((module) => ({ default: module.CollectionRenderer }))),
  web: implementRenderer('web', () => import('./workspace-web-surface-renderer').then((module) => ({ default: module.WebRenderer }))),
  'file-browser': implementRenderer('file-browser', () => import('./workspace-file-browser-surface-renderer').then((module) => ({ default: module.FileBrowserRenderer }))),
} satisfies Record<RendererId, RendererImplementation>;

function buildWorkspaceSurfaceRendererRegistry() {
  // Every entry is populated from the exhaustive public registry below.
  const definitions = {} as Record<WorkspaceSurfaceKind, WorkspaceSurfaceRendererDefinition>;
  for (const kind of Object.keys(workspaceSurfaceRegistry) as WorkspaceSurfaceKind[]) {
    const registration = workspaceSurfaceRegistry[kind];
    definitions[kind] = Object.freeze({
      kind,
      hosts: registration.hosts,
      appearance: registration.appearance,
      capabilities: registration.capabilities,
      render(surface: WorkspaceSurfaceRendererData, context: WorkspaceSurfaceRenderContext) {
        if (surface.kind !== kind) throw new Error(`Expected surface '${kind}', received '${surface.kind}'`);
        return rendererImplementations[registration.rendererId].render(surface, context);
      },
    });
  }
  return Object.freeze(definitions);
}

/** Derived from the public registration: hosts never maintain renderer maps. */
export const workspaceSurfaceRendererRegistry = buildWorkspaceSurfaceRendererRegistry();

export function workspaceSurfaceRendererSupportsHost(kind: WorkspaceSurfaceRendererData['kind'], host: WorkspaceSurfaceHost): boolean {
  return workspaceSurfaceRendererRegistry[kind].hosts.includes(host);
}

/** File-browser is a shell; its current content determines chrome and capabilities. */
export function getWorkspaceSurfaceRendererDefinition(surface: WorkspaceSurfaceRendererData): WorkspaceSurfaceRendererDefinition {
  const definition = workspaceSurfaceRendererRegistry[surface.kind];
  if (surface.kind !== 'file-browser' || !surface.props.activeFilePath) return definition;
  const props = surface.props;
  const fileKind = props.collectionType === 'table' ? 'table'
    : props.collectionType === 'media_library' ? 'media-library'
    : props.collectionType === 'work_documents' ? 'work-documents'
    : resolveWorkspaceFileSurfaceKind(props.activeFilePath!);
  const contentKind = `file-${fileKind}` as const;
  return { ...definition, appearance: workspaceSurfaceAppearance(contentKind), capabilities: workspaceSurfaceCapabilities(contentKind) };
}

type InitialSurfaceSkeleton = 'csv' | 'table' | 'media-library' | 'work-documents';

function initialSurfaceSkeleton(surface: WorkspaceSurfaceRendererData): InitialSurfaceSkeleton | null {
  if (surface.kind === 'file-csv') return 'csv';
  if (surface.kind === 'file-table') return 'table';
  if (surface.kind === 'file-media-library') return 'media-library';
  if (surface.kind === 'file-work-documents') return 'work-documents';
  if (surface.kind === 'collection') return null;
  if (surface.kind !== 'file-browser' || !surface.props.activeFilePath) return null;
  const fileKind = surface.props.collectionType === 'table' ? 'table'
    : surface.props.collectionType === 'media_library' ? 'media-library'
    : surface.props.collectionType === 'work_documents' ? 'work-documents'
    : resolveWorkspaceFileSurfaceKind(surface.props.activeFilePath);
  return fileKind === 'csv' || fileKind === 'table' || fileKind === 'media-library' || fileKind === 'work-documents'
    ? fileKind : null;
}

export function workspaceSurfaceRetainsInitialContent(surface: WorkspaceSurfaceRendererData): boolean {
  return initialSurfaceSkeleton(surface) !== null;
}

export function WorkspaceSurfaceRendererView({
  surface,
  context,
  state = { status: 'ready' },
}: {
  surface: WorkspaceSurfaceRendererData;
  context: WorkspaceSurfaceRenderContext;
  state?: SurfaceState;
}) {
  const definition = getWorkspaceSurfaceRendererDefinition(surface);
  const runtime = useWorkspaceSurfacePresentation(context.viewId);
  useEffect(() => registerStartupSurfaceHostView(context.host, context.viewId), [context.host, context.viewId]);
  const appearance = runtime.appearance ?? definition.appearance;
  const resolvedState = runtime.state ?? state;
  const loadingOwner = context.host === 'main-third' ? 'host' : 'surface';
  const contentIdentity = surface.kind === 'file-browser'
    ? surface.props.fileIdentity?.displayId ?? surface.props.activeFilePath ?? 'folder'
    : 'fileIdentity' in surface ? surface.fileIdentity.displayId : '';
  if (!definition.hosts.includes(context.host)) {
    throw new Error(`Workspace host '${context.host}' does not support '${surface.kind}'`);
  }
  const backgroundClass = appearance.contentBackground === 'document'
    ? 'bg-[var(--document-bg)]'
    : 'bg-[var(--agent-bg,var(--document-bg))]';
  const initialSkeleton = initialSurfaceSkeleton(surface);
  const suspenseFallback = initialSkeleton === 'csv'
    ? <CsvTableLoadingSkeleton />
    : initialSkeleton === 'table'
      ? <MultidimensionalTableLoadingSkeleton />
      : initialSkeleton === 'media-library'
        ? <MediaLibraryLoadingSkeleton />
        : initialSkeleton === 'work-documents'
          ? <WorkDocumentsLoadingSkeleton />
    : loadingOwner === 'host' ? null : <WorkspaceSurfaceStateView
      appearance={appearance}
      state={{ status: 'loading', loadingMode: 'blocking', retainContent: false }}
    />;
  return <SessionViewRecoveryContext.Provider value={context.sessionEntryId ? { sessionId: context.host === 'main-third' ? 'primary-session' : 'secondary-session', entryId: context.sessionEntryId } : null}><div data-workspace-surface={surface.kind} data-surface-capabilities={(runtime.capabilities ?? definition.capabilities).join(' ')} className={`flex h-full min-h-0 w-full flex-col ${backgroundClass}`}>
    <WorkspaceSurfaceErrorBoundary key={`${context.viewId}:${surface.kind}:${contentIdentity}`} appearance={appearance} reportPresentation={context.reportPresentation} onRendererError={context.onRendererError}>
      <WorkspaceSurfaceStateView state={resolvedState} appearance={appearance} keepContentMounted loadingOwner={loadingOwner}>
        <Suspense fallback={suspenseFallback}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{definition.render(surface, context)}</div>
        </Suspense>
      </WorkspaceSurfaceStateView>
    </WorkspaceSurfaceErrorBoundary>
  </div></SessionViewRecoveryContext.Provider>;
}
