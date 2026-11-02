import { primarySurfaceInstanceId, primaryEntryIdForTarget } from '@features/workspace/public/session-runtime-api';
import { resolveBrowserColumnSurface } from './browser-column-registry';
import { collectionSessionKey } from '@/lib/collection-session-key';
import { canonicalPath } from '@/lib/path';
import {
  resolveWorkspaceFileSurfaceKind,
  workspaceFileSurfaceSupportsHost,
} from '@features/workspace/public/surface-api';
import type {
  DocumentSurfaceContext,
  PluginWorkbenchContext,
  WorkColumnContentPresentation,
  ResolveWorkColumnContentInput,
  WorkColumnEmptyReason,
  WorkColumnEmptyStateTone,
  WorkColumnSurface,
} from './types';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';
import { requireFileDisplayIdentity } from '@/lib/file-display-registry';
import { resetCurrentCollectionView } from '@features/workspace/public/collection-navigation-api';
import { toast } from '@/lib/toast';

function assertNever(value: never): never {
  throw new Error(`Unsupported plugin artifact renderer: ${String(value)}`);
}

function emptyContent(
  message: string,
  reason: WorkColumnEmptyReason,
  tone: WorkColumnEmptyStateTone = 'document',
): Extract<WorkColumnContentPresentation, { status: 'empty' }> {
  return { status: 'empty', message, reason, tone };
}

function surfaceContent(surface: WorkColumnSurface): WorkColumnContentPresentation {
  return { status: 'surface', surface };
}

function resolveExternalDocumentSurface(
  document: Extract<DocumentSurfaceContext, { identity: { kind: 'external' } }>,
): WorkColumnSurface {
  const { instanceKey } = document;
  const { fileIdentity } = document.identity;
  const filePath = fileIdentity.path;
  const scopePath = document.identity.scopePath;
  const fileSurfaceKind = resolveWorkspaceFileSurfaceKind(filePath);
  if (!workspaceFileSurfaceSupportsHost(fileSurfaceKind, 'main-third')) {
    throw new Error(`Work column does not support file surface '${fileSurfaceKind}'`);
  }

  switch (fileSurfaceKind) {
    case 'markdown':
      return { kind: 'md', instanceKey, fileIdentity, props: document.documentProps };
    case 'html':
      return { kind: 'html-file', instanceKey, fileIdentity, scopePath, props: document.documentProps };
    case 'image':
      return { kind: 'image-file', instanceKey, fileIdentity, scopePath, props: document.documentProps };
    case 'video':
      return { kind: 'video-file', instanceKey, fileIdentity, scopePath, props: document.documentProps };
    case 'code':
      return { kind: 'code', instanceKey, fileIdentity, props: document.documentProps };
    case 'csv':
      return { kind: 'csv-file', instanceKey, fileIdentity, scopePath, transitionId: document.documentProps.transitionId };
    case 'docx':
      return { kind: 'unavailable-file', instanceKey, fileIdentity, scopePath, props: document.documentProps };
    case 'unavailable':
      return { kind: 'unavailable-file', instanceKey, fileIdentity, scopePath, props: document.documentProps };
    case 'table':
      return {
        kind: 'table-file',
        instanceKey,
        fileIdentity,
        props: { filePath, fileIdentity, notebookPath: scopePath, notebookId: null },
      };
    case 'media-library':
      return { kind: 'media-library-file', instanceKey, fileIdentity, notebookPath: scopePath, notebookId: null };
    case 'work-documents':
      return { kind: 'work-documents-file', instanceKey, fileIdentity, notebookPath: scopePath, notebookId: null };
  }
}

function resolveMediaTargetContent(
  target: Extract<WorkColumnTarget, { kind: 'media' }>,
): WorkColumnContentPresentation {
  const filePath = target.filePath.trim();
  if (!filePath || !target.notebookPath?.trim()) {
    return emptyContent('媒体资源上下文无效', 'invalid-target');
  }
  const fileIdentity = requireFileDisplayIdentity(filePath);
  return surfaceContent({
    kind: 'media',
    instanceKey: fileIdentity.displayId,
    fileIdentity,
    notebookId: target.notebookId,
    notebookPath: target.notebookPath,
    resourceKind: target.resourceKind,
  });
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  return left != null && right != null && canonicalPath(left) === canonicalPath(right);
}

function sameTransition(left: number | null | undefined, right: number | null): boolean {
  return left === right;
}

function isExternalDocumentContext(
  target: Extract<WorkColumnTarget, { kind: 'external' }>,
  document: DocumentSurfaceContext,
): document is Extract<DocumentSurfaceContext, { identity: { kind: 'external' } }> {
  if (!('documentProps' in document) || document.identity.kind !== 'external') return false;
  const props = document.documentProps;
  return samePath(document.identity.fileIdentity.path, target.path)
    && ((document.identity.scopePath == null && target.scopePath == null)
      || samePath(document.identity.scopePath, target.scopePath))
    && sameTransition(document.identity.transitionId, target.transitionId)
    && props.isExternalDocument === true
    && ((props.externalScopePath == null && target.scopePath == null)
      || samePath(props.externalScopePath, target.scopePath))
    && sameTransition(props.transitionId, target.transitionId);
}

function isPluginWorkbenchContext(
  target: Extract<WorkColumnTarget, { kind: 'plugin-workbench' }>,
  context: PluginWorkbenchContext,
): boolean {
  return context.plugin.manifest.id === target.plugin.manifest.id;
}

function resolveWorkColumnTarget(
  target: WorkColumnTarget,
  input: Pick<ResolveWorkColumnContentInput, 'document' | 'pluginWorkbench' | 'emptyMessage'>,
): WorkColumnContentPresentation {
  if ((target.kind === 'collection' || target.kind === 'table' || target.kind === 'media-library') && target.unavailableReason) {
    return {
      ...emptyContent(target.unavailableReason, 'invalid-target'),
      actions: [{
        id: 'reset-current-collection-view',
        label: { key: 'collection.resetCurrentView' },
        enabled: Boolean(target.filePath),
        run: async () => {
          try { await resetCurrentCollectionView(target.filePath, target.notebookPath, target.notebookId); }
          catch (error) { toast.error(error instanceof Error ? error.message : '重置当前视图失败'); }
        },
      }],
    };
  }
  switch (target.kind) {
    case 'file-browser':
      return surfaceContent(resolveBrowserColumnSurface({
        id: 'primary-file-browser', title: target.activeFilePath ?? target.folderPath ?? '', icon: null, target,
      }, { runtimeHost: 'main-third' }));
    case 'folder-collection':
      return surfaceContent({ kind: 'folder-collection', instanceKey: `${target.notebookId}:${target.folderPath}:${target.viewMode ?? 'chooser'}`,
        notebookId: target.notebookId, notebookPath: target.notebookPath, folderPath: target.folderPath, folderName: target.folderName,
        viewMode: target.viewMode });
    case 'empty':
      return emptyContent(input.emptyMessage, 'no-target');
    case 'web':
      return surfaceContent({ kind: 'web', instanceKey: primarySurfaceInstanceId(target, target.url), url: target.url });
    case 'agent-conversation':
      return target.instanceId.trim()
        ? surfaceContent({ kind: 'agent-conversation', instanceKey: `agent:${target.instanceId}`, instanceId: target.instanceId })
        : emptyContent(input.emptyMessage, 'invalid-target', 'agent');
    case 'plugin-workbench': {
      const context = input.pluginWorkbench;
      if (!context || !isPluginWorkbenchContext(target, context)) {
        return emptyContent(input.emptyMessage, 'stale-context');
      }
      return surfaceContent({
        kind: 'plugin-workbench',
        instanceKey: `plugin:${target.plugin.manifest.id}`,
        props: context,
      });
    }
    case 'media':
      return resolveMediaTargetContent(target);
    case 'collection': {
      const fileIdentity = { path: target.filePath, displayId: target.displayId };
      if (target.collectionType === 'media_library') {
        return surfaceContent({ kind: 'media-library-file', instanceKey: target.displayId, fileIdentity, notebookId: target.notebookId, notebookPath: target.notebookPath });
      }
      if (target.collectionType === 'work_documents') {
        return surfaceContent({ kind: 'work-documents-file', instanceKey: target.displayId, fileIdentity,
          notebookId: target.notebookId, notebookPath: target.notebookPath, expectedCollectionId: target.collectionId });
      }
      return surfaceContent({ kind: 'table-file', instanceKey: collectionSessionKey({ ...target, expectedCollectionId: target.collectionId }), fileIdentity,
        props: { filePath: target.filePath, fileIdentity, notebookId: target.notebookId, notebookPath: target.notebookPath,
          expectedCollectionId: target.collectionId, initialViewId: target.viewId ?? undefined } });
    }
    case 'table': {
      const filePath = target.filePath.trim();
      if (!filePath) return emptyContent('多维表格路径无效', 'invalid-target');
      const fileIdentity = requireFileDisplayIdentity(filePath);
      return surfaceContent({
        kind: 'table-file',
        instanceKey: fileIdentity.displayId,
        fileIdentity,
        props: { filePath, fileIdentity, notebookPath: target.notebookPath, notebookId: target.notebookId },
      });
    }
    case 'media-library': {
      const filePath = target.filePath.trim();
      if (!filePath) return emptyContent('媒体库路径无效', 'invalid-target');
      const fileIdentity = requireFileDisplayIdentity(filePath);
      return surfaceContent({
        kind: 'media-library-file',
        instanceKey: fileIdentity.displayId,
        fileIdentity,
        notebookPath: target.notebookPath,
        notebookId: target.notebookId,
      });
    }
    case 'external':
      return input.document && isExternalDocumentContext(target, input.document)
        ? surfaceContent(resolveExternalDocumentSurface(input.document))
        : emptyContent(input.emptyMessage, 'stale-context');
    default:
      return assertNever(target);
  }
}

/** Resolve the main workspace target into either a renderable surface or an empty state. */
export function resolveWorkColumnContent(
  input: ResolveWorkColumnContentInput,
): WorkColumnContentPresentation {
  const content = resolveWorkColumnTarget(input.navigation.target, input);
  const sessionEntryId = primaryEntryIdForTarget(input.navigation.target);
  return content.status === 'surface' && sessionEntryId ? { ...content, surface: { ...content.surface, sessionEntryId } } : content;
}
