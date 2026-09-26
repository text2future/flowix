'use client';

import { CodeSurfaceFileBrowser } from './work-file-browser-view';
import {
  type ComponentType,
  type ReactNode,
} from 'react';
import { DocumentContainer, UnavailableFileView } from '@features/document/components/document-container';
import { MediaResourceView } from './media-resource-view';
import { LazyAgentConversationDetail } from '@features/agent/components/lazy-agent-conversation-detail';
import {
  LazyPluginDocumentView,
  LazyPluginWorkbench,
} from '@features/plugin/public/surface-api';
import { SurfaceSuspenseHost } from '@shared/ui/surface-suspense-host';
import { WorkspaceEmptyState } from '@shared/ui/workspace-empty-state';
import { HtmlResourceView } from './html-resource-view';
import type {
  AgentConversationSurface,
  CodeSurface,
  HtmlFileSurface,
  ImageFileSurface,
  MDSurface,
  NoteSurface,
  MediaResourceSurface,
  UnavailableFileSurface,
  VideoFileSurface,
  PluginArtifactSurfaceBase,
  PluginWorkbenchSurface,
  WorkColumnContentPresentation,
  WorkColumnSurface,
  WorkColumnSurfaceCapability,
  WorkColumnSurfaceChrome,
  WorkColumnSurfaceKind,
  WebSurface,
} from './types';

type SurfaceOfKind<K extends WorkColumnSurfaceKind> = Extract<WorkColumnSurface, { kind: K }>;

export interface WorkColumnSurfaceDefinition {
  chrome: WorkColumnSurfaceChrome;
  capabilities: readonly WorkColumnSurfaceCapability[];
  render: (surface: WorkColumnSurface) => ReactNode;
}

function defineSurface<K extends WorkColumnSurfaceKind>(
  kind: K,
  options: {
    chrome: WorkColumnSurfaceChrome;
    capabilities?: readonly WorkColumnSurfaceCapability[];
    component: ComponentType<{ surface: SurfaceOfKind<K> }>;
  },
): WorkColumnSurfaceDefinition {
  const Component = options.component;
  return Object.freeze({
    chrome: options.chrome,
    capabilities: Object.freeze([...(options.capabilities ?? [])]),
    render(surface: WorkColumnSurface) {
      if (surface.kind !== kind) {
        throw new Error(`Surface registry mismatch: expected '${kind}', received '${surface.kind}'`);
      }
      // TypeScript cannot correlate a generic discriminant with Extract after
      // the runtime guard. Keep the assertion inside this constructor so all
      // registry consumers remain exhaustively typed.
      return <Component surface={surface as SurfaceOfKind<K>} />;
    },
  });
}

function NoteSurfaceView({ surface }: { surface: NoteSurface }) {
  return <DocumentContainer {...surface.props} memoId={surface.memoId} />;
}

function MDSurfaceView({ surface }: { surface: MDSurface }) {
  return <DocumentContainer {...surface.props} externalEditorMode="markdown" />;
}

function CodeSurfaceView({ surface }: { surface: CodeSurface }) {
  return <CodeSurfaceFileBrowser surface={surface} />;
}

function ImageFileSurfaceView({ surface }: { surface: ImageFileSurface }) {
  return <MediaResourceView
    filePath={surface.filePath}
    notebookPath={surface.scopePath}
    resourceKind="image"
    propertiesVisibleByDefault={false}
  />;
}

function VideoFileSurfaceView({ surface }: { surface: VideoFileSurface }) {
  return <MediaResourceView
    filePath={surface.filePath}
    notebookPath={surface.scopePath}
    resourceKind="video"
    propertiesVisibleByDefault={false}
  />;
}

function HtmlFileSurfaceView({ surface }: { surface: HtmlFileSurface }) {
  return <HtmlResourceView
    filePath={surface.filePath}
    scopePath={surface.scopePath}
    documentProps={surface.props}
  />;
}

function UnavailableFileSurfaceView({ surface }: { surface: UnavailableFileSurface }) {
  return <UnavailableFileView filePath={surface.filePath} openContainingFolder />;
}

function MediaResourceSurfaceView({ surface }: { surface: MediaResourceSurface }) {
  return <MediaResourceView
    filePath={surface.filePath}
    notebookPath={surface.notebookPath}
    resourceKind={surface.resourceKind}
    propertiesVisibleByDefault={false}
  />;
}

function PluginArtifactSurfaceView({ surface }: { surface: PluginArtifactSurfaceBase }) {
  return <LazyPluginDocumentView {...surface.props} />;
}

function AgentConversationSurfaceView({ surface }: { surface: AgentConversationSurface }) {
  return <LazyAgentConversationDetail instanceId={surface.instanceId} />;
}

function PluginWorkbenchSurfaceView({ surface }: { surface: PluginWorkbenchSurface }) {
  return <LazyPluginWorkbench {...surface.props} />;
}

function WebSurfaceView({ surface }: { surface: WebSurface }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
      {surface.url}
    </div>
  );
}

const artifactBaseCapabilities = ['fullscreen'] as const;

export const workColumnSurfaceRegistry = Object.freeze({
  note: defineSurface('note', {
    chrome: 'document',
    capabilities: [
      'edit',
      'search',
      'memo-colors',
      'properties',
      'copy-content',
      'export-content',
      'save-template',
      'version-history',
    ],
    component: NoteSurfaceView,
  }),
  md: defineSurface('md', {
    chrome: 'document',
    capabilities: ['edit', 'search', 'copy-content'],
    component: MDSurfaceView,
  }),
  code: defineSurface('code', {
    chrome: 'document',
    capabilities: ['edit', 'search', 'copy-content'],
    component: CodeSurfaceView,
  }),
  'image-file': defineSurface('image-file', {
    chrome: 'document',
    component: ImageFileSurfaceView,
  }),
  'video-file': defineSurface('video-file', {
    chrome: 'document',
    component: VideoFileSurfaceView,
  }),
  'html-file': defineSurface('html-file', {
    chrome: 'document',
    component: HtmlFileSurfaceView,
  }),
  'unavailable-file': defineSurface('unavailable-file', {
    chrome: 'document',
    component: UnavailableFileSurfaceView,
  }),
  media: defineSurface('media', {
    chrome: 'media',
    capabilities: ['properties', 'fullscreen'],
    component: MediaResourceSurfaceView,
  }),
  mindmap: defineSurface('mindmap', {
    chrome: 'document',
    capabilities: [...artifactBaseCapabilities, 'fit', 'zoom'],
    component: PluginArtifactSurfaceView,
  }),
  html: defineSurface('html', {
    chrome: 'document',
    capabilities: artifactBaseCapabilities,
    component: PluginArtifactSurfaceView,
  }),
  json: defineSurface('json', {
    chrome: 'document',
    capabilities: artifactBaseCapabilities,
    component: PluginArtifactSurfaceView,
  }),
  text: defineSurface('text', {
    chrome: 'document',
    capabilities: artifactBaseCapabilities,
    component: PluginArtifactSurfaceView,
  }),
  'plugin-artifact': defineSurface('plugin-artifact', {
    chrome: 'document',
    capabilities: artifactBaseCapabilities,
    component: PluginArtifactSurfaceView,
  }),
  'agent-conversation': defineSurface('agent-conversation', {
    chrome: 'agent',
    capabilities: ['stream-conversation'],
    component: AgentConversationSurfaceView,
  }),
  'plugin-workbench': defineSurface('plugin-workbench', {
    chrome: 'document',
    capabilities: ['run-agent', 'fullscreen'],
    component: PluginWorkbenchSurfaceView,
  }),
  web: defineSurface('web', {
    chrome: 'document',
    component: WebSurfaceView,
  }),
} satisfies Record<WorkColumnSurfaceKind, WorkColumnSurfaceDefinition>);

export function getWorkColumnSurfaceDefinition(
  surface: WorkColumnSurface,
): WorkColumnSurfaceDefinition {
  return workColumnSurfaceRegistry[surface.kind];
}

export function surfaceSupports(
  surface: WorkColumnSurface,
  capability: WorkColumnSurfaceCapability,
): boolean {
  return getWorkColumnSurfaceDefinition(surface).capabilities.includes(capability);
}

function WorkColumnSurfaceMount({ surface }: { surface: WorkColumnSurface }) {
  return getWorkColumnSurfaceDefinition(surface).render(surface);
}

export function WorkColumnSurfaceHost({ surface }: { surface: WorkColumnSurface }) {
  const instanceKey = `${surface.kind}:${surface.instanceKey}`;
  const definition = getWorkColumnSurfaceDefinition(surface);
  return (
    <SurfaceSuspenseHost
      instanceKey={instanceKey}
      loadingTone={definition.chrome}
    >
      <WorkColumnSurfaceMount surface={surface} />
    </SurfaceSuspenseHost>
  );
}

export function WorkColumnContentHost({ content }: { content: WorkColumnContentPresentation }) {
  if (content.status === 'empty') {
    return <WorkspaceEmptyState tone={content.tone} message={content.message} />;
  }

  return <WorkColumnSurfaceHost surface={content.surface} />;
}
