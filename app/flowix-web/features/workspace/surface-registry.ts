import { externalFileViewKind } from '@features/editor/public/code-file';

import type {
  WorkspaceSurfaceHost, WorkspaceSurfaceCapability, WorkspaceFileSurfaceKind, WorkspaceSurfaceKind,
  SurfaceAppearance,
} from './model/surface-contract';
export type {
  WorkspaceSurfaceHost, WorkspaceSurfaceCapability, WorkspaceFileSurfaceKind, WorkspaceSurfaceKind,
} from './model/surface-contract';

type SurfaceRegistration = {
  /** Stable implementation ID; the UI layer supplies its lazy component. */
  rendererId: string;
  hosts: readonly WorkspaceSurfaceHost[];
  capabilities: readonly WorkspaceSurfaceCapability[];
  appearance: SurfaceAppearance;
};

const DOCUMENT_APPEARANCE = Object.freeze({
  headerStyle: 'document', contentBackground: 'document', stateBackground: 'document',
  emptyDecoration: 'document-artwork',
} as const satisfies SurfaceAppearance);
const AGENT_APPEARANCE = Object.freeze({
  headerStyle: 'agent', contentBackground: 'agent', stateBackground: 'agent',
  emptyDecoration: 'document-artwork',
} as const satisfies SurfaceAppearance);
const MEDIA_APPEARANCE = Object.freeze({
  headerStyle: 'media', contentBackground: 'media', stateBackground: 'media',
  emptyDecoration: 'none',
} as const satisfies SurfaceAppearance);
const FILE_MEDIA_APPEARANCE = Object.freeze({
  ...MEDIA_APPEARANCE, headerStyle: 'document',
} as const satisfies SurfaceAppearance);

/**
 * The single support declaration for surfaces rendered in workspace hosts.
 * Both hosts consume common renderer registrations. The React-free metadata
 * is also used by navigation to reject unsupported hosts before mounting UI.
 */
export const workspaceSurfaceRegistry = Object.freeze({
  'file-markdown': { rendererId: 'file-markdown', hosts: ['main-third', 'browser-column'], capabilities: ['edit', 'search', 'copy-content', 'export-content', 'save-template'], appearance: DOCUMENT_APPEARANCE },
  'file-code': { rendererId: 'file-code', hosts: ['main-third', 'browser-column'], capabilities: ['edit', 'search', 'copy-content'], appearance: DOCUMENT_APPEARANCE },
  'file-csv': { rendererId: 'file-csv', hosts: ['main-third', 'browser-column'], capabilities: [], appearance: DOCUMENT_APPEARANCE },
  'file-image': { rendererId: 'file-image', hosts: ['main-third', 'browser-column'], capabilities: ['fullscreen', 'zoom'], appearance: FILE_MEDIA_APPEARANCE },
  'file-video': { rendererId: 'file-video', hosts: ['main-third', 'browser-column'], capabilities: ['fullscreen'], appearance: FILE_MEDIA_APPEARANCE },
  'file-table': { rendererId: 'file-table', hosts: ['main-third', 'browser-column'], capabilities: [], appearance: DOCUMENT_APPEARANCE },
  'file-media-library': { rendererId: 'file-media-library', hosts: ['main-third', 'browser-column'], capabilities: [], appearance: DOCUMENT_APPEARANCE },
  'file-work-documents': { rendererId: 'file-work-documents', hosts: ['main-third', 'browser-column'], capabilities: [], appearance: DOCUMENT_APPEARANCE },
  'file-html': { rendererId: 'file-html', hosts: ['main-third', 'browser-column'], capabilities: [], appearance: DOCUMENT_APPEARANCE },
  'file-docx': { rendererId: 'file-docx', hosts: ['main-third', 'browser-column'], capabilities: [], appearance: DOCUMENT_APPEARANCE },
  'file-unavailable': { rendererId: 'file-unavailable', hosts: ['main-third', 'browser-column'], capabilities: [], appearance: DOCUMENT_APPEARANCE },
  'file-browser': { rendererId: 'file-browser', hosts: ['browser-column'], capabilities: [], appearance: DOCUMENT_APPEARANCE },
  collection: { rendererId: 'collection', hosts: ['main-third', 'browser-column'], capabilities: [], appearance: DOCUMENT_APPEARANCE },
  media: { rendererId: 'media', hosts: ['main-third', 'browser-column'], capabilities: ['fullscreen'], appearance: MEDIA_APPEARANCE },
  mindmap: { rendererId: 'plugin-document', hosts: ['main-third'], capabilities: ['fullscreen', 'fit', 'zoom'], appearance: DOCUMENT_APPEARANCE },
  'plugin-artifact': { rendererId: 'plugin-document', hosts: ['main-third'], capabilities: ['fullscreen'], appearance: DOCUMENT_APPEARANCE },
  'agent-conversation': { rendererId: 'agent-conversation', hosts: ['main-third', 'browser-column'], capabilities: ['stream-conversation'], appearance: AGENT_APPEARANCE },
  web: { rendererId: 'web', hosts: ['main-third', 'browser-column'], capabilities: ['web-navigation'], appearance: DOCUMENT_APPEARANCE },
  'plugin-workbench': { rendererId: 'plugin-workbench', hosts: ['main-third'], capabilities: ['run-agent', 'fullscreen'], appearance: DOCUMENT_APPEARANCE },
} as const satisfies Record<WorkspaceSurfaceKind, SurfaceRegistration>);

export function workspaceSurfaceSupportsHost(
  kind: WorkspaceSurfaceKind,
  host: WorkspaceSurfaceHost,
): boolean {
  const hosts: readonly WorkspaceSurfaceHost[] = workspaceSurfaceRegistry[kind].hosts;
  return hosts.includes(host);
}

export function workspaceSurfaceCapabilities(kind: WorkspaceSurfaceKind): readonly WorkspaceSurfaceCapability[] {
  return workspaceSurfaceRegistry[kind].capabilities;
}

export function workspaceFileSurfaceKind(kind: WorkspaceFileSurfaceKind): `file-${WorkspaceFileSurfaceKind}` {
  return `file-${kind}`;
}

export function workspaceFileSurfaceSupportsHost(
  kind: WorkspaceFileSurfaceKind,
  host: WorkspaceSurfaceHost,
): boolean {
  return workspaceSurfaceSupportsHost(workspaceFileSurfaceKind(kind), host);
}

/** Resolve a local file to the same canonical surface kind for either host. */
export function resolveWorkspaceFileSurfaceKind(
  path: string,
  mimeType?: string | null,
  detectedTextContent = false,
): WorkspaceFileSurfaceKind {
  if (/\.lib\.ya?ml$/i.test(path)) return 'media-library';
  if (/\.workdocs\.ya?ml$/i.test(path)) return 'work-documents';
  if (/\.table\.ya?ml$/i.test(path)) return 'table';
  switch (externalFileViewKind(path, mimeType, detectedTextContent)) {
    case 'markdown': return 'markdown';
    case 'code': return 'code';
    case 'csv': return 'csv';
    case 'image': return 'image';
    case 'video': return 'video';
    case 'html': return 'html';
    case 'docx': return 'docx';
    case 'unavailable': return 'unavailable';
  }
}

/** Shared defaults; dynamic view modes may refine them in the surface presentation. */
export function workspaceSurfaceAppearance(kind: WorkspaceSurfaceKind): Readonly<SurfaceAppearance> {
  return workspaceSurfaceRegistry[kind].appearance;
}

/** Publish a content-mode change as one consistent presentation update. */
export function workspaceSurfaceContentPresentation(kind: WorkspaceSurfaceKind) {
  return {
    contentKind: kind,
    appearance: workspaceSurfaceAppearance(kind),
    capabilities: workspaceSurfaceCapabilities(kind),
  };
}

/** Collection chrome applies to folders and every collection file domain. */
export function workspaceSurfaceUsesCollectionFrame(kind: WorkspaceSurfaceKind | null): boolean {
  return kind === 'collection' || kind === 'file-table'
    || kind === 'file-media-library' || kind === 'file-work-documents';
}
