'use client';

import { collectionDisplayDescriptor, findCollectionDisplayPath } from '@/lib/collection-display-registry';
import { useExternalFileContentDetection } from '@features/editor/use-external-file-content-detection';
import { resolveWorkspaceFileSurfaceKind, workspaceSurfaceAppearance } from '@features/workspace/public/surface-api';
import { FileBrowserView } from './file-browser-view';
import { useCallback, useLayoutEffect, useMemo } from 'react';
import { getWorkspaceSurfaceRendererDefinition } from './workspace-surface-renderer-registry';
import type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';
import { resetCurrentCollectionView } from '@features/workspace/public/collection-navigation-api';
import { toast } from '@/lib/toast';
import { workspaceSurfaceContentPresentation } from '@features/workspace/public/surface-api';

export function FileBrowserRenderer({ surface: data, context }: {
  surface: Extract<WorkspaceSurfaceRendererData, { kind: 'file-browser' }>;
  context: WorkspaceSurfaceRenderContext;
}) {
  const surface = data.props;
  const fileSurfaceKind = surface.activeFilePath
    ? resolveWorkspaceFileSurfaceKind(surface.activeFilePath)
    : null;
  const { isTextContent, loading: contentDetectionLoading } = useExternalFileContentDetection(
    surface.activeFilePath,
    surface.scopePath,
    fileSurfaceKind === 'unavailable',
  );
  const fileKind = surface.collectionType === 'media_library'
    ? 'media-library'
    : surface.collectionType === 'table'
      ? 'table'
      : surface.collectionType === 'work_documents'
        ? 'work-documents'
      : resolveWorkspaceFileSurfaceKind(surface.activeFilePath ?? '', null, isTextContent);
  const dynamicKind = `file-${fileKind}` as const;
  const collectionLocationLoading = Boolean(surface.fileIdentity
    && collectionDisplayDescriptor(surface.fileIdentity.displayId)
    && !findCollectionDisplayPath(surface.fileIdentity.displayId));
  const resetUnavailableCollectionView = useCallback(async () => {
    if (!surface.activeFilePath) return;
    try {
      const location = context.host === 'column-2'
        ? { host: context.host, surfaceId: context.viewId } as const
        : { host: context.host } as const;
      await resetCurrentCollectionView(surface.activeFilePath, surface.scopePath, surface.notebookId, location);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重置当前视图失败');
    }
  }, [context.host, context.viewId, surface.activeFilePath, surface.notebookId, surface.scopePath]);
  const unavailableState = useMemo(() => ({
    status: 'unavailable' as const,
    reason: 'unsupported' as const,
    message: {
      key: 'document.file.unavailable',
      ...(surface.collectionUnavailableReason ? { fallbackText: surface.collectionUnavailableReason } : {}),
    },
    actions: [{
      id: 'reset-current-collection-view', label: { key: 'collection.resetCurrentView' }, enabled: true,
      run: resetUnavailableCollectionView,
    }],
  }), [resetUnavailableCollectionView, surface.collectionUnavailableReason]);
  // Publish the resolver baseline before content renderers publish their state.
  useLayoutEffect(() => {
    if (!surface.activeFilePath) {
      context.reportPresentation?.({
        ...workspaceSurfaceContentPresentation('file-browser'),
        state: { status: 'ready' },
      });
      return;
    }
    // The shell owns only resolution/unavailability. Once a content renderer
    // exists, that renderer alone owns loading/ready/error; layout or focus
    // updates must never reset an already loaded document to loading.
    const state = surface.collectionUnavailableReason ? unavailableState
      : contentDetectionLoading || collectionLocationLoading
        ? { status: 'loading' as const, loadingMode: 'blocking' as const, retainContent: true }
        : undefined;
    context.reportPresentation?.({
      ...workspaceSurfaceContentPresentation(dynamicKind),
      ...(state ? { state } : {}),
    });
  }, [collectionLocationLoading, context.reportPresentation, dynamicKind, contentDetectionLoading, surface.activeFilePath, surface.collectionUnavailableReason, unavailableState]);
  if (!surface.activeFilePath) {
    return <FileBrowserView surface={{ ...surface, sourceMenuEnabled: false }} />;
  }

  const stateAppearance = workspaceSurfaceAppearance(`file-${fileSurfaceKind ?? 'unavailable'}`);
  if (surface.collectionUnavailableReason) return context.reportPresentation ? null : <WorkspaceSurfaceStateView
    appearance={stateAppearance}
    state={unavailableState}
    messageOverride={surface.collectionUnavailableReason}
  />;
  if (surface.fileIdentity && collectionDisplayDescriptor(surface.fileIdentity.displayId) && !findCollectionDisplayPath(surface.fileIdentity.displayId)) {
    return context.reportPresentation ? null : <WorkspaceSurfaceStateView
      appearance={stateAppearance}
      state={{ status: 'loading', loadingMode: 'blocking', retainContent: false }}
      messageOverride="正在解析集合位置…"
    />;
  }
  if (contentDetectionLoading) return null;
  const filePath = surface.activeFilePath;
  const fileIdentity = surface.fileIdentity;
  if (!filePath || !fileIdentity) return <FileBrowserView surface={{ ...surface, sourceMenuEnabled: false }} />;

  const expectedCollectionId = collectionDisplayDescriptor(fileIdentity.displayId)?.collectionId ?? null;
  let fileSurface: WorkspaceSurfaceRendererData;
  switch (fileKind) {
    case 'markdown':
      fileSurface = { kind: 'file-markdown', fileIdentity, scopePath: surface.scopePath, documentProps: surface.documentProps };
      break;
    case 'code':
      fileSurface = { kind: 'file-code', fileIdentity, scopePath: surface.scopePath, documentProps: surface.documentProps, instanceKey: context.viewId };
      break;
    case 'csv':
      fileSurface = { kind: 'file-csv', fileIdentity, scopePath: surface.scopePath };
      break;
    case 'image':
      fileSurface = { kind: 'file-image', fileIdentity, scopePath: surface.scopePath };
      break;
    case 'video':
      fileSurface = { kind: 'file-video', fileIdentity, scopePath: surface.scopePath };
      break;
    case 'table':
      fileSurface = {
        kind: 'file-table', fileIdentity,
        props: {
          filePath, fileIdentity, notebookPath: surface.scopePath, notebookId: surface.notebookId ?? null,
          expectedCollectionId, initialViewId: surface.collectionDisplay?.viewId,
          onActiveViewChange: context.onCollectionActiveViewChange,
        },
      };
      break;
    case 'media-library':
      fileSurface = {
        kind: 'file-media-library', fileIdentity, notebookPath: surface.scopePath,
        notebookId: surface.notebookId ?? null, expectedCollectionId,
      };
      break;
    case 'work-documents':
      fileSurface = {
        kind: 'file-work-documents', fileIdentity, notebookPath: surface.scopePath,
        notebookId: surface.notebookId ?? null, expectedCollectionId,
      };
      break;
    case 'html':
      fileSurface = { kind: 'file-html', fileIdentity, scopePath: surface.scopePath,
        documentProps: { ...surface.documentProps, notebookId: surface.notebookId ?? surface.documentProps.notebookId } };
      break;
    case 'docx':
      fileSurface = { kind: 'file-docx', fileIdentity, scopePath: surface.scopePath };
      break;
    case 'unavailable':
      fileSurface = { kind: 'file-unavailable', fileIdentity, scopePath: surface.scopePath, documentProps: surface.documentProps };
      break;
  }

  // The outer workspace view owns presentation and Suspense/error boundaries.
  // Rendering content directly avoids applying the same state/notices twice.
  return getWorkspaceSurfaceRendererDefinition(fileSurface).render(fileSurface, {
      ...context,
      viewId: context.viewId,
      readOnly: Boolean(surface.documentProps.readOnly),
      wrapInFileBrowser: (content) => <FileBrowserView surface={{
        ...surface,
        fileTreeEnabled: false,
        sourceMenuEnabled: false,
        content,
      }} />,
    });
}
