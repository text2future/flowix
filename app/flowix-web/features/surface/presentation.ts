import { resolveWorkspaceHeaderModel } from '@features/workspace/public/header-api';
import { getWorkColumnSurfaceDefinition } from './registry';
import { resolveWorkColumnContent } from './resolver';
import type {
  WorkColumnContentPresentation,
  ResolveWorkColumnContentInput,
  WorkColumnSurfaceCapability,
  WorkColumnSurfaceChrome,
  DocumentSurfaceIdentity,
} from './types';
import type { SurfacePresentationUpdate, WorkspaceSurfaceKind } from '@features/workspace/public/surface-api';

export interface WorkColumnDocumentHeaderPresentation {
  externalFilePath: string | null;
}

export type WorkColumnHeaderPresentation =
  | {
      kind: 'document';
      document: WorkColumnDocumentHeaderPresentation;
    }
  | {
      kind: 'agent';
      instanceId: string;
    };

export interface WorkColumnPresentation {
  header: WorkColumnHeaderPresentation;
  chrome: WorkColumnSurfaceChrome;
  /** The initially resolved content kind; runtime renderers may replace it after mode detection. */
  contentKind: WorkspaceSurfaceKind | null;
  capabilities: readonly WorkColumnSurfaceCapability[];
  content: WorkColumnContentPresentation;
}

/** Resolve runtime overrides and document actions at the host boundary. */
export function resolveWorkColumnRuntimePresentation(
  initial: WorkColumnPresentation,
  runtime: Readonly<SurfacePresentationUpdate>,
  identity: DocumentSurfaceIdentity | null | undefined,
): WorkColumnPresentation {
  const header = resolveWorkspaceHeaderModel({
    chrome: initial.chrome, contentKind: initial.contentKind,
    capabilities: initial.capabilities, runtime,
    indexable: initial.content.status === 'surface' && initial.content.surface.kind === 'md' && identity?.indexable === true,
  });
  return { ...initial, contentKind: header.contentKind, chrome: header.chrome, capabilities: header.capabilities };
}

function documentHeaderPresentation(
  surface: Extract<WorkColumnContentPresentation, { status: 'surface' }>['surface'],
): WorkColumnDocumentHeaderPresentation {
  switch (surface.kind) {
    case 'code':
    case 'md':
    case 'html-file':
      return { externalFilePath: surface.fileIdentity.path };
    case 'image-file':
    case 'video-file':
    case 'table-file':
    case 'media-library-file':
    case 'work-documents-file':
    case 'unavailable-file':
      return { externalFilePath: surface.fileIdentity.path };
    default:
      return { externalFilePath: null };
  }
}

/** Derive all host-facing presentation data from one resolved Work Column content. */
export function resolveWorkColumnPresentation(
  input: ResolveWorkColumnContentInput,
): WorkColumnPresentation {
  const content = resolveWorkColumnContent(input);
  const definition = content.status === 'surface'
    ? getWorkColumnSurfaceDefinition(content.surface)
    : null;

  const header: WorkColumnHeaderPresentation = content.status === 'surface'
    && definition?.chrome === 'agent'
    ? content.surface.kind === 'agent-conversation'
      ? { kind: 'agent', instanceId: content.surface.instanceId }
      : (() => {
          throw new Error(`Agent chrome is incompatible with '${content.surface.kind}' surface`);
        })()
    : {
        kind: 'document',
        document: content.status === 'surface'
          ? documentHeaderPresentation(content.surface)
          : { externalFilePath: null },
      };

  return {
    header,
    chrome: definition?.chrome ?? 'document',
    contentKind: definition?.contentKind ?? null,
    capabilities: definition?.capabilities ?? [],
    content,
  };
}
