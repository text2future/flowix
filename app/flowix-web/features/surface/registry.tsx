'use client';

import { CodeSurfaceFileBrowser } from './work-file-browser-view';
import { DocumentListView } from './document-list-view';
import {
  type ComponentType,
  type ReactNode,
  useLayoutEffect,
  useEffect,
  useState,
} from 'react';
import { notes } from '@platform/tauri/client';
import { PluginArtifactRenderer } from '@features/plugin/plugin-artifact-renderer';
import { normalizePluginArtifactRenderer, type PluginArtifactRendererId } from '@features/plugin/plugin-note';
import { extractFrontmatter } from '@features/document/properties/frontmatter-model';
import { DocumentContainer, UnavailableFileView } from '@features/document/components/document-container';
import { useDocumentStore } from '@features/document/store/document-store';
import { documentIdentityFromFile } from '@features/document/store/document-identity';
import { saveDocumentPath } from '@features/document/store/document-session-service';
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
import { TableDocumentView } from '@features/multidimensional-table/public/surface-api';
import { MediaLibraryView } from '@features/media-library/media-library-view';
import type { MediaLibraryFileSurface, TableFileSurface } from './types';

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

function MDSurfaceView({ surface }: { surface: MDSurface }) {
  const [mindmapContent, setMindmapContent] = useState<string | null>(null);
  const [pluginRenderer, setPluginRenderer] = useState<PluginArtifactRendererId | null>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setMindmapContent(null);
    setPluginRenderer(null);
    setPreview(false);
    void notes.readDocument(surface.fileIdentity.path).then((content) => {
      if (cancelled || !content) return;
      const frontmatter = extractFrontmatter(content);
      const pluginValue = frontmatter.data.flowix_plugin;
      const pluginMetadata = pluginValue && typeof pluginValue === 'object' && !Array.isArray(pluginValue)
        ? pluginValue as Record<string, unknown> : null;
      const pluginId = typeof pluginMetadata?.id === 'string' ? pluginMetadata.id : null;
      const rendererValue = typeof pluginMetadata?.renderer === 'string' ? pluginMetadata.renderer
        : pluginId === 'mindmap' ? 'markmap' : null;
      const renderer = normalizePluginArtifactRenderer(rendererValue);
      if (frontmatter.hasFrontmatter && !frontmatter.parseError && pluginId && renderer) {
        setPluginRenderer(renderer);
        setMindmapContent(frontmatter.body.trimStart());
        setPreview(true);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [surface.fileIdentity.path]);
  return <div className="relative flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1" style={{ display: preview ? 'none' : undefined }}>
      <DocumentContainer {...surface.props} fileIdentity={surface.fileIdentity} externalEditorMode="markdown" />
    </div>
    {preview && mindmapContent !== null && pluginRenderer && <div className="min-h-0 flex-1"><PluginArtifactRenderer renderer={pluginRenderer} content={mindmapContent} /></div>}
    {mindmapContent !== null && pluginRenderer && <button type="button" className="mindmap-markdown-toggle"
        onClick={() => {
          if (!preview) {
            const session = useDocumentStore.getState().activeExternalSession;
            const scopePath = session?.fileIdentity.path === surface.fileIdentity.path ? session.scopePath : null;
            void saveDocumentPath(documentIdentityFromFile(surface.fileIdentity), surface.fileIdentity.path, scopePath)
              .then((saved) => saved ? notes.readDocument(surface.fileIdentity.path) : null)
              .then((content) => {
              const frontmatter = content ? extractFrontmatter(content) : null;
              const pluginValue = frontmatter?.data.flowix_plugin;
              const pluginId = pluginValue && typeof pluginValue === 'object' && !Array.isArray(pluginValue)
                ? (pluginValue as Record<string, unknown>).id : null;
              if (frontmatter?.hasFrontmatter && !frontmatter.parseError && pluginId === 'mindmap') {
                setMindmapContent(frontmatter.body.trimStart());
                setPreview(true);
              }
            }).catch(() => undefined);
          } else {
            setPreview(false);
          }
        }}>{preview ? '编辑 Markdown' : '预览思维导图'}</button>}
  </div>;
}

function CodeSurfaceView({ surface }: { surface: CodeSurface }) {
  return <CodeSurfaceFileBrowser surface={surface} />;
}

function ImageFileSurfaceView({ surface }: { surface: ImageFileSurface }) {
  return <MediaResourceView
    filePath={surface.fileIdentity.path}
    notebookPath={surface.scopePath}
    resourceKind="image"
  />;
}

function VideoFileSurfaceView({ surface }: { surface: VideoFileSurface }) {
  return <MediaResourceView
    filePath={surface.fileIdentity.path}
    notebookPath={surface.scopePath}
    resourceKind="video"
  />;
}

function TableFileSurfaceView({ surface }: { surface: TableFileSurface }) {
  return <TableDocumentView {...surface.props} fileIdentity={surface.fileIdentity} />;
}

function MediaLibraryFileSurfaceView({ surface }: { surface: MediaLibraryFileSurface }) {
  return <MediaLibraryView filePath={surface.fileIdentity.path} fileIdentity={surface.fileIdentity} notebookPath={surface.notebookPath} notebookId={surface.notebookId} />;
}

function HtmlFileSurfaceView({ surface }: { surface: HtmlFileSurface }) {
  return <HtmlResourceView
    filePath={surface.fileIdentity.path}
    scopePath={surface.scopePath}
    documentProps={{ ...surface.props, fileIdentity: surface.fileIdentity }}
  />;
}

function UnavailableFileSurfaceView({ surface }: { surface: UnavailableFileSurface }) {
  return <UnavailableFileView filePath={surface.fileIdentity.path} />;
}

function MediaResourceSurfaceView({ surface }: { surface: MediaResourceSurface }) {
  return <MediaResourceView
    filePath={surface.fileIdentity.path}
    notebookPath={surface.notebookPath}
    resourceKind={surface.resourceKind}
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
  md: defineSurface('md', {
    chrome: 'document',
    capabilities: ['edit', 'search', 'copy-content', 'export-content', 'save-template'],
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
  'table-file': defineSurface('table-file', {
    chrome: 'document',
    capabilities: [],
    component: TableFileSurfaceView,
  }),
  'media-library-file': defineSurface('media-library-file', {
    chrome: 'document',
    capabilities: [],
    component: MediaLibraryFileSurfaceView,
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
    capabilities: ['fullscreen'],
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
  'document-list': defineSurface('document-list', {
    chrome: 'document',
    component: DocumentListView,
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

function transitionFinishedOnMount(surface: WorkColumnSurface): number | null {
  switch (surface.kind) {
    case 'image-file':
    case 'video-file':
    case 'unavailable-file':
      return surface.props.transitionId ?? null;
    default:
      return null;
  }
}

function WorkColumnSurfaceMount({ surface }: { surface: WorkColumnSurface }) {
  const immediateTransitionId = transitionFinishedOnMount(surface);

  useLayoutEffect(() => {
    // These views have no DocumentContainer to finish the transition after
    // reading content; their own loading UI remains active.
    if (typeof immediateTransitionId === 'number') {
      useDocumentStore.getState().finishDocumentTransition(immediateTransitionId);
    }
  }, [immediateTransitionId]);

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
