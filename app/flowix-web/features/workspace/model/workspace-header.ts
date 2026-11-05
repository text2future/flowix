import type { SurfaceHeaderStyle, SurfacePresentationUpdate, WorkspaceSurfaceCapability, WorkspaceSurfaceKind } from './surface-contract';

const NOTE_CAPABILITIES = ['memo-colors', 'properties', 'version-history'] as const;

export interface WorkspaceHeaderInput {
  chrome?: SurfaceHeaderStyle;
  contentKind?: WorkspaceSurfaceKind | null;
  sourceKind?: WorkspaceSurfaceKind | null;
  capabilities?: readonly WorkspaceSurfaceCapability[];
  runtime?: Readonly<SurfacePresentationUpdate>;
  /** Keep provisional identity hidden until domain hydration completes. */
  identity?: { title?: string | null; icon?: string | null; ready?: boolean };
  indexable?: boolean;
  collection?: boolean;
  fullscreen?: boolean;
  collectionScrolled?: boolean;
  backgroundColor?: string | null;
}

/** Shared policy; hosts supply navigation and domain components as slots. */
export function resolveWorkspaceHeaderModel(input: WorkspaceHeaderInput) {
  const contentKind = input.runtime?.contentKind ?? input.contentKind ?? null;
  const rendererCapabilities = input.runtime?.capabilities ?? input.capabilities ?? [];
  const capabilities: readonly WorkspaceSurfaceCapability[] = input.indexable && contentKind === 'file-markdown'
    ? [...new Set([...rendererCapabilities, ...NOTE_CAPABILITIES])]
    : rendererCapabilities;
  const chrome = input.fullscreen ? 'agent' : input.runtime?.appearance?.headerStyle ?? input.chrome ?? 'document';
  const showSurfaceActions = !input.fullscreen;
  const sourceKind = input.sourceKind ?? contentKind;
  const identity = showSurfaceActions && !input.collection && input.identity?.ready !== false
    && (input.identity?.title || input.identity?.icon)
    ? { title: input.identity.title, icon: input.identity.icon }
    : null;
  return {
    contentKind,
    sourceKind,
    chrome,
    capabilities,
    backgroundColor: chrome === 'agent' || chrome === 'media'
      ? 'var(--agent-bg, var(--document-bg))'
      : input.collection && input.collectionScrolled ? 'var(--document-bg)'
        : input.runtime?.headerBackgroundColor ?? input.backgroundColor ?? undefined,
    gradient: chrome !== 'media',
    identity,
    showIdentity: identity !== null,
    showSurfaceActions,
    showWebAddressBar: showSurfaceActions && capabilities.includes('web-navigation'),
    documentControls: {
      copyFullText: showSurfaceActions && capabilities.includes('copy-content'),
      memoColors: showSurfaceActions && capabilities.includes('memo-colors'),
      exportContent: showSurfaceActions && capabilities.includes('export-content'),
      saveAsTemplate: showSurfaceActions && capabilities.includes('save-template'),
      versionHistory: showSurfaceActions && capabilities.includes('version-history'),
    },
    showEditorFontSwitcher: showSurfaceActions && sourceKind === 'file-markdown' && capabilities.includes('edit'),
    showEditorModeToggle: showSurfaceActions && (sourceKind === 'file-markdown' || sourceKind === 'file-html'),
  };
}

export type WorkspaceHeaderModel = ReturnType<typeof resolveWorkspaceHeaderModel>;
