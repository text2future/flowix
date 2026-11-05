import type { WorkspaceSurfaceIdentity } from './surface-identity';

export type { WorkspaceColumnId } from './workspace-session';
import type { WorkspaceColumnId } from './workspace-session';

export type WorkspaceSurfaceCapability =
  | 'edit' | 'search' | 'memo-colors' | 'properties' | 'copy-content'
  | 'export-content' | 'save-template' | 'version-history' | 'fit' | 'zoom'
  | 'fullscreen' | 'open-source' | 'run-agent' | 'stream-conversation'
  | 'web-navigation';

export type WorkspaceFileSurfaceKind =
  | 'markdown' | 'code' | 'csv' | 'image' | 'video' | 'table'
  | 'media-library' | 'work-documents' | 'html' | 'docx' | 'unavailable';

/** Canonical surface kinds shared by the Work and Browser hosts. */
export type WorkspaceSurfaceKind =
  | `file-${WorkspaceFileSurfaceKind}`
  | 'file-browser' | 'media' | 'mindmap' | 'plugin-artifact' | 'agent-conversation' | 'web'
  | 'plugin-workbench' | 'collection';


/** Appearance dimensions are independent: header styling never determines state or loading presentation. */
export type SurfaceHeaderStyle = 'document' | 'agent' | 'media';
export type SurfaceBackground = 'document' | 'agent' | 'media';
export interface SurfaceAppearance {
  headerStyle: SurfaceHeaderStyle;
  contentBackground: SurfaceBackground;
  stateBackground: SurfaceBackground;
  emptyDecoration: 'document-artwork' | 'none';
}

export interface SurfaceMessage {
  key: string;
  params?: Record<string, string | number>;
  /** Optional domain detail shown alongside the translated message key. */
  fallbackText?: string;
}
export interface SurfaceAction {
  id: string;
  label: SurfaceMessage;
  enabled: boolean;
  run: () => void | Promise<void>;
}
export interface SurfaceNotice {
  id: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  message: SurfaceMessage;
  actions?: readonly SurfaceAction[];
}
export type SurfaceEmptyReason = 'no-target' | 'stale-context' | 'invalid-target' | 'invalid-artifact' | 'no-content';
/** `blocking` shows the surface loader; `background` keeps the renderer mounted and delegates progress to it. */
export type SurfaceState =
  | { status: 'loading'; loadingMode: 'blocking'; retainContent: boolean }
  | { status: 'loading'; loadingMode: 'background'; retainContent: true }
  | { status: 'empty'; reason: SurfaceEmptyReason; message: SurfaceMessage; actions?: readonly SurfaceAction[] }
  | { status: 'ready'; notices?: readonly SurfaceNotice[] }
  | { status: 'unavailable'; reason: 'missing' | 'forbidden' | 'unsupported' | 'stale-context'; message: SurfaceMessage; actions?: readonly SurfaceAction[] }
  | { status: 'error'; message: SurfaceMessage; detailText?: string; actions?: readonly SurfaceAction[] };

/** A content identity may have independent Work and Browser view instances. */
export interface SurfaceViewContext {
  host: WorkspaceColumnId;
  viewId: string;
  focused: boolean;
  readOnly: boolean;
  initialFocus?: 'title' | 'body';
}
export interface SurfaceLifecycle {
  status: 'ready';
  flush?: (options?: { silent?: boolean }) => Promise<boolean>;
  discard?: () => void;
  focus?: (target?: 'title' | 'body') => boolean | void;
  dispose?: () => void;
}
export interface SurfacePresentation {
  title: string;
  icon?: string;
  /** Optional solid color beneath the host's existing titlebar gradient. */
  headerBackgroundColor?: string | null;
  appearance: SurfaceAppearance;
  /** Content currently shown, which can differ from the source file in preview modes. */
  contentKind: WorkspaceSurfaceKind;
  capabilities: readonly WorkspaceSurfaceCapability[];
  actions: readonly SurfaceAction[];
  state: SurfaceState;
}
/** Runtime values a renderer may publish after async resolution or mode changes. */
export type SurfacePresentationUpdate = Partial<Pick<SurfacePresentation,
  'title' | 'icon' | 'headerBackgroundColor' | 'appearance' | 'contentKind' | 'capabilities' | 'actions' | 'state'>>;
export interface ResolvedSurface<K extends WorkspaceSurfaceKind, D> {
  kind: K;
  identity: WorkspaceSurfaceIdentity;
  data: D;
}

/** Per-view web navigation state; it is never part of content identity. */
export interface WorkspaceWebRuntime {
  currentUrl: string;
  history: string[];
  historyIndex: number;
  reloadToken: number;
  isLoading: boolean;
  error: string | null;
}
