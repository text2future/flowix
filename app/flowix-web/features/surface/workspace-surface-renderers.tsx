'use client';

import { lazy, useCallback, useEffect, useState } from 'react';

import { useExternalFileContentDetection } from '@features/editor/use-external-file-content-detection';
import { externalFileViewKind } from '@features/editor/public/code-file';
import { workspaceSurfaceAppearance, workspaceSurfaceContentPresentation } from '@features/workspace/public/surface-api';

import { LazyAgentConversationDetail } from '@features/agent/components/lazy-agent-conversation-detail';
import { LazyPluginDocumentView, LazyPluginWorkbench } from '@features/plugin/public/surface-api';
import { NoteDocumentLoadingSkeleton } from '@shared/ui/note-document-loading-skeleton';

import type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-registry';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';
import { usePathIndexExcluded } from './use-path-index-excluded';
import { useWorkspaceSurfaceLifecycleBridge } from './workspace-surface-lifecycle-bridge';
import { CollectionShell } from './collection-shell';
import type { DocumentContentStatus } from '@features/document/components/session/types';
import { notes } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { displayTitleFromFilename } from '@/lib/utils';

const NO_SURFACE_ACTIONS: readonly [] = [];

function fileHeaderTitle(path: string): string {
  return displayTitleFromFilename(path) || '文件';
}

function publishDocumentContentState(
  reportPresentation: WorkspaceSurfaceRenderContext['reportPresentation'],
  contentState: DocumentContentStatus,
  silentLoading = false,
) {
  if (!reportPresentation) return;
  switch (contentState.status) {
    case 'loading':
      reportPresentation({ state: silentLoading
        ? { status: 'loading', loadingMode: 'background', retainContent: true }
        : { status: 'loading', loadingMode: 'blocking', retainContent: contentState.retainContent } });
      break;
    case 'error':
      reportPresentation({ state: {
        status: 'error', message: { key: 'error.unexpected', fallbackText: contentState.message },
        actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: contentState.retry }],
      } });
      break;
    case 'missing-note':
      reportPresentation({ state: {
        status: 'error', message: { key: 'document.load.missingNoteTitle' }, detailText: contentState.path,
        actions: [
          { id: 'retry', label: { key: 'error.retry' }, enabled: true, run: contentState.retry },
          { id: 'delete', label: { key: 'document.action.delete' }, enabled: true, run: async () => {
            try {
              const outcome = await notes.pruneMissing(contentState.path);
              if (outcome === 'present') {
                await contentState.retry();
                return;
              }
              // The confirmed resource-deleted event owns list, tab and work
              // target cleanup in every window.
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error));
            }
          } },
        ],
      } });
      break;
    case 'ready':
      reportPresentation({ state: { status: 'ready' } });
      break;
  }
}

// Keep the wrapper module lightweight: each content view loads only when selected.
const DocumentContainer = lazy(() => import('@features/document/components/document-container').then((module) => ({ default: module.DocumentContainer })));
const UnavailableFileView = lazy(() => import('@features/document/components/document-container').then((module) => ({ default: module.UnavailableFileView })));
const DocxPreview = lazy(() => import('@features/document/components/docx-preview').then((module) => ({ default: module.DocxPreview })));
const CsvPreview = lazy(() => import('@features/document/components/csv-preview').then((module) => ({ default: module.CsvPreview })));
const MediaResourceView = lazy(() => import('./media-resource-view').then((module) => ({ default: module.MediaResourceView })));
const MarkdownDocumentSurface = lazy(() => import('./markdown-document-surface').then((module) => ({ default: module.MarkdownDocumentSurface })));
const HtmlResourceView = lazy(() => import('./html-resource-view').then((module) => ({ default: module.HtmlResourceView })));
const CodeSurfaceFileBrowser = lazy(() => import('./work-file-browser-view').then((module) => ({ default: module.CodeSurfaceFileBrowser })));

type SurfaceOfKind<K extends WorkspaceSurfaceRendererData['kind']> = Extract<WorkspaceSurfaceRendererData, { kind: K }>;
type RendererProps<K extends WorkspaceSurfaceRendererData['kind']> = {
  surface: SurfaceOfKind<K>;
  context: WorkspaceSurfaceRenderContext;
};

export function MarkdownRenderer({ surface, context }: RendererProps<'file-markdown'>) {
  // Markdown never blocks: see workspaceSurfaceSilentLoading. While the
  // document session resolves, the surface paints its own note skeleton
  // instead of the common centered loader.
  const [contentLoading, setContentLoading] = useState(true);
  const onContentStateChange = useCallback((state: DocumentContentStatus) => {
    setContentLoading(state.status === 'loading');
    publishDocumentContentState(context.reportPresentation, state, true);
  }, [context.reportPresentation]);
  return <div className="relative flex h-full min-h-0 w-full flex-col">
    <MarkdownDocumentSurface
      fileIdentity={surface.fileIdentity}
      documentProps={{ ...surface.documentProps, workspaceHost: context.host,
        initialFocus: context.initialFocus ?? surface.documentProps.initialFocus,
        onContentStateChange: context.reportPresentation ? onContentStateChange : undefined }}
      navigationViewId={context.host === 'column-2' ? context.viewId : undefined}
      reportPresentation={context.reportPresentation}
      registerLifecycle={context.registerLifecycle}
    />
    {contentLoading && <div className="pointer-events-none absolute inset-0 z-10 bg-[var(--document-bg)]">
      <NoteDocumentLoadingSkeleton />
    </div>}
  </div>;
}

export function CodeRenderer({ surface, context }: RendererProps<'file-code'>) {
  useEffect(() => {
    context.reportPresentation?.({ title: fileHeaderTitle(surface.fileIdentity.path) });
  }, [context.reportPresentation, surface.fileIdentity.path]);
  const onContentStateChange = useCallback((state: DocumentContentStatus) => {
    publishDocumentContentState(context.reportPresentation, state);
  }, [context.reportPresentation]);
  const documentProps = useWorkspaceSurfaceLifecycleBridge({
    ...surface.documentProps,
    workspaceHost: context.host,
    initialFocus: context.initialFocus ?? surface.documentProps.initialFocus,
    onContentStateChange: context.reportPresentation ? onContentStateChange : undefined,
  }, context.registerLifecycle);
  if (context.host === 'column-1') {
    const workSurface = {
      kind: 'code' as const,
      instanceKey: surface.instanceKey,
      fileIdentity: surface.fileIdentity,
      props: documentProps,
    };
    return <CodeSurfaceFileBrowser surface={workSurface} />;
  }
  const content = <DocumentContainer
    {...documentProps}
    fileIdentity={surface.fileIdentity}
    navigationViewId={context.viewId}
    externalScopePath={surface.scopePath}
  />;
  return context.wrapInFileBrowser?.(content) ?? content;
}

export function CsvRenderer({ surface, context }: RendererProps<'file-csv'>) {
  const props = useWorkspaceSurfaceLifecycleBridge({
    filePath: surface.fileIdentity.path, scopePath: surface.scopePath,
  }, context.registerLifecycle);
  return <CsvPreview {...props} reportPresentation={context.reportPresentation} />;
}

export function ImageRenderer({ surface, context }: RendererProps<'file-image'>) {
  return <MediaResourceView filePath={surface.fileIdentity.path} notebookPath={surface.scopePath} resourceKind="image"
    reportPresentation={context.reportPresentation} />;
}

export function VideoRenderer({ surface, context }: RendererProps<'file-video'>) {
  return <MediaResourceView filePath={surface.fileIdentity.path} notebookPath={surface.scopePath} resourceKind="video"
    reportPresentation={context.reportPresentation} />;
}

/** All collection file kinds use the same shell, including legacy single-domain files. */
function CollectionFileRenderer({ surface, context }: RendererProps<'file-table' | 'file-media-library' | 'file-work-documents'>) {
  const surfaceProps = surface.kind === 'file-table' ? surface.props : {
    filePath: surface.fileIdentity.path,
    notebookPath: surface.notebookPath,
    notebookId: surface.notebookId,
    expectedCollectionId: surface.expectedCollectionId,
  };
  const props = useWorkspaceSurfaceLifecycleBridge(surfaceProps, context.registerLifecycle);
  return <CollectionShell
    {...props}
    editable={!context.readOnly && (surface.kind === 'file-table' ? surface.props.editable ?? true : true)}
    fileIdentity={surface.fileIdentity}
    host={context.host}
    reportPresentation={context.reportPresentation}
  />;
}

export function TableRenderer(props: RendererProps<'file-table'>) {
  return <CollectionFileRenderer {...props} />;
}

export function MediaLibraryRenderer(props: RendererProps<'file-media-library'>) {
  return <CollectionFileRenderer {...props} />;
}

export function WorkDocumentsCollectionRenderer(props: RendererProps<'file-work-documents'>) {
  return <CollectionFileRenderer {...props} />;
}

export function HtmlRenderer({ surface, context }: RendererProps<'file-html'>) {
  useEffect(() => {
    context.reportPresentation?.({ title: fileHeaderTitle(surface.fileIdentity.path) });
  }, [context.reportPresentation, surface.fileIdentity.path]);
  const documentProps = useWorkspaceSurfaceLifecycleBridge({
    ...surface.documentProps,
    fileIdentity: surface.fileIdentity,
    workspaceHost: context.host,
    initialFocus: context.initialFocus ?? surface.documentProps.initialFocus,
  }, context.registerLifecycle);
  return <HtmlResourceView
    filePath={surface.fileIdentity.path}
    scopePath={surface.scopePath}
    documentProps={documentProps}
    reportPresentation={context.reportPresentation}
  />;
}

export function DocxRenderer({ surface, context }: RendererProps<'file-docx'>) {
  const preview = <DocxPreview filePath={surface.fileIdentity.path} scopePath={surface.scopePath} reportPresentation={context.reportPresentation} />;
  return context.host === 'column-2' ? context.wrapInFileBrowser?.(preview) ?? preview : preview;
}

export function UnavailableRenderer({ surface, context }: RendererProps<'file-unavailable'>) {
  const onContentStateChange = useCallback((state: DocumentContentStatus) => {
    publishDocumentContentState(context.reportPresentation, state);
  }, [context.reportPresentation]);
  const filePath = surface.fileIdentity.path;
  const documentProps = useWorkspaceSurfaceLifecycleBridge({
    ...surface.documentProps,
    workspaceHost: context.host,
    initialFocus: context.initialFocus ?? surface.documentProps?.initialFocus,
    onContentStateChange: context.reportPresentation ? onContentStateChange : undefined,
  }, context.registerLifecycle);
  const baseFileKind = externalFileViewKind(filePath);
  const { isTextContent, loading: contentDetectionLoading } = useExternalFileContentDetection(filePath, surface.scopePath, baseFileKind === 'unavailable');
  const resolvedFileKind = externalFileViewKind(filePath, null, isTextContent);
  const hasDocumentProps = Boolean(surface.documentProps);
  useEffect(() => {
    if (baseFileKind === 'docx' || baseFileKind === 'csv') return;
    if (contentDetectionLoading) {
      context.reportPresentation?.({ state: {
        status: 'loading', loadingMode: 'blocking', retainContent: false,
      } });
    } else if (resolvedFileKind === 'code' && hasDocumentProps) {
      context.reportPresentation?.({ title: fileHeaderTitle(filePath), ...workspaceSurfaceContentPresentation('file-code'), actions: NO_SURFACE_ACTIONS });
    }
  }, [baseFileKind, context.reportPresentation, hasDocumentProps, contentDetectionLoading, resolvedFileKind]);
  if (baseFileKind === 'docx') {
    const preview = <DocxPreview filePath={filePath} scopePath={surface.scopePath} reportPresentation={context.reportPresentation} />;
    return context.host === 'column-2' ? context.wrapInFileBrowser?.(preview) ?? preview : preview;
  }
  if (baseFileKind === 'csv') return <CsvPreview filePath={filePath} scopePath={surface.scopePath}
    onSurfaceLifecycleReady={documentProps.onSurfaceLifecycleReady} reportPresentation={context.reportPresentation} />;
  if (contentDetectionLoading) return context.reportPresentation ? null : <WorkspaceSurfaceStateView
    appearance={workspaceSurfaceAppearance('file-unavailable')}
    state={{ status: 'loading', loadingMode: 'blocking', retainContent: false }}
  />;
  if (resolvedFileKind === 'code' && surface.documentProps) {
    const content = <DocumentContainer
      {...documentProps}
      initialFocus={context.initialFocus ?? surface.documentProps.initialFocus}
      fileIdentity={surface.fileIdentity}
      navigationViewId={context.host === 'column-2' ? context.viewId : undefined}
      externalScopePath={surface.scopePath}
    />;
    return context.host === 'column-2' ? context.wrapInFileBrowser?.(content) ?? content : content;
  }
  return <UnavailableFileView filePath={filePath} openContainingFolder scopePath={surface.scopePath} reportPresentation={context.reportPresentation} />;
}

export function MediaResourceRenderer({ surface, context }: RendererProps<'media'>) {
  return <MediaResourceView
    filePath={surface.fileIdentity.path}
    notebookPath={surface.notebookPath}
    resourceKind={surface.resourceKind}
    reportPresentation={context.reportPresentation}
  />;
}

export function AgentConversationRenderer({ surface, context }: RendererProps<'agent-conversation'>) {
  return <LazyAgentConversationDetail instanceId={surface.instanceId} host={context.host} reportPresentation={context.reportPresentation} />;
}

export function PluginDocumentRenderer({ surface, context }: RendererProps<'mindmap' | 'plugin-artifact'>) {
  return <LazyPluginDocumentView {...surface.props} reportPresentation={context.reportPresentation} />;
}

export function PluginWorkbenchRenderer({ surface, context }: RendererProps<'plugin-workbench'>) {
  return <LazyPluginWorkbench {...surface.props} reportPresentation={context.reportPresentation} />;
}

export function CollectionRenderer({ surface, context }: RendererProps<'collection'>) {
  const { t } = useI18n();
  // Ask before offering the chooser: every index skips these folders, so both
  // choices would open a view that can never list anything.
  const indexExcluded = usePathIndexExcluded(surface.folderPath);

  useEffect(() => {
    context.reportPresentation?.({ state: { status: 'ready' } });
  }, [context.reportPresentation]);

  if (indexExcluded === null) return null;
  if (indexExcluded) {
    return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto p-6 text-center">
      <p className="text-sm font-medium text-[var(--foreground)]">{t('memo.fileTree.hiddenFolderTitle')}</p>
      <p className="text-sm text-[var(--muted-foreground)]">{t('memo.fileTree.hiddenFolderNoPreview')}</p>
    </div>;
  }

  // 文件夹入口与集合文件入口是同一套外壳：这里只多给一个 folderPath，
  // 它既表示「集合缺失时就地建齐」，也表示这是文件夹类型的集合（多一个文件树 tab）。
  return <CollectionShell
    folderPath={surface.folderPath}
    editable={!context.readOnly}
    reportPresentation={context.reportPresentation}
    notebookId={surface.notebookId}
    notebookPath={surface.notebookPath}
    host={context.host}
  />;
}
