import { WorkFileBrowserView } from './work-file-browser-view';
'use client';

import {
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from 'react';
import { DocumentContainer } from '@features/document/components/document-container';
import { LazyAgentConversationDetail } from '@features/agent/components/lazy-agent-conversation-detail';
import backgroundImage from '@/assets/bg.document.png';
import { useI18n } from '@/lib/i18n';
import type {
  AgentConversationSurface,
  EmptySurface,
  MarkdownSurface,
  PluginArtifactSurfaceBase,
  PluginWorkbenchSurface,
  WorkColumnSurface,
  WorkColumnSurfaceCapability,
  WorkColumnSurfaceChrome,
  WorkColumnSurfaceKind,
  WebSurface,
} from './types';

type SurfaceOfKind<K extends WorkColumnSurfaceKind> = Extract<WorkColumnSurface, { kind: K }>;

const PluginDocumentView = lazy(() =>
  import('@features/plugin/plugin-document-view').then((module) => ({
    default: module.PluginDocumentView,
  })),
);
const PluginWorkbench = lazy(() =>
  import('@features/plugin/plugin-workbench').then((module) => ({
    default: module.PluginWorkbench,
  })),
);

function SurfaceLoadingFallback() {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
      {t('memo.navigation.loading')}
    </div>
  );
}

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

function MarkdownSurfaceView({ surface }: { surface: MarkdownSurface }) {
  return surface.props.isExternalDocument ? <WorkFileBrowserView props={surface.props} /> : <DocumentContainer {...surface.props} />;
}

function PluginArtifactSurfaceView({ surface }: { surface: PluginArtifactSurfaceBase }) {
  return (
    <Suspense fallback={<SurfaceLoadingFallback />}>
      <PluginDocumentView {...surface.props} />
    </Suspense>
  );
}

function AgentConversationSurfaceView({ surface }: { surface: AgentConversationSurface }) {
  return (
    <Suspense fallback={<SurfaceLoadingFallback />}>
      <LazyAgentConversationDetail instanceId={surface.instanceId} />
    </Suspense>
  );
}

function PluginWorkbenchSurfaceView({ surface }: { surface: PluginWorkbenchSurface }) {
  return (
    <Suspense fallback={<SurfaceLoadingFallback />}>
      <PluginWorkbench {...surface.props} />
    </Suspense>
  );
}

function WebSurfaceView({ surface }: { surface: WebSurface }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
      {surface.url}
    </div>
  );
}

function EmptySurfaceView({ surface }: { surface: EmptySurface }) {
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-no-repeat bg-bottom bg-[length:auto_800px] opacity-[0.32]"
        style={{ backgroundImage: `url(${backgroundImage})` }}
      />
      <span className="relative text-center text-sm text-[var(--muted-foreground)]">
        {surface.message}
      </span>
    </div>
  );
}

const artifactBaseCapabilities = ['fullscreen'] as const;

export const workColumnSurfaceRegistry = Object.freeze({
  markdown: defineSurface('markdown', {
    chrome: 'document',
    capabilities: [
      'edit',
      'search',
      'properties',
      'copy-content',
      'export-content',
      'save-template',
      'version-history',
    ],
    component: MarkdownSurfaceView,
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
  empty: defineSurface('empty', {
    chrome: 'document',
    component: EmptySurfaceView,
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
  return (
    <WorkColumnSurfaceMount
      key={`${surface.kind}:${surface.instanceKey}`}
      surface={surface}
    />
  );
}
