import { canonicalPath } from '@/lib/path';
import { externalFileViewKind } from '@features/editor/public/code-file';
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

function assertNever(value: never): never {
  throw new Error(`Unsupported plugin artifact renderer: ${String(value)}`);
}

function emptyContent(
  message: string,
  reason: WorkColumnEmptyReason,
  tone: WorkColumnEmptyStateTone = 'document',
): WorkColumnContentPresentation {
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

  if (/\.lib\.ya?ml$/i.test(filePath)) {
    return { kind: 'media-library-file', instanceKey, fileIdentity, notebookPath: scopePath, notebookId: null };
  }

  if (/\.table\.ya?ml$/i.test(filePath)) {
    return {
      kind: 'table-file',
      instanceKey,
      fileIdentity,
      props: { filePath, fileIdentity, notebookPath: scopePath, notebookId: null },
    };
  }

  switch (externalFileViewKind(filePath)) {
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
    case 'unavailable':
      return { kind: 'unavailable-file', instanceKey, fileIdentity, props: document.documentProps };
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
  switch (target.kind) {
    case 'empty':
      return emptyContent(input.emptyMessage, 'no-target');
    case 'document-list':
      return surfaceContent({ kind: 'document-list', displayId: target.displayId, instanceKey: target.displayId, folderPath: target.scope.path, notebookPath: target.scope.notebookPath, notebookId: target.scope.notebookId, filters: target.filters });
    case 'web':
      return surfaceContent({ kind: 'web', instanceKey: target.url, url: target.url });
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
  return resolveWorkColumnTarget(input.navigation.target, input);
}
