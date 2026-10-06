import { getWorkColumnSurfaceDefinition } from './registry';
import { resolveWorkColumnContent } from './resolver';
import type {
  WorkColumnContentPresentation,
  ResolveWorkColumnContentInput,
  WorkColumnSurfaceCapability,
  WorkColumnSurfaceChrome,
} from './types';

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
  capabilities: readonly WorkColumnSurfaceCapability[];
  content: WorkColumnContentPresentation;
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
    capabilities: content.status === 'surface' && content.surface.kind === 'md'
      && input.document?.identity.kind === 'external' && input.document.identity.indexable
      ? [...(definition?.capabilities ?? []), 'memo-colors', 'properties', 'version-history']
      : definition?.capabilities ?? [],
    content,
  };
}
