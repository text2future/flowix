import type { PluginArtifactRendererId } from '@features/plugin/plugin-note';
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

function artifactSurface(
  instanceKey: string,
  memoId: string,
  transitionId: number | undefined,
  renderer: PluginArtifactRendererId | null,
): WorkColumnSurface {
  const base = { instanceKey, renderer, props: { memoId, transitionId } };
  switch (renderer) {
    case 'markmap': return { ...base, kind: 'mindmap', renderer };
    case 'html':
    case 'webpage': return { ...base, kind: 'html', renderer };
    case 'json-viewer': return { ...base, kind: 'json', renderer };
    case 'markdown':
    case 'text': return { ...base, kind: 'text', renderer };
    case null: return { ...base, kind: 'plugin-artifact' };
    default: return assertNever(renderer);
  }
}

function resolveDocumentSurface(
  document: Extract<DocumentSurfaceContext, { identity: { kind: 'memo' } }>,
): WorkColumnSurface {
  return document.surface;
}

function resolveExternalDocumentSurface(
  document: Extract<DocumentSurfaceContext, { identity: { kind: 'external' } }>,
): WorkColumnSurface {
  const { filePath } = document.documentProps;
  const { instanceKey } = document;
  const scopePath = document.identity.scopePath;

  switch (externalFileViewKind(filePath)) {
    case 'markdown':
      return { kind: 'md', instanceKey, props: document.documentProps };
    case 'html':
      return { kind: 'html-file', instanceKey, filePath, scopePath, props: document.documentProps };
    case 'image':
      return { kind: 'image-file', instanceKey, filePath, scopePath, props: document.documentProps };
    case 'video':
      return { kind: 'video-file', instanceKey, filePath, scopePath, props: document.documentProps };
    case 'code':
      return { kind: 'code', instanceKey, props: document.documentProps };
    case 'unavailable':
      return { kind: 'unavailable-file', instanceKey, filePath, props: document.documentProps };
  }
}

function resolveMediaTargetContent(
  target: Extract<WorkColumnTarget, { kind: 'media' }>,
): WorkColumnContentPresentation {
  const filePath = target.filePath.trim();
  if (!filePath || !target.notebookPath?.trim()) {
    return emptyContent('媒体资源上下文无效', 'invalid-target');
  }
  return surfaceContent({
    kind: 'media',
    instanceKey: `media:${filePath}`,
    filePath,
    notebookId: target.notebookId,
    notebookPath: target.notebookPath,
    resourceKind: target.resourceKind,
  });
}

function resolveArtifactTargetContent(
  target: Extract<WorkColumnTarget, { kind: 'artifact' }>,
  emptyMessage: string,
): WorkColumnContentPresentation {
  const pointerMemoId = target.pointerMemoId.trim();
  if (!pointerMemoId) {
    return emptyContent(emptyMessage, 'invalid-artifact');
  }
  return surfaceContent(artifactSurface(
    `artifact:${pointerMemoId}`,
    pointerMemoId,
    undefined,
    target.renderer,
  ));
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  return left != null && right != null && canonicalPath(left) === canonicalPath(right);
}

function sameTransition(left: number | null | undefined, right: number | null): boolean {
  return left === right;
}

/** Reject adjacent-render stale contexts instead of mounting them under a new target. */
function isMemoDocumentContext(
  target: Extract<WorkColumnTarget, { kind: 'memo' }>,
  document: DocumentSurfaceContext,
): document is Extract<DocumentSurfaceContext, { identity: { kind: 'memo' } }> {
  if (document.identity.kind !== 'memo' || document.surface.kind !== 'note') return false;
  const props = document.surface.props;
  return document.identity.kind === 'memo'
    && document.identity.memoId === target.memoId
    && samePath(document.identity.path, target.path)
    && document.identity.notebookId === target.notebookId
    && ((document.identity.notebookPath == null && target.notebookPath == null)
      || samePath(document.identity.notebookPath, target.notebookPath))
    && sameTransition(document.identity.transitionId, target.transitionId)
    && document.memo?.id === target.memoId
    && document.surface.memoId === target.memoId
    && props.notebookId === target.notebookId
    && ((props.notebookPath == null && target.notebookPath == null)
      || samePath(props.notebookPath, target.notebookPath))
    && !props.isExternalDocument
    && samePath(props.filePath, target.path)
    && sameTransition(props.transitionId, target.transitionId);
}

function isExternalDocumentContext(
  target: Extract<WorkColumnTarget, { kind: 'external' }>,
  document: DocumentSurfaceContext,
): document is Extract<DocumentSurfaceContext, { identity: { kind: 'external' } }> {
  if (document.identity.kind !== 'external') return false;
  const props = document.documentProps;
  return samePath(document.identity.path, target.path)
    && ((document.identity.scopePath == null && target.scopePath == null)
      || samePath(document.identity.scopePath, target.scopePath))
    && sameTransition(document.identity.transitionId, target.transitionId)
    && document.memo === null
    && props.memoId === null
    && props.isExternalDocument === true
    && samePath(props.filePath, target.path)
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
    case 'artifact':
      return resolveArtifactTargetContent(target, input.emptyMessage);
    case 'media':
      return resolveMediaTargetContent(target);
    case 'memo':
      return input.document && isMemoDocumentContext(target, input.document)
        ? surfaceContent(resolveDocumentSurface(input.document))
        : emptyContent(input.emptyMessage, 'stale-context');
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
