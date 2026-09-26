import type { MemoItem } from '@/types/memo-item';
import { getWorkColumnSurfaceDefinition } from './registry';
import { resolveWorkColumnContent } from './resolver';
import type {
  WorkColumnContentPresentation,
  ResolveWorkColumnContentInput,
  WorkColumnSurfaceCapability,
  WorkColumnSurfaceChrome,
} from './types';

export interface WorkColumnDocumentHeaderPresentation {
  currentMemo: MemoItem | null;
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
  input: ResolveWorkColumnContentInput,
): WorkColumnDocumentHeaderPresentation {
  if (surface.kind === 'note') {
    return {
      currentMemo: input.document?.memo ?? null,
      externalFilePath: null,
    };
  }

  switch (surface.kind) {
    case 'code':
    case 'md':
    case 'html-file':
      return { currentMemo: null, externalFilePath: surface.props.filePath };
    case 'image-file':
    case 'video-file':
    case 'unavailable-file':
      return { currentMemo: null, externalFilePath: surface.filePath };
    default:
      return { currentMemo: null, externalFilePath: null };
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
          ? documentHeaderPresentation(content.surface, input)
          : { currentMemo: null, externalFilePath: null },
      };

  return {
    header,
    chrome: definition?.chrome ?? 'document',
    capabilities: definition?.capabilities ?? [],
    content,
  };
}
